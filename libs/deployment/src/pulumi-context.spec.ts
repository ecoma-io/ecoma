import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { worktreeNamespace } from './deploy-namespace.js';
import {
  ensureStack,
  fullStackRef,
  localPassphrasePath,
  localStateDir,
  pulumiEnv,
  pulumiRun,
  resolveContext,
  resolveLocalPassphrase,
  hasPulumiState,
} from './pulumi-context.js';

const cleanup: string[] = [];

function tempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulumi-ctx-spec-'));
  cleanup.push(dir);
  return dir;
}

afterEach(() => {
  // Không rmSync ở afterEach cho các worktree chứa state Pulumi thật — chỉ xoá
  // ở afterAll để test song song trong cùng suite không đụng nhau.
});

afterAll(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveContext', () => {
  it('the default worktree root resolves to the workspace root, not a parent directory', () => {
    // Anchor sai một mức là namespace lệch và cả lane up thành stack khác
    // (đo thật trên PR #424: `libs/` thay vì repo root → `we6044…` thay vì
    // `wc241…`). Pin đúng thuộc tính: default context suy từ root THẬT của
    // checkout này, nơi `.pulumi-local-state` + `deploys/` + `.env` sống.
    const ctx = resolveContext();
    expect(ctx.worktreeRoot).not.toMatch(/\/libs$/u);
    expect(existsSync(join(ctx.worktreeRoot, 'deploys'))).toBe(true);
    expect(existsSync(join(ctx.worktreeRoot, '.oxlintrc.json'))).toBe(true);
  });

  it('each worktree gets its own namespace, stack, and state backend', () => {
    const a = resolveContext(tempWorktree());
    const b = resolveContext(tempWorktree());
    expect(a.namespace).not.toBe(b.namespace);
    expect(a.stackName).not.toBe(b.stackName);
    expect(a.stateUrl).not.toBe(b.stateUrl);
  });

  it('stack name follows the local-<ns> contract and state lives inside the worktree (outside Git)', () => {
    const root = tempWorktree();
    const ctx = resolveContext(root);
    expect(ctx.stackName).toBe(`local-${worktreeNamespace(root)}`);
    expect(ctx.stateUrl.startsWith(`file://${root}`)).toBe(true);
  });

  it('stateUrl is a correctly encoded file URL — special chars in the path do not break the backend URL', () => {
    // `pathToFileURL` encode `%` v.v. — nối chuỗi `file://${root}` với path chứa
    // `%` sẽ tạo URL sai mà Pulumi CLI parse lỗi hoặc trỏ sang thư mục khác.
    const parent = mkdtempSync(join(tmpdir(), 'pulumi-ctx-'));
    cleanup.push(parent);
    const root = join(parent, 'wt with %sign');
    mkdirSync(root, { recursive: true });
    const ctx = resolveContext(root);
    expect(ctx.stateUrl).toBe(pathToFileURL(join(root, '.pulumi-local-state')).href);
    expect(ctx.stateUrl).not.toContain(' %');
  });

  it('two worktrees with different paths never share a state dir — even after normalize', () => {
    const root = tempWorktree();
    const ctx1 = resolveContext(root);
    // Cùng thư mục qua đường dẫn có trailing slash và path tương đối phải ra
    // MỘT context (normalize cùng nguồn), nhưng khác thư mục thì KHÔNG BAO GIỜ
    // trùng stateUrl.
    const ctxSame = resolveContext(`${root}/`);
    expect(ctxSame.stateUrl).toBe(ctx1.stateUrl);
    const ctxOther = resolveContext(tempWorktree());
    expect(ctxOther.stateUrl).not.toBe(ctx1.stateUrl);
  });
});

describe('fullStackRef', () => {
  it('full stack ref follows the organization/<project>/<stack> format of the file:// backend', () => {
    const ctx = resolveContext(tempWorktree());
    expect(fullStackRef('platform-deploy', ctx)).toBe(
      `organization/platform-deploy/${ctx.stackName}`,
    );
  });

  it('two worktrees → two different stack refs for the same project', () => {
    const a = fullStackRef('platform-deploy', resolveContext(tempWorktree()));
    const b = fullStackRef('platform-deploy', resolveContext(tempWorktree()));
    expect(a).not.toBe(b);
  });
});

