import { describe, expect, it } from 'vitest';

import { warmPulumiCli, warmPulumiCliOnce } from './pulumi-cli-warmup.js';

// Sleep no-op cho test: retryDelayMs không được phép trôi thật.
const instantSleep = (): Promise<void> => Promise.resolve();

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

describe('warmPulumiCli', () => {
  it('runs the probe once across repeated calls on the default path (promise cache)', async () => {
    let calls = 0;
    const probe = async (): Promise<{ stdout: string }> => {
      calls++;
      return { stdout: 'v3.276.0\n' };
    };
    // Module-level cache: trong cùng process, lượt gọi đầu tạo promise, các
    // lượt sau tái dùng — probe KHÔNG chạy lại. (Cache là state module: test
    // này chạy sau mọi test khác trong file nên không đụng cache đã có.)
    await warmPulumiCli({ probe, sleep: instantSleep });
    await warmPulumiCli();
    await warmPulumiCli();
    expect(calls).toBe(1);
  });

  it('treats an options call as an explicit fresh warmup that bypasses the cache', async () => {
    let calls = 0;
    const probe = async (): Promise<{ stdout: string }> => {
      calls++;
      return { stdout: 'v3.276.0\n' };
    };
    // Gọi kèm options = yêu cầu rõ một lượt warm-up mới (đúng semantics của
    // `warmPulumiCliOnce(options)`) — không tái dùng cache, không ghi đè nó.
    await warmPulumiCli({ probe, sleep: instantSleep });
    const before = calls;
    await warmPulumiCli({ probe, sleep: instantSleep });
    expect(calls).toBe(before + 1);
  });
});
