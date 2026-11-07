import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  dockerResourceName,
  NAMESPACE_LENGTH,
  normalizeWorktreeRoot,
  pulumiStackName,
  worktreeNamespace,
} from './deploy-namespace.js';

/** Fixture worktree thật trên đĩa để realpath có cái mà resolve. */
const fixtures: string[] = [];

function makeFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ns-fixture-${name}-`));
  fixtures.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

describe('normalizeWorktreeRoot', () => {
  it('returns the realpathed absolute path for a real directory', () => {
    const dir = makeFixture('abs');
    expect(normalizeWorktreeRoot(dir)).toBe(dir);
  });

  it('resolves symlinks to the real directory — two paths to the same target yield ONE result', () => {
    const dir = makeFixture('real');
    const link = makeFixture('link');
    const linkPath = join(link, 'symlink');
    symlinkSync(dir, linkPath, 'dir');
    expect(normalizeWorktreeRoot(linkPath)).toBe(dir);
  });

  it('drops the trailing separator and skips `.` components', () => {
    const dir = makeFixture('slash');
    expect(normalizeWorktreeRoot(`${dir}/`)).toBe(dir);
    expect(normalizeWorktreeRoot(`${dir}/./`)).toBe(dir);
  });
});

describe('worktreeNamespace', () => {
  it('stable: the same normalized root always yields the same namespace', () => {
    const dir = makeFixture('stable');
    expect(worktreeNamespace(dir)).toBe(worktreeNamespace(dir));
  });

  it('stable across different presentations of the same root (`.`, trailing slash)', () => {
    const dir = makeFixture('stable2');
    expect(worktreeNamespace(`${dir}/.`)).toBe(worktreeNamespace(dir));
  });

  it('two different worktree roots yield two different namespaces', () => {
    const a = worktreeNamespace(makeFixture('one'));
    const b = worktreeNamespace(makeFixture('two'));
    expect(a).not.toBe(b);
  });

  it('correct shape: `w` followed by exactly NAMESPACE_LENGTH hex chars', () => {
    const ns = worktreeNamespace(makeFixture('shape'));
    expect(ns).toMatch(new RegExp(`^w[0-9a-f]{${NAMESPACE_LENGTH}}$`, 'u'));
  });
});

describe('dockerResourceName', () => {
  const ns = 'wabcdef123456';

  it('concatenates prefix + namespace + kind in the exact shape', () => {
    expect(dockerResourceName(ns, 'network')).toBe(`ecoma-${ns}-network`);
    expect(dockerResourceName(ns, 'postgres-volume')).toBe(`ecoma-${ns}-postgres-volume`);
  });

  it('contains the namespace — two worktrees never share a resource name', () => {
    const a = dockerResourceName('w000000000001', 'traefik');
    const b = dockerResourceName('w000000000002', 'traefik');
    expect(a).not.toBe(b);
  });

  it('rejects an invalid namespace for a Docker name', () => {
    expect(() => dockerResourceName('W_UPPER', 'network')).toThrow(/invalid namespace/u);
    expect(() => dockerResourceName('', 'network')).toThrow(/invalid namespace/u);
    expect(() => dockerResourceName('has space', 'network')).toThrow(/invalid namespace/u);
  });
});

describe('pulumiStackName', () => {
  it('one stack per namespace — two worktrees never share state', () => {
    expect(pulumiStackName('w000000000001')).toBe('local-w000000000001');
    expect(pulumiStackName('w000000000002')).toBe('local-w000000000002');
  });

  it('stable across calls', () => {
    expect(pulumiStackName('wabcdef123456')).toBe(pulumiStackName('wabcdef123456'));
  });
});

describe('isolation on real fixtures — two different directories', () => {
  it('namespace, docker name, and stack of two different fixtures are fully disjoint', () => {
    const dirA = makeFixture('iso-a');
    const dirB = makeFixture('iso-b');
    writeFileSync(join(dirA, 'marker.txt'), 'a');
    mkdirSync(join(dirB, 'sub'), { recursive: true });

    const nsA = worktreeNamespace(dirA);
    const nsB = worktreeNamespace(dirB);

    expect(nsA).not.toBe(nsB);
    expect(dockerResourceName(nsA, 'home')).not.toBe(dockerResourceName(nsB, 'home'));
    expect(pulumiStackName(nsA)).not.toBe(pulumiStackName(nsB));
  });
});