describe('resolveLocalPassphrase', () => {
  const SAVE = {
    passphrase: process.env.PULUMI_CONFIG_PASSPHRASE,
    file: process.env.PULUMI_CONFIG_PASSPHRASE_FILE,
  };

  afterEach(() => {
    if (SAVE.passphrase === undefined) delete process.env.PULUMI_CONFIG_PASSPHRASE;
    else process.env.PULUMI_CONFIG_PASSPHRASE = SAVE.passphrase;
    if (SAVE.file === undefined) delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    else process.env.PULUMI_CONFIG_PASSPHRASE_FILE = SAVE.file;
  });

  it('no passphrase anywhere → generate a cryptographically random one and store it outside Git', () => {
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    const root = tempWorktree();
    const result = resolveLocalPassphrase(root, { create: true });
    expect(result.kind).toBe('worktree');
    const value = result.kind === 'worktree' ? result.value : '';
    // 32 random bytes base64url → 43 ký tự, không rỗng, không phải giá trị đoán
    // được. Chỉ assert độ dài + alphabet: giá trị không được rò ra log.
    expect(value.length).toBe(43);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/u);
    // Lưu ra file của worktree để lần deploy sau dùng lại cùng passphrase.
    expect(existsSync(localPassphrasePath(root))).toBe(true);
  });

  it('generated passphrase differs between worktrees — no shared secret across stacks', () => {
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    const a = resolveLocalPassphrase(tempWorktree(), { create: true });
    const b = resolveLocalPassphrase(tempWorktree(), { create: true });
    expect(a.kind === 'worktree' && b.kind === 'worktree' && a.value === b.value).toBe(false);
  });

  it('stored passphrase is reused on the next call — never regenerated per invocation', () => {
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    const root = tempWorktree();
    const first = resolveLocalPassphrase(root, { create: true });
    const second = resolveLocalPassphrase(root, { create: true });
    expect(first).toEqual(second);
  });

  it('developer passphrase from the environment wins and is persisted for later runs', () => {
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    process.env.PULUMI_CONFIG_PASSPHRASE = 'unit-test-secret-value';
    const root = tempWorktree();
    const result = resolveLocalPassphrase(root, { create: true });
    expect(result).toEqual({ kind: 'inline', value: 'unit-test-secret-value' });
    // Được ghi vào file → stack tự chứa từ lần chạy sau (kể cả khi biến môi
    // trường biến mất).
    expect(resolveLocalPassphrase(root, { create: true })).toEqual({
      kind: 'worktree',
      value: 'unit-test-secret-value',
    });
  });

  it('PULUMI_CONFIG_PASSPHRASE_FILE counts as a supply path', () => {
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    process.env.PULUMI_CONFIG_PASSPHRASE_FILE = '/tmp/some-passphrase-file';
    const root = tempWorktree();
    const result = resolveLocalPassphrase(root, { create: true });
    expect(result).toEqual({ kind: 'file' });
    // Nguồn passphrase ngoài repo → KHÔNG ghi vào file của worktree.
    expect(existsSync(localPassphrasePath(root))).toBe(false);
  });

  it('empty-string passphrase is treated as unset — falls through to _FILE, never accepted (PU6 fail-open)', () => {
    // `export PULUMI_CONFIG_PASSPHRASE=` / CI set biến rỗng: chuỗi rỗng là giá
    // trị hợp lệ với Pulumi, chấp nhận nó = state mã hoá bằng khoá rỗng.
    process.env.PULUMI_CONFIG_PASSPHRASE = '';
    const root = tempWorktree();
    const noFile = resolveLocalPassphrase(root, { create: true });
    expect(noFile.kind).toBe('worktree');

    process.env.PULUMI_CONFIG_PASSPHRASE_FILE = '/tmp/some-passphrase-file';
    const withFile = resolveLocalPassphrase(tempWorktree(), { create: true });
    expect(withFile).toEqual({ kind: 'file' });
  });

  it('empty-string _FILE is treated as unset — same standard as the inline variable (PU6)', () => {
    // `export PULUMI_CONFIG_PASSPHRASE_FILE=` phải rơi tiếp xuống sinh passphrase
    // của worktree chứ không bị coi là "đã cung cấp".
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    process.env.PULUMI_CONFIG_PASSPHRASE_FILE = '';
    const root = tempWorktree();
    const result = resolveLocalPassphrase(root, { create: true });
    expect(result.kind).toBe('worktree');
  });

  it('create: false never writes a file — read-only callers must not mutate the worktree', () => {
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    const root = tempWorktree();
    const result = resolveLocalPassphrase(root, { create: false });
    expect(result).toEqual({ kind: 'none' });
    expect(existsSync(localPassphrasePath(root))).toBe(false);
  });

  it('empty passphrase file is treated as absent — not a valid passphrase', () => {
    const root = tempWorktree();
    writeFileSync(localPassphrasePath(root), '   \n', 'utf8');
    const result = resolveLocalPassphrase(root, { create: false });
    expect(result).toEqual({ kind: 'none' });
  });

  it('existing Pulumi state with no available passphrase → throws (fail closed)', () => {
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    const root = tempWorktree();
    const stacksDir = join(localStateDir(root), '.pulumi', 'stacks', 'platform-deploy');
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(join(stacksDir, 'local-test.json'), '{}', 'utf8');
    expect(hasPulumiState(root)).toBe(true);
    expect(() => resolveLocalPassphrase(root, { create: true })).toThrow(
      /already has local Pulumi state/u,
    );
  });

  it('new stack (no state) with no passphrase → generates and persists', () => {
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    const root = tempWorktree();
    const result = resolveLocalPassphrase(root, { create: true });
    expect(result.kind).toBe('worktree');
    expect(hasPulumiState(root)).toBe(false);
  });

  it('EEXIST race: rereads persisted value instead of keeping generated', () => {
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
    const root = tempWorktree();
    writeFileSync(localPassphrasePath(root), 'race-winner-value\n', 'utf8');
    const result = resolveLocalPassphrase(root, { create: true });
    expect(result).toEqual({ kind: 'worktree', value: 'race-winner-value' });
    expect(readFileSync(localPassphrasePath(root), 'utf8').trim()).toBe('race-winner-value');
  });
});

