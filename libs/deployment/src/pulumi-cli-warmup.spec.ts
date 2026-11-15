import { describe, expect, it, vi } from 'vitest';

import { warmPulumiCliOnce } from './pulumi-cli-warmup.js';

// Sleep no-op cho test: retryDelayMs không được phép trôi thật.
const instantSleep = (): Promise<void> => Promise.resolve();

// Mock `execFile` hoisted ở top-level (vitest/hoisted-apis-on-top): bản fresh
// của warmup module (vi.resetModules + dynamic import) sẽ bám vào mock này.
// `promisify(execFile)` truyền callback Node-style vào mock — `mockResolvedValue`
// sẽ bỏ qua callback đó và promise không bao giờ settle.
const execFileMock = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: readonly string[],
      opts: unknown,
      cb: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => void
  >(),
);
execFileMock.mockImplementation((_file, _args, _opts, cb) =>
  cb(null, { stdout: 'v3.276.0\n', stderr: '' }),
);

describe('warmPulumiCliOnce', () => {
  it('resolves immediately when the first probe returns a clean semver', async () => {
    let calls = 0;
    await warmPulumiCliOnce({
      probe: async () => {
        calls++;
        return { stdout: 'v3.276.0\n' };
      },
      sleep: instantSleep,
    });
    expect(calls).toBe(1);
  });

  it('retries past dirty output and transient probe errors until the version is parseable', async () => {
    const results: Array<{ stdout: string } | Error> = [
      new Error('spawn ETXTBSY'),
      // Banner cài đặt chiếm trọn stdout lần đầu — phải bị từ chối, giống ngữ
      // nghĩa parse của `PulumiCommand.get`.
      { stdout: '=== Installing Pulumi ===\n=== Pulumi is now installed! ===\n' },
      { stdout: 'v3.276.0\n' },
    ];
    const delays: number[] = [];
    let calls = 0;
    await warmPulumiCliOnce({
      attempts: 5,
      retryDelayMs: 7,
      probe: async () => {
        const next = results[calls];
        calls++;
        if (next instanceof Error) throw next;
        return next;
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(calls).toBe(3);
    expect(delays).toEqual([7, 7]);
  });

  it('throws loud with the attempt count after exhausting the bounded retries', async () => {
    let calls = 0;
    await expect(
      warmPulumiCliOnce({
        attempts: 3,
        retryDelayMs: 1,
        probe: async () => {
          calls++;
          return { stdout: 'not a version' };
        },
        sleep: instantSleep,
      }),
    ).rejects.toThrow(/after 3 attempts/u);
    expect(calls).toBe(3);
  });

  it('does not count a failed attempt as a retry when it is the last one (no trailing sleep hang)', async () => {
    let sleeps = 0;
    await expect(
      warmPulumiCliOnce({
        attempts: 2,
        retryDelayMs: 5,
        probe: async () => {
          throw new Error('spawn ETXTBSY');
        },
        sleep: async () => {
          sleeps++;
        },
      }),
    ).rejects.toThrow(/after 2 attempts/u);
    expect(sleeps).toBe(1);
  });
});

// `warmupPromise` là state module-level và module không export reset seam:
// `vi.resetModules()` + dynamic import tạo một instance module sạch cho mỗi
// test, không đụng cache của test khác cũng như không để cache của test khác
// làm test "pass by accident".
async function importFreshModule(): Promise<typeof import('./pulumi-cli-warmup.js')> {
  vi.resetModules();
  return import('./pulumi-cli-warmup.js');
}

describe('warmPulumiCli', () => {
  it('treats an options call as an explicit fresh warmup that bypasses the cache', async () => {
    const { warmPulumiCli: fresh } = await importFreshModule();
    let calls = 0;
    const probe = async (): Promise<{ stdout: string }> => {
      calls++;
      return { stdout: 'v3.276.0\n' };
    };
    // Gọi kèm options = yêu cầu rõ một lượt warm-up mới (đúng semantics của
    // `warmPulumiCliOnce(options)`) — không tái dùng cache, không ghi đè nó.
    await fresh({ probe, sleep: instantSleep });
    const before = calls;
    await fresh({ probe, sleep: instantSleep });
    expect(calls).toBe(before + 1);
  });

  it('runs the default probe exactly once across repeated default-path calls (promise cache)', async () => {
    // Default path không nhận probe bơm, nên quan sát qua `child_process.execFile`
    // được mock ở top-level: mock module trước khi dynamic import để bản fresh
    // của warmup module bám vào mock.
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    const { warmPulumiCli: freshMocked } = await importFreshModule();
    await freshMocked();
    await freshMocked();
    await freshMocked();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
