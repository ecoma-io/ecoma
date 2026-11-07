import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { exec, type EntryFoundation, type ExecResult } from '@ecoma-io/deployment';
import { runPlatformDown, type PlatformDownDeps } from './platform-down.js';

vi.mock('@ecoma-io/deployment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ecoma-io/deployment')>();
  return {
    ...actual,
    exec: vi.fn<typeof actual.exec>(),
  };
});

const foundation: EntryFoundation = {
  ctx: {
    worktreeRoot: '/tmp/wt',
    namespace: 'w0123456789ab',
    stackName: 'local-w0123456789ab',
    stateUrl: 'file:///tmp/wt/.pulumi-local-state',
  },
  env: { PULUMI_CONFIG_PASSPHRASE: 'unused' },
};

const VOLUME_NAME = 'ecoma-w0123456789ab-postgres-volume';

function ok(stdout = ''): ExecResult {
  return { status: 0, stdout, stderr: '' };
}

function fail(stderr: string): ExecResult {
  return { status: 1, stdout: '', stderr };
}

type DestroyFn = NonNullable<PlatformDownDeps['destroy']>;
type ExecDockerFn = NonNullable<PlatformDownDeps['execDocker']>;

function okDestroy(): DestroyFn {
  // Đánh dấu `void` để vi.fn() bọc được mà không vi phạm no-empty-function.
  return (project, _foundation) => {
    expect(project).toBe('platform-deploy');
  };
}

function okDocker(): ExecDockerFn {
  return (args) => {
    expect(args).toEqual(['volume', 'rm', VOLUME_NAME]);
    return ok(`${VOLUME_NAME}\n`);
  };
}

/** Console spy im lặng — thân hàm `return;` để không vi phạm no-empty-function. */
function swallow(): void {
  return;
}

describe('runPlatformDown', () => {
  it('succeeds when destroy and volume removal both succeed', async () => {
    const destroy = vi.fn<DestroyFn>(okDestroy());
    const execDocker = vi.fn<ExecDockerFn>(okDocker());
    const exit = await runPlatformDown(foundation, { destroy, execDocker });
    expect(exit).toBe(0);
    expect(destroy).toHaveBeenCalledWith('platform-deploy', foundation);
    expect(execDocker).toHaveBeenCalledTimes(1);
  });

  it('deletes the volume even when the destroy fails, and exits non-zero', async () => {
    const destroy = vi.fn<DestroyFn>(() => {
      throw new Error('pulumi destroy failed: daemon unreachable');
    });
    const execDocker = vi.fn<ExecDockerFn>(okDocker());
    const exit = await runPlatformDown(foundation, { destroy, execDocker });
    expect(execDocker).toHaveBeenCalledTimes(1);
    expect(exit).toBe(1);
  });

  it('exits non-zero and reports the volume error when only the volume removal fails', async () => {
    const destroy = vi.fn<DestroyFn>(okDestroy());
    const execDocker = vi.fn<ExecDockerFn>(() => fail('Error response from daemon: remove'));
    const exit = await runPlatformDown(foundation, { destroy, execDocker });
    expect(exit).toBe(1);
  });

  it('exits non-zero with BOTH failures visible when destroy and volume removal both fail', async () => {
    const destroy = vi.fn<DestroyFn>(() => {
      throw new Error('pulumi destroy failed: bad passphrase');
    });
    const execDocker = vi.fn<ExecDockerFn>(() => fail('Error response from daemon: volume in use'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(swallow);
    try {
      const exit = await runPlatformDown(foundation, { destroy, execDocker });
      expect(exit).toBe(1);
      const output = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('pulumi destroy failed: bad passphrase');
      expect(output).toContain('volume in use');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('treats an already-absent volume as idempotent success', async () => {
    const destroy = vi.fn<DestroyFn>(okDestroy());
    const execDocker = vi.fn<ExecDockerFn>(() => fail(`Error: No such volume: ${VOLUME_NAME}`));
    const exit = await runPlatformDown(foundation, { destroy, execDocker });
    expect(exit).toBe(0);
  });

  it('is idempotent end to end: empty stack destroy and absent volume both pass', async () => {
    // destroy thành công (stack rỗng, Pulumi tự exit 0) + volume đã biến mất
    // sau lần down trước — chạy down lần hai phải exit 0.
    const destroy = vi.fn<DestroyFn>(okDestroy());
    const execDocker = vi.fn<ExecDockerFn>(() =>
      fail('Error response from daemon: no such volume'),
    );
    const exit = await runPlatformDown(foundation, { destroy, execDocker });
    expect(exit).toBe(0);
  });

  it('never prints a success line for the volume when its removal failed', async () => {
    const destroy = vi.fn<DestroyFn>(okDestroy());
    const execDocker = vi.fn<ExecDockerFn>(() => fail('docker daemon down'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(swallow);
    try {
      await runPlatformDown(foundation, { destroy, execDocker });
      expect(logSpy.mock.calls.some((c) => c.join(' ').includes('volume deleted.'))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('passes only the namespace-scoped volume name to docker (no prune, no wildcard)', async () => {
    const destroy = vi.fn<DestroyFn>(okDestroy());
    const calls: string[][] = [];
    const execDocker = vi.fn<ExecDockerFn>((args) => {
      calls.push([...args]);
      return ok(`${VOLUME_NAME}\n`);
    });
    await runPlatformDown(foundation, { destroy, execDocker });
    for (const args of calls) {
      expect(args).toEqual(['volume', 'rm', VOLUME_NAME]);
      expect(args.join(' ')).not.toContain('prune');
    }
  });

  it('reports a spawn-level docker failure (daemon missing) as a real failure', async () => {
    const destroy = vi.fn<DestroyFn>(okDestroy());
    const execDocker = vi.fn<ExecDockerFn>(() => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('ENOENT'),
    }));
    const exit = await runPlatformDown(foundation, { destroy, execDocker });
    expect(exit).toBe(1);
  });

  it('uses the shared exec channel (no direct child_process import in this module)', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, 'platform-down.ts'), 'utf8');
    expect(source).toContain('exec,');
    expect(source).toContain("from '@ecoma-io/deployment'");
    expect(exec).toBeDefined();
  });
});