describe('pulumiEnv', () => {
  it('env carries the backend URL of the RIGHT worktree + passphrase, does not touch PULUMI_HOME', () => {
    const ctx = resolveContext(tempWorktree());
    const env = pulumiEnv(ctx, { kind: 'inline', value: 'test-pass' });
    expect(env['PULUMI_BACKEND_URL']).toBe(ctx.stateUrl);
    expect(env['PULUMI_CONFIG_PASSPHRASE']).toBe('test-pass');
    expect(env['PULUMI_SKIP_UPDATE_CHECK']).toBe('1');
    expect('PULUMI_HOME' in env).toBe(false);
  });

  it('worktree passphrase is injected into the subprocess env', () => {
    const ctx = resolveContext(tempWorktree());
    const env = pulumiEnv(ctx, { kind: 'worktree', value: 'wt-pass' });
    expect(env['PULUMI_CONFIG_PASSPHRASE']).toBe('wt-pass');
  });

  it('file path (no inline value) → PULUMI_CONFIG_PASSPHRASE DELETED, not set empty', () => {
    const ctx = resolveContext(tempWorktree());
    // Giả lập env kế thừa có sẵn biến rỗng/lậu từ shell — `delete` phải gỡ
    // được, để CLI tự đọc PULUMI_CONFIG_PASSPHRASE_FILE theo thứ tự chuẩn (PU2).
    process.env.PULUMI_CONFIG_PASSPHRASE = '';
    const env = pulumiEnv(ctx, { kind: 'file' });
    expect('PULUMI_CONFIG_PASSPHRASE' in env).toBe(false);
    expect(env['PULUMI_BACKEND_URL']).toBe(ctx.stateUrl);
  });

  it('no passphrase at all → BOTH variables deleted so the CLI reports the real reason', () => {
    const ctx = resolveContext(tempWorktree());
    process.env.PULUMI_CONFIG_PASSPHRASE = 'leftover';
    process.env.PULUMI_CONFIG_PASSPHRASE_FILE = 'leftover-file';
    const env = pulumiEnv(ctx, { kind: 'none' });
    expect('PULUMI_CONFIG_PASSPHRASE' in env).toBe(false);
    expect('PULUMI_CONFIG_PASSPHRASE_FILE' in env).toBe(false);
    delete process.env.PULUMI_CONFIG_PASSPHRASE;
    delete process.env.PULUMI_CONFIG_PASSPHRASE_FILE;
  });
});

