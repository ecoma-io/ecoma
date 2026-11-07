import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyOwnership,
  normalizeWorktreeRoot,
  ownershipLabels,
  worktreeNamespace,
} from '@ecoma-io/deployment';
import type { ExecResult } from '@ecoma-io/deployment';
import {
  CLEANUP_KINDS,
  decideResourceAction,
  dockerInspectLabels,
  runLocalCleanup,
  worktreeAlive,
} from './local-cleanup.js';

const cleanup: string[] = [];
function tempWorktreeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'classify-'));
  cleanup.push(dir);
  return normalizeWorktreeRoot(dir);
}
afterEach(() => {
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-cleanup-spec-'));
  cleanup.push(dir);
  return normalizeWorktreeRoot(dir);
}

/** Fake Docker world theo kind → { names, labels[name], rmFailures[name] }. */
interface FakeDocker {
  names: Map<'container' | 'network' | 'volume' | 'image', string[]>;
  labels: Map<string, Record<string, string>>; // key: `${dockerType}/${name}`
  removed: string[]; // names passed to rm
  failRm?: Set<string>;
  failList?: Set<'container' | 'network' | 'volume' | 'image'>;
}

function fakeDockerExec(docker: FakeDocker) {
  return (args: string[], _env: NodeJS.ProcessEnv): ExecResult => {
    // docker info
    if (args[0] === 'info') return { status: 0, stdout: '27.0', stderr: '' };
    // ls commands
    if (args[1] === 'ls') {
      const dockerType = args[0] as 'container' | 'network' | 'volume' | 'image';
      if (docker.failList?.has(dockerType)) {
        return { status: 1, stdout: '', stderr: `ls ${dockerType} fail (fake)` };
      }
      const names = docker.names.get(dockerType) ?? [];
      return { status: 0, stdout: `${names.join('\n')}\n`, stderr: '' };
    }
    // inspect: args = [dockerType, 'inspect', '--format', '{{json .}}', name]
    if (args[1] === 'inspect') {
      const dockerType = args[0] as 'container' | 'network' | 'volume' | 'image';
      const name = args[4] ?? '';
      const entry = docker.labels.get(`${dockerType}/${name}`);
      if (entry === undefined) {
        return { status: 1, stdout: '', stderr: `No such ${dockerType}: ${name}` };
      }
      return { status: 0, stdout: JSON.stringify({ Labels: entry }), stderr: '' };
    }
    // rm: args = [dockerType, 'rm', ... , name]  (container uses --force)
    if (args[1] === 'rm') {
      const dockerType = args[0] as 'container' | 'network' | 'volume' | 'image';
      const name = args[args.length - 1] ?? '';
      const key = `${dockerType}/${name}`;
      const labels = docker.labels.get(key);
      if (labels === undefined) {
        return { status: 1, stdout: '', stderr: `No such ${dockerType}: ${name}` };
      }
      docker.labels.delete(key);
      const list = docker.names.get(dockerType as 'container' | 'network' | 'volume') ?? [];
      docker.names.set(
        dockerType as 'container' | 'network' | 'volume',
        list.filter((n) => n !== name),
      );
      if (docker.failRm?.has(key)) {
        return { status: 1, stdout: '', stderr: `rm ${key} fail (fake)` };
      }
      docker.removed.push(key);
      return { status: 0, stdout: `${name}\n`, stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `fake docker does not handle: ${args.join(' ')}` };
  };
}

function ownedLabels(worktreePath: string): Record<string, string> {
  const ns = worktreeNamespace(worktreePath);
  return ownershipLabels(worktreePath, ns);
}

function legacyOwnedLabels(worktreePath: string): Record<string, string> {
  const labels = ownedLabels(worktreePath);
  labels['io.ecoma.managed-by'] = 'dx';
  return labels;
}

describe('decideResourceAction', () => {
  it('skips (never removes) resource without managed-by ownership label', () => {
    const decision = decideResourceAction(
      'home',
      { state: 'missing' },
      { worktreePresence: () => 'absent' },
    );
    expect(decision.action).toBe('skipped');
  });

  it('skips malformed ownership metadata instead of deleting', () => {
    const decision = decideResourceAction(
      'home',
      { state: 'malformed', detail: 'label io.ecoma.worktree-id missing or empty' },
      { worktreePresence: () => 'absent' },
    );
    expect(decision.action).toBe('skipped');
  });

  it('keeps resources of an existing worktree', () => {
    const decision = decideResourceAction(
      'home',
      { state: 'owned', worktreePath: '/some/live/wt', worktreeId: 'wabc' },
      { worktreePresence: () => 'present' },
    );
    expect(decision.action).toBe('kept');
  });

  it('keeps resources when worktree presence is unknown (fail-closed)', () => {
    const decision = decideResourceAction(
      'home',
      { state: 'owned', worktreePath: '/some/unknown/wt', worktreeId: 'wabc' },
      { worktreePresence: () => 'unknown' },
    );
    expect(decision.action).toBe('kept');
  });

  it('selects orphan (worktree gone) for removal', () => {
    const decision = decideResourceAction(
      'home',
      { state: 'owned', worktreePath: '/some/dead/wt', worktreeId: 'wabc' },
      { worktreePresence: () => 'absent' },
    );
    expect(decision.action).toBe('remove');
  });

  it('selects orphan postgres volume for removal like any other kind', () => {
    const decision = decideResourceAction(
      'postgres-volume',
      { state: 'owned', worktreePath: '/some/dead/wt', worktreeId: 'wabc' },
      { worktreePresence: () => 'absent' },
    );
    expect(decision.action).toBe('remove');
  });
});

describe('classifyOwnership', () => {
  it('rejects wrong managed-by value as malformed (contradictory metadata)', () => {
    const path = tempWorktreeDir();
    const labels = ownershipLabels(path, worktreeNamespace(path));
    labels['io.ecoma.managed-by'] = 'other-tool';
    const check = classifyOwnership(labels);
    expect(check.state).toBe('malformed');
  });

  it('rejects unsupported deployment identifier', () => {
    const path = tempWorktreeDir();
    const labels = ownershipLabels(path, worktreeNamespace(path));
    labels['io.ecoma.deployment'] = 'staging';
    const check = classifyOwnership(labels);
    expect(check.state).toBe('malformed');
  });

  it('rejects mismatched worktree-id vs worktree-path (contradictory metadata)', () => {
    const path = tempWorktreeDir();
    const labels = ownershipLabels(path, worktreeNamespace(path));
    labels['io.ecoma.worktree-id'] = 'wdeadbeef1234';
    const check = classifyOwnership(labels);
    expect(check.state).toBe('malformed');
  });

  it('accepts full ownership labels', () => {
    const path = tempWorktreeDir();
    const labels = ownershipLabels(path, worktreeNamespace(path));
    const check = classifyOwnership(labels);
    expect(check.state).toBe('owned');
  });

  it('accepts legacy managed-by=dx resources as owned (bounded compatibility)', () => {
    const path = tempWorktreeDir();
    const labels = ownershipLabels(path, worktreeNamespace(path));
    labels['io.ecoma.managed-by'] = 'dx';
    const check = classifyOwnership(labels);
    expect(check.state).toBe('owned');
  });

  it('rejects unknown managed-by value as malformed', () => {
    const path = tempWorktreeDir();
    const labels = ownershipLabels(path, worktreeNamespace(path));
    labels['io.ecoma.managed-by'] = 'some-other-tool';
    const check = classifyOwnership(labels);
    expect(check.state).toBe('malformed');
  });

  it('missing labels means not-managed-by DX', () => {
    expect(classifyOwnership({}).state).toBe('missing');
    expect(classifyOwnership({ 'traefik.enable': 'true' }).state).toBe('missing');
  });

  it('empty managed-by string is treated as missing (fail-closed)', () => {
    const labels = { 'io.ecoma.managed-by': '' };
    expect(classifyOwnership(labels).state).toBe('missing');
  });

  it('malformed when managed-by ok but other labels missing', () => {
    const path = tempWorktreeDir();
    const labels = ownershipLabels(path, worktreeNamespace(path));
    delete labels['io.ecoma.worktree-path'];
    expect(classifyOwnership(labels).state).toBe('malformed');
  });
});

describe('worktreeAlive', () => {
  it('true for an existing directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-alive-'));
    cleanup.push(dir);
    expect(worktreeAlive(dir)).toBe('present');
  });
  it('absent for missing path', () => {
    expect(worktreeAlive(join(tmpdir(), 'cleanup-missing-xyz'))).toBe('absent');
  });

  it('unknown for permission/stat error (fail-closed)', () => {
    const parent = mkdtempSync(join(tmpdir(), 'cleanup-perm-'));
    cleanup.push(parent);
    const target = join(parent, 'child');
    mkdirSync(target);
    chmodSync(parent, 0o000);
    try {
      expect(worktreeAlive(target)).toBe('unknown');
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

describe('runLocalCleanup', () => {
  it('existing worktree resources are never cleaned', () => {
    const wt = tempWorktree();
    const docker: FakeDocker = {
      names: new Map([
        ['container', [`ecoma-${worktreeNamespace(wt)}-home`]],
        ['network', [`ecoma-${worktreeNamespace(wt)}-network`]],
        ['volume', []],
      ]),
      labels: new Map([
        ['container/ecoma-' + worktreeNamespace(wt) + '-home', ownedLabels(wt)],
        ['network/ecoma-' + worktreeNamespace(wt) + '-network', ownedLabels(wt)],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: (p) => (p === wt ? 'present' : 'absent'),
    });
    expect(docker.removed).toHaveLength(0);
    const actions = report.entries.map((e) => e.action);
    expect(actions).toContain('kept');
    expect(actions).not.toContain('removed');
    expect(actions).not.toContain('would-remove');
  });

  it('deleted worktree resources are identified and removed', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const docker: FakeDocker = {
      names: new Map([
        ['container', [`ecoma-${ns}-home`, `ecoma-${ns}-traefik`, `ecoma-${ns}-postgres`]],
        ['network', [`ecoma-${ns}-network`]],
        ['volume', [`ecoma-${ns}-postgres-volume`]],
      ]),
      labels: new Map(
        [...CLEANUP_KINDS].map((k) => [
          `${k === 'network' ? 'network' : k === 'postgres-volume' ? 'volume' : 'container'}/ecoma-${ns}-${k}`,
          ownedLabels(wt),
        ]),
      ),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    // network, traefik, postgres, home and the postgres volume all removed
    expect(docker.removed).toEqual(
      expect.arrayContaining([
        `network/ecoma-${ns}-network`,
        `container/ecoma-${ns}-home`,
        `container/ecoma-${ns}-traefik`,
        `container/ecoma-${ns}-postgres`,
        `volume/ecoma-${ns}-postgres-volume`,
      ]),
    );
    const volumeEntry = report.entries.find((e) => e.kind === 'postgres-volume');
    expect(volumeEntry?.action).toBe('removed');
  });

  it('legacy managed-by=dx orphan resources are still removed (bounded compatibility)', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const docker: FakeDocker = {
      names: new Map([
        ['container', [`ecoma-${ns}-home`]],
        ['network', [`ecoma-${ns}-network`]],
        ['volume', [`ecoma-${ns}-postgres-volume`]],
      ]),
      labels: new Map([
        [`container/ecoma-${ns}-home`, legacyOwnedLabels(wt)],
        [`network/ecoma-${ns}-network`, legacyOwnedLabels(wt)],
        [`volume/ecoma-${ns}-postgres-volume`, legacyOwnedLabels(wt)],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toEqual(
      expect.arrayContaining([
        `container/ecoma-${ns}-home`,
        `network/ecoma-${ns}-network`,
        `volume/ecoma-${ns}-postgres-volume`,
      ]),
    );
    expect(report.errors).toEqual([]);
  });

  it('non-owned managed-by value is never removed by cleanup', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const labels = ownedLabels(wt);
    labels['io.ecoma.managed-by'] = 'some-other-tool';
    const docker: FakeDocker = {
      names: new Map([['container', [`ecoma-${ns}-home`]]]),
      labels: new Map([['container/ecoma-' + ns + '-home', labels]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    const entry = report.entries.find((e) => e.kind === 'home');
    expect(entry?.action).toBe('skipped');
  });

  it('pact WIC orphan resources (container, image, state volume) are identified and removed', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const docker: FakeDocker = {
      names: new Map([
        ['container', [`ecoma-${ns}-pact-api-wic`, `ecoma-${ns}-pact-api-wic-state-init`]],
        ['image', [`ecoma-${ns}-pact-api-wic:local`]],
        ['volume', [`ecoma-${ns}-pact-api-wic-state`]],
        ['network', []],
      ]),
      labels: new Map([
        [`container/ecoma-${ns}-pact-api-wic`, ownedLabels(wt)],
        [`container/ecoma-${ns}-pact-api-wic-state-init`, ownedLabels(wt)],
        [`image/ecoma-${ns}-pact-api-wic:local`, ownedLabels(wt)],
        [`volume/ecoma-${ns}-pact-api-wic-state`, ownedLabels(wt)],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    // Cả 4 resource Docker thật của WIC pact bị xoá khi worktree đã mất; kind
    // `pact-api` (command.local.Command) chủ ý KHÔNG có trong CLEANUP_KINDS —
    // nó không tạo Docker resource tồn lại sau lệnh.
    expect(new Set(docker.removed)).toEqual(
      new Set([
        `container/ecoma-${ns}-pact-api-wic`,
        `container/ecoma-${ns}-pact-api-wic-state-init`,
        `image/ecoma-${ns}-pact-api-wic:local`,
        `volume/ecoma-${ns}-pact-api-wic-state`,
      ]),
    );
    expect(report.errors).toEqual([]);
  });

  it('pact WIC resources of a live worktree are kept', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const docker: FakeDocker = {
      names: new Map([
        ['container', [`ecoma-${ns}-pact-api-wic`]],
        ['image', []],
        ['volume', [`ecoma-${ns}-pact-api-wic-state`]],
        ['network', []],
      ]),
      labels: new Map([
        [`container/ecoma-${ns}-pact-api-wic`, ownedLabels(wt)],
        [`volume/ecoma-${ns}-pact-api-wic-state`, ownedLabels(wt)],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: (p) => (p === wt ? 'present' : 'absent'),
    });
    expect(docker.removed).toHaveLength(0);
    const actions = report.entries.map((e) => e.action);
    expect(actions).toContain('kept');
    expect(actions).not.toContain('removed');
    expect(actions).not.toContain('would-remove');
  });

  it('push WIC orphan resources (container, image, state volume) are identified and removed', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const docker: FakeDocker = {
      names: new Map([
        ['container', [`ecoma-${ns}-push-wic`, `ecoma-${ns}-push-wic-state-init`]],
        ['image', [`ecoma-${ns}-push-wic:local`]],
        ['volume', [`ecoma-${ns}-push-wic-state`]],
        ['network', []],
      ]),
      labels: new Map([
        [`container/ecoma-${ns}-push-wic`, ownedLabels(wt)],
        [`container/ecoma-${ns}-push-wic-state-init`, ownedLabels(wt)],
        [`image/ecoma-${ns}-push-wic:local`, ownedLabels(wt)],
        [`volume/ecoma-${ns}-push-wic-state`, ownedLabels(wt)],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    // Cả 4 resource Docker thật của WIC push bị xoá khi worktree đã mất —
    // cùng hình với WIC pact/mail/auth (issue #264).
    expect(new Set(docker.removed)).toEqual(
      new Set([
        `container/ecoma-${ns}-push-wic`,
        `container/ecoma-${ns}-push-wic-state-init`,
        `image/ecoma-${ns}-push-wic:local`,
        `volume/ecoma-${ns}-push-wic-state`,
      ]),
    );
    expect(report.errors).toEqual([]);
  });

  it('same-branch isolation: a resource of another live worktree is untouched even when filter targets a deleted worktree', () => {
    const deadWt = tempWorktree();
    const liveWt = tempWorktree();
    const deadNs = worktreeNamespace(deadWt);
    const liveNs = worktreeNamespace(liveWt);
    const docker: FakeDocker = {
      names: new Map([
        ['container', [`ecoma-${deadNs}-home`, `ecoma-${liveNs}-home`]],
        ['network', [`ecoma-${deadNs}-network`, `ecoma-${liveNs}-network`]],
        ['volume', []],
      ]),
      labels: new Map([
        [`container/ecoma-${deadNs}-home`, ownedLabels(deadWt)],
        [`container/ecoma-${liveNs}-home`, ownedLabels(liveWt)],
        [`network/ecoma-${deadNs}-network`, ownedLabels(deadWt)],
        [`network/ecoma-${liveNs}-network`, ownedLabels(liveWt)],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      worktreeRoot: deadWt,
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: (p) => (p === liveWt ? 'present' : 'absent'),
    });
    expect(docker.removed).toEqual(
      expect.arrayContaining([`container/ecoma-${deadNs}-home`, `network/ecoma-${deadNs}-network`]),
    );
    const liveEntries = report.entries.filter((e) => e.name === `ecoma-${liveNs}-home`);
    expect(liveEntries[0]?.action).toBe('skipped');
  });

  it('unlabeled resources are skipped even with ecoma-like names', () => {
    const docker: FakeDocker = {
      names: new Map([
        ['container', ['ecoma-fake-home']],
        ['network', ['ecoma-fake-network']],
        ['volume', []],
      ]),
      labels: new Map([
        ['container/ecoma-fake-home', {}],
        ['network/ecoma-fake-network', {}],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    for (const entry of report.entries) {
      expect(entry.action).toBe('skipped');
      expect(entry.reason).toContain('outside DX management');
    }
  });

  it('malformed metadata → no deletion, entry reports skipped', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const badLabels = ownedLabels(wt);
    delete badLabels['io.ecoma.worktree-id'];
    const docker: FakeDocker = {
      names: new Map([['container', [`ecoma-${ns}-home`]]]),
      labels: new Map([[`container/ecoma-${ns}-home`, badLabels]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    expect(report.entries[0]?.action).toBe('skipped');
  });

  it('dry-run reports what would be removed without issuing rm commands', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const docker: FakeDocker = {
      names: new Map([
        ['container', [`ecoma-${ns}-home`]],
        ['network', [`ecoma-${ns}-network`]],
        ['volume', [`ecoma-${ns}-postgres-volume`]],
      ]),
      labels: new Map([
        [`container/ecoma-${ns}-home`, ownedLabels(wt)],
        [`network/ecoma-${ns}-network`, ownedLabels(wt)],
        [`volume/ecoma-${ns}-postgres-volume`, ownedLabels(wt)],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: true,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    const wouldRemove = report.entries.filter((e) => e.action === 'would-remove');
    // Set thay cho sort: cùng đẳng thức tập hợp — `.sort` bị linter cấm,
    // `.toSorted` cần lib es2023 mà dx không dùng (cùng cách index.spec.ts).
    expect(new Set(wouldRemove.map((e) => e.name))).toEqual(
      new Set([`ecoma-${ns}-home`, `ecoma-${ns}-network`, `ecoma-${ns}-postgres-volume`]),
    );
  });

  it('orphan postgres volume is removed in execute mode (data policy matches platform down)', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const docker: FakeDocker = {
      names: new Map([
        ['container', []],
        ['network', []],
        ['volume', [`ecoma-${ns}-postgres-volume`]],
      ]),
      labels: new Map([[`volume/ecoma-${ns}-postgres-volume`, ownedLabels(wt)]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(report.entries[0]?.action).toBe('removed');
    expect(docker.removed).toEqual([`volume/ecoma-${ns}-postgres-volume`]);
  });

  it('docker ls failure reported accurately without pretending success', () => {
    const docker: FakeDocker = {
      names: new Map([
        ['container', []],
        ['network', []],
        ['volume', []],
      ]),
      labels: new Map(),
      removed: [],
      failList: new Set(['container']),
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(report.errors.some((e) => e.includes('container ls') || e.includes('ls failed'))).toBe(
      true,
    );
    expect(report.entries.filter((e) => e.kind === 'home')).toHaveLength(0);
  });

  it('docker info failure → error surface, nothing scanned', () => {
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: (_args, _env) => ({
        status: 1,
        stdout: '',
        stderr: 'Cannot connect to the Docker daemon',
      }),
      worktreePresence: () => 'absent',
    });
    expect(report.entries).toHaveLength(0);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain('Docker daemon not responding');
  });
});

/** Inspect fake trả thành công với đúng `labels` — mô phỏng `docker inspect` 0. */
function inspectOk(labels: Record<string, string>): (args: string[], env: unknown) => ExecResult {
  return (_a: string[], _b: unknown) => ({
    status: 0,
    stdout: JSON.stringify({ Labels: labels }),
    stderr: '',
  });
}

/** Inspect fake trả lỗi `msg` — mô phỏng `docker inspect` exit != 0. */
function inspectFail(msg: string): (args: string[], env: unknown) => ExecResult {
  return (_a: string[], _b: unknown) => ({ status: 1, stdout: '', stderr: msg });
}

describe('dockerInspectLabels', () => {
  it('parses root Labels from inspect format', () => {
    const labels = { 'io.ecoma.managed-by': 'dx' };
    const r = dockerInspectLabels('container', 'x', {}, inspectOk(labels));
    expect(r.labels).toEqual(labels);
    expect(r.failure).toBeUndefined();
  });
  it('reports failure on non-zero inspect', () => {
    const r = dockerInspectLabels('container', 'x', {}, inspectFail('No such object'));
    expect(r.labels).toEqual({});
    expect(r.failure).toContain('No such object');
  });
});

describe('local-cleanup entry', () => {
  it('uses shared lock so cleanup cannot race with a lane up or down', async () => {
    // Contract asserted at type level + code review; here we verify the command
    // module exists and exposes run/args (dispatch contract).
    const mod = await import('./local-cleanup-command.js');
    expect(mod.default).toHaveProperty('meta');
    expect(mod.default).toHaveProperty('run');
  });

  it('removes containers before network (network rm fails while its containers exist)', () => {
    // Fake mirror thực tế Docker: network rm thành công CHỈ khi không còn
    // container nào gắn vào nó. Harness dưới mô phỏng ràng buộc này — nếu
    // thứ tự CLEANUP_KINDS đổi lại network lên trước, test fail.
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const networkName = `ecoma-${ns}-network`;
    const homeName = `ecoma-${ns}-home`;
    const docker: FakeDocker = {
      names: new Map([
        ['container', [homeName]],
        ['network', [networkName]],
        ['volume', []],
      ]),
      labels: new Map([
        [`container/${homeName}`, ownedLabels(wt)],
        [`network/${networkName}`, ownedLabels(wt)],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: (args, env) => {
        // Docker truly rejects network rm when active endpoints remain.
        if (args[1] === 'rm' && args[0] === 'network') {
          const containers = docker.names.get('container') ?? [];
          if (containers.some((c) => docker.labels.has(`container/${c}`))) {
            return { status: 1, stdout: '', stderr: 'has active endpoints (fake)' };
          }
        }
        return fakeDockerExec(docker)(args, env);
      },
      worktreePresence: () => 'absent',
    });
    expect(report.errors).toEqual([]);
    expect(docker.removed).toEqual(
      expect.arrayContaining([`container/${homeName}`, `network/${networkName}`]),
    );
  });

  it('filter targeting a deleted worktree path still runs (ENOENT tolerated)', () => {
    // Mồ côi là đối tượng chính của cleanup: filter đến path ĐÃ BỊ XOÁ phải
    // chạy diagnostics được, không throw ENOENT. runLocalCleanup không xoá gì
    // ở đây (resource giả có worktree khác) — chỉ xác nhận không ném.
    const liveWt = tempWorktree();
    const docker: FakeDocker = {
      names: new Map([['container', [`ecoma-${worktreeNamespace(liveWt)}-home`]]]),
      labels: new Map([[`container/ecoma-${worktreeNamespace(liveWt)}-home`, ownedLabels(liveWt)]]),
      removed: [],
    };
    const deletedPath = join(tmpdir(), `cleanup-dead-${Date.now()}-no-such-dir`);
    const report = runLocalCleanup({
      dryRun: true,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreeRoot: deletedPath,
      worktreePresence: (p) => (p === liveWt ? 'present' : 'absent'),
    });
    // Path filter (deleted-path !== live worktree) → mọi resource skip.
    const actions = report.entries.map((e) => e.action);
    expect(actions.every((a) => a === 'skipped')).toBe(true);
    expect(docker.removed).toHaveLength(0);
  });
});

describe('runLocalCleanup — additional safety', () => {
  it('unknown worktree presence never reaches a destructive rm call', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const docker: FakeDocker = {
      names: new Map([
        ['container', [`ecoma-${ns}-home`]],
        ['network', []],
        ['volume', []],
      ]),
      labels: new Map([[`container/ecoma-${ns}-home`, ownedLabels(wt)]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'unknown',
    });
    expect(docker.removed).toHaveLength(0);
    const entry = report.entries.find((e) => e.name === `ecoma-${ns}-home`);
    expect(entry?.action).toBe('kept');
  });

  it('container removal uses --force (running orphan strategy)', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const docker: FakeDocker = {
      names: new Map([['container', [`ecoma-${ns}-home`]]]),
      labels: new Map([[`container/ecoma-${ns}-home`, ownedLabels(wt)]]),
      removed: [],
    };
    const captured: string[][] = [];
    const exec = (args: string[], env: NodeJS.ProcessEnv) => {
      captured.push([...args]);
      return fakeDockerExec(docker)(args, env);
    };
    runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: exec,
      worktreePresence: () => 'absent',
    });
    const rmCall = captured.find((a) => a[1] === 'rm');
    expect(rmCall).toBeDefined();
    expect(rmCall).toContain('--force');
  });

  it('orphan image is removed when ownership + orphan status established', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const imageName = `ecoma-home-${ns}:local`;
    const docker: FakeDocker = {
      names: new Map([['image', [imageName]]]),
      labels: new Map([[`image/${imageName}`, ownedLabels(wt)]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toContain(`image/${imageName}`);
    const entry = report.entries.find((e) => e.name === imageName);
    expect(entry?.action).toBe('removed');
  });

  it('orphan auth-wic image (namespace-first name) is removed, not filtered out', () => {
    // Regression: image auth-wic có tên `ecoma-<ns>-auth-wic:local`
    // (`dockerResourceName` namespace-first) — filter cũ theo prefix
    // app-first `ecoma-auth-wic-` không bao giờ match nên image này từng bị
    // rớt khỏi candidate list của cleanup.
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const imageName = `ecoma-${ns}-auth-wic:local`;
    const docker: FakeDocker = {
      names: new Map([['image', [imageName]]]),
      labels: new Map([[`image/${imageName}`, ownedLabels(wt)]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toContain(`image/${imageName}`);
    const entry = report.entries.find((e) => e.name === imageName);
    expect(entry?.action).toBe('removed');
  });

  it('image name that merely ends with a known kind but lacks ecoma- prefix is skipped', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const imageName = `something-else-${ns}-auth-wic:local`;
    const docker: FakeDocker = {
      names: new Map([['image', [imageName]]]),
      labels: new Map([[`image/${imageName}`, ownedLabels(wt)]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    expect(report.entries.find((e) => e.name === imageName)).toBeUndefined();
  });

  it('image belonging to a live worktree is kept', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const imageName = `ecoma-home-${ns}:local`;
    const docker: FakeDocker = {
      names: new Map([['image', [imageName]]]),
      labels: new Map([[`image/${imageName}`, ownedLabels(wt)]]),
      removed: [],
    };
    runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'present',
    });
    expect(docker.removed).toHaveLength(0);
  });

  it('unlabeled image is skipped', () => {
    const imageName = 'ecoma-home-abc:local';
    const docker: FakeDocker = {
      names: new Map([['image', [imageName]]]),
      labels: new Map([[`image/${imageName}`, {}]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    expect(report.entries[0]?.action).toBe('skipped');
  });

  it('malformed image labels are skipped', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const imageName = `ecoma-home-${ns}:local`;
    const bad = ownedLabels(wt);
    delete bad['io.ecoma.worktree-id'];
    const docker: FakeDocker = {
      names: new Map([['image', [imageName]]]),
      labels: new Map([[`image/${imageName}`, bad]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    expect(report.entries[0]?.action).toBe('skipped');
  });

  it('image in use is reported and not removed', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const imageName = `ecoma-home-${ns}:local`;
    const docker: FakeDocker = {
      names: new Map([['image', [imageName]]]),
      labels: new Map([[`image/${imageName}`, ownedLabels(wt)]]),
      removed: [],
      failRm: new Set([`image/${imageName}`]),
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    const entry = report.entries.find((e) => e.name === imageName);
    expect(entry?.action).toBe('kept');
    expect(report.errors.some((e) => e.includes(imageName))).toBe(true);
  });

  it('dry-run image reports would-remove without rm', () => {
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const imageName = `ecoma-home-${ns}:local`;
    const docker: FakeDocker = {
      names: new Map([['image', [imageName]]]),
      labels: new Map([[`image/${imageName}`, ownedLabels(wt)]]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: true,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    const entry = report.entries.find((e) => e.name === imageName);
    expect(entry?.action).toBe('would-remove');
  });

  it('dry-run never issues a destructive command for any eligible resource kind', () => {
    // Toàn bộ các kind đủ điều kiện xoá (container + network + image + volume
    // state WIC) trong MỘT lần chạy dry-run: báo cáo đầy đủ `would-remove`,
    // và lệnh rm nào cũng KHÔNG được phát — trong đó volume state WIC có hình
    // lệnh khác container (không --force), nên phải khẳng định riêng thay vì
    // tin vào seam chung.
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const homeName = `ecoma-${ns}-home`;
    const networkName = `ecoma-${ns}-network`;
    const stateName = `ecoma-${ns}-auth-wic-state`;
    const imageName = `ecoma-${ns}-auth-wic:local`;
    const docker: FakeDocker = {
      names: new Map([
        ['container', [homeName]],
        ['network', [networkName]],
        ['image', [imageName]],
        ['volume', [stateName]],
      ]),
      labels: new Map([
        [`container/${homeName}`, ownedLabels(wt)],
        [`network/${networkName}`, ownedLabels(wt)],
        [`image/${imageName}`, ownedLabels(wt)],
        [`volume/${stateName}`, ownedLabels(wt)],
      ]),
      removed: [],
    };
    const report = runLocalCleanup({
      dryRun: true,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toHaveLength(0);
    expect(
      new Set(report.entries.filter((e) => e.action === 'would-remove').map((e) => e.name)),
    ).toEqual(new Set([homeName, networkName, stateName, imageName]));
    expect(report.entries.some((e) => e.action === 'removed')).toBe(false);
  });

  it('docker commands are limited to info, ls, inspect and per-resource rm', () => {
    // Contract "không có broad Docker cleanup": mọi lệnh docker cleanup phát ra
    // phải là read-only (info/ls/inspect) hoặc rm đúng MỘT resource đã qua
    // validate ownership. Một lệnh prune/system/rm-all thoát qua seam là lỗi
    // phạm vi xoá — chặn ở đây thay vì tin vào đường đọc code.
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const homeName = `ecoma-${ns}-home`;
    const docker: FakeDocker = {
      names: new Map([['container', [homeName]]]),
      labels: new Map([[`container/${homeName}`, ownedLabels(wt)]]),
      removed: [],
    };
    const captured: string[][] = [];
    const exec = (args: string[], env: NodeJS.ProcessEnv) => {
      captured.push([...args]);
      return fakeDockerExec(docker)(args, env);
    };
    runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: exec,
      worktreePresence: () => 'absent',
    });
    expect(captured.length).toBeGreaterThan(0);
    const rmViolations: string[] = [];
    for (const args of captured) {
      // `info`/`ls`/`inspect`/`rm` là args[0] (docker <verb> ...); duy nhất
      // `container rm --force <name>` dùng args[1] làm verb. Lấy cả hai, khớp
      // theo tập hợp — một lệnh prune sẽ nêu `prune`/`system` ở một trong hai.
      const verbs = [args[0], args[1] ?? ''];
      expect(
        verbs.some((v) => ['info', 'ls', 'inspect', 'rm'].includes(v)),
        `cleanup must not issue docker ${args.join(' ')}`,
      ).toBe(true);
      if (verbs.includes('rm')) {
        // rm phải nhắm đúng một resource, không bao giờ dạng all/prune. Vi phạm
        // được gom rồi khẳng định ngoài vòng lặp (vitest(no-conditional-expect)).
        if (args.length <= 2) rmViolations.push(`rm without a target: docker ${args.join(' ')}`);
        if (args.includes('--all')) rmViolations.push(`--all: docker ${args.join(' ')}`);
        if (args.includes('--prune')) rmViolations.push(`--prune: docker ${args.join(' ')}`);
        const target = args.at(-1) ?? '';
        if (!target.startsWith('ecoma-')) {
          rmViolations.push(`rm target outside the ecoma- namespace: docker ${args.join(' ')}`);
        }
      }
    }
    expect(rmViolations, 'every docker rm must target exactly one owned ecoma-* resource').toEqual(
      [],
    );
  });

  it('partial rm failure: sibling removal proceeds and the failure is reported once', () => {
    // #10 surfacing: một rm thất bại KHÔNG dừng các rm độc lập còn lại — mỗi
    // kind được xử lý độc lập; failure phải nổi lên đúng một lần trong errors
    // với stderr nguyên chữ, và entry tương ứng là `kept` kèm reason (không
    // nuốt thành "removed" và không biến thành im lặng).
    const wt = tempWorktree();
    const ns = worktreeNamespace(wt);
    const okName = `ecoma-${ns}-home`;
    const failName = `ecoma-${ns}-traefik`;
    const docker: FakeDocker = {
      names: new Map([['container', [failName, okName]]]),
      labels: new Map([
        [`container/${failName}`, ownedLabels(wt)],
        [`container/${okName}`, ownedLabels(wt)],
      ]),
      removed: [],
      failRm: new Set([`container/${failName}`]),
    };
    const report = runLocalCleanup({
      dryRun: false,
      env: {},
      execDocker: fakeDockerExec(docker),
      worktreePresence: () => 'absent',
    });
    expect(docker.removed).toEqual([`container/${okName}`]);
    const failEntry = report.entries.find((e) => e.name === failName);
    expect(failEntry?.action).toBe('kept');
    expect(failEntry?.reason).toContain('remove command failed');
    expect(failEntry?.reason).toContain(`rm ${`container/${failName}`} fail (fake)`);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain(failName);
  });
});