describe('ensureStack — real Pulumi subprocess isolation', () => {
  // Suite này chạy `pulumi` thật khi CLI có mặt trên PATH; thiếu CLI thì skip
  // (CI unit-test job không cài Pulumi — hợp đồng concurrency chỉ tự chứng minh
  // trên máy developer, nơi lệnh này thực sự chạy).
  const hasCli = spawnSync('pulumi', ['version'], { encoding: 'utf8' }).status === 0;

  it(
    'two concurrent worktrees: independent backends, no shared state mutation',
    { timeout: 60_000 },
    () => {
      if (!hasCli) return; // skip im lặng — documented limitation
      const wtA = tempWorktree();
      const wtB = tempWorktree();
      const ctxA = resolveContext(wtA);
      const ctxB = resolveContext(wtB);
      const envA = pulumiEnv(ctxA, { kind: 'inline', value: 'concurrent-test-pass' });
      const envB = pulumiEnv(ctxB, { kind: 'inline', value: 'concurrent-test-pass' });

      const projDirA = join(wtA, 'proj-a');
      const projDirB = join(wtB, 'proj-b');
      for (const dir of [projDirA, projDirB]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'Pulumi.yaml'),
          'name: ctxspec\nruntime: nodejs\nmain: .\n',
          'utf8',
        );
      }

      // KỸ THUẬT: init thật trong backend của từng worktree — chứng minh backend
      // env-only không cần login và state đi đúng chỗ.
      ensureStack(projDirA, 'ctxspec', ctxA, envA);
      ensureStack(projDirB, 'ctxspec', ctxB, envB);

      // State của mỗi worktree chứa đúng stack của nó.
      expect(existsSync(join(localStateDir(wtA), '.pulumi/stacks/ctxspec'))).toBe(true);
      expect(existsSync(join(localStateDir(wtB), '.pulumi/stacks/ctxspec'))).toBe(true);

      // Stack name khác nhau giữa hai worktree (namespace trong tên) — dù backend
      // env bị hoán đổi cũng không bao giờ trỏ nhầm stack.
      expect(ctxA.stackName).not.toBe(ctxB.stackName);

      // Dọn: xoá stack để state không vương lại trong temp (đã có afterAll rm).
      for (const [dir, ctx, env] of [
        [projDirA, ctxA, envA],
        [projDirB, ctxB, envB],
      ] as const) {
        spawnSync('pulumi', ['stack', 'rm', '--yes', '--stack', fullStackRef('ctxspec', ctx)], {
          cwd: dir,
          encoding: 'utf8',
          env,
        });
      }
    },
  );
});

describe('pulumiRun — prepareStack is opt-in', () => {
  // Mặc định KHÔNG được chuẩn bị stack: lệnh đọc/teardown quên truyền cờ không
  // bao giờ được biến thành mutation (mkdir + stack init) trên worktree chưa
  // từng deploy. Chạy CLI thật khi có mặt; thiếu CLI thì skip (giống suite trên).
  const hasCli = spawnSync('pulumi', ['version'], { encoding: 'utf8' }).status === 0;

  it('a read command WITHOUT prepareStack → no state dir created, no stack init', () => {
    if (!hasCli) return; // skip im lặng — documented limitation
    const wt = tempWorktree();
    const ctx = resolveContext(wt);
    const env = pulumiEnv(ctx, { kind: 'inline', value: 'optin-test-pass' });
    const projDir = join(wt, 'proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'Pulumi.yaml'),
      'name: optinspec\nruntime: nodejs\nmain: .\n',
      'utf8',
    );

    // Lệnh đọc vô hại trên stack chưa tồn tại (`stack export` trên stack chưa
    // init là exit != 0) — điều cần assert KHÔNG phải exit code mà là side
    // effect: không có state dir nào được tạo, không có stack nào được init.
    expect(() => pulumiRun(projDir, 'optinspec', ['stack', 'export'], ctx, env)).toThrow(
      /failed|could not run/u,
    );
    expect(existsSync(localStateDir(wt))).toBe(false);
  });

  it('a mutation command with prepareStack: true → state dir + stack are created', () => {
    if (!hasCli) return; // skip im lặng — documented limitation
    const wt = tempWorktree();
    const ctx = resolveContext(wt);
    const env = pulumiEnv(ctx, { kind: 'inline', value: 'optin-test-pass' });
    const projDir = join(wt, 'proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'Pulumi.yaml'),
      'name: optinspec\nruntime: nodejs\nmain: .\n',
      'utf8',
    );

    // Đối chứng với test trên: CÙNG lệnh đọc, lần này có `prepareStack: true` —
    // ensureStack init stack thật nên `stack export` exit 0 (deployment JSON
    // rỗng của stack mới) và state dir tồn tại.
    const stdout = pulumiRun(projDir, 'optinspec', ['stack', 'export'], ctx, env, {
      prepareStack: true,
    });
    expect(stdout).toContain('"version"');
    expect(existsSync(localStateDir(wt))).toBe(true);

    // Dọn stack để state không vương lại trong temp (đã có afterAll rm).
    spawnSync('pulumi', ['stack', 'rm', '--yes', '--stack', fullStackRef('optinspec', ctx)], {
      cwd: projDir,
      encoding: 'utf8',
      env,
    });
  });
});
