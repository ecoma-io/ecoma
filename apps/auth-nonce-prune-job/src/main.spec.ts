/**
 * Specs của composition root (`src/main.ts`) — `runOnce` + handler `scheduled`.
 *
 * ⚠️ KHÔNG platform proxy (khác `transactional-mailer-job`): job này KHÔNG có D1, không
 * cần `getPlatformProxy` — hai dependency duy nhất của nó là (1) loader config, (2) hai
 * pool `pg`. Pool `pg` thật KHÔNG được dựng trong unit specs: `pruneTarget` (thuật toán
 * ở application lib) được thay bằng fake qua `vi.mock` — composition root chỉ cần hợp
 * đồng của nó ("resolve hoặc throw"), không cần PostgreSQL thật (integration trên PG
 * thật là việc của suite `apps/auth`/`apps/account`).
 *
 * Phạm vi: những gì chỉ bẻ gãy được ở tầng compose —
 *   - handler `scheduled` chỉ export đúng `scheduled` (KHÔNG `fetch` — không HTTP surface);
 *   - loader từ chối config hỏng TRƯỚC khi pool nào được dựng;
 *   - một kho hỏng KHÔNG cản kho kia chạy, và cả hai kết quả đều được log;
 *   - bất kỳ kho nào throw → handler cuối cùng vẫn `throw` (cron đỏ đúng nguyên nhân);
 *   - thiếu Hyperdrive binding → log `outcome=not_configured` + rethrow;
 *   - đường chính KHÔNG đi qua `ctx.waitUntil`.
 */

import { describe, expect, it, vi } from 'vitest';

import { pruneTarget, type PruneTargetRun } from '@ecoma-io/auth-nonce-prune-job-application';

import {
  DB_ACCOUNT_BINDING,
  DB_AUTH_BINDING,
  PruneJobConfigError,
  type PruneJobEnv,
} from './config';
import workerDefault, { runOnce } from './main';

vi.mock('@ecoma-io/auth-nonce-prune-job-application', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@ecoma-io/auth-nonce-prune-job-application')>();
  return {
    ...actual,
    pruneTarget:
      vi.fn<
        (
          target: Parameters<typeof pruneTarget>[0],
          opts?: Parameters<typeof pruneTarget>[1],
        ) => Promise<PruneTargetRun>
      >(),
  };
});

const pruneMock = vi.mocked(pruneTarget);

type ScheduledHandler = (
  controller: { readonly cron: string },
  env: PruneJobEnv,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
) => Promise<void>;

/** Default export của Worker — object chỉ mang `scheduled` (ghim ở describe đầu). */
const scheduled = workerDefault.scheduled as ScheduledHandler;

/** Kết quả kho thành công mặc định — counters đủ để log một dòng JSON. */
function okRun(service: string): PruneTargetRun {
  return {
    service,
    outcome: 'ok',
    pruned: 12_345,
    batches: 3,
    duration_s: 42,
    retries: 1,
  };
}

/** Env hợp lệ tối thiểu — thay bằng một env thiếu binding là test fail-closed mỗi đường. */
function makeEnv(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    [DB_AUTH_BINDING]: { connectionString: 'postgres://auth-pruner:fake@hd-auth/db-auth' },
    [DB_ACCOUNT_BINDING]: {
      connectionString: 'postgres://account-pruner:fake@hd-account/db-account',
    },
    ...overrides,
  };
}

/**
 * spy `console.log` của composition root, parse từng dòng thành object JSON, restore trong
 * `finally` — pattern `vi.spyOn` của `transactional-mailer-job/main.spec.ts`.
 */
function captureConsoleLog(): { lines: Record<string, unknown>[]; restore(): void } {
  const lines: Record<string, unknown>[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown): void => {
    lines.push(typeof line === 'string' ? (JSON.parse(line) as Record<string, unknown>) : {});
    return undefined;
  });
  return {
    lines,
    restore: (): void => {
      logSpy.mockRestore();
    },
  };
}

describe('worker export shape', () => {
  it('exports only a scheduled handler and never a fetch handler', () => {
    // Không HTTP surface: wrangler.jsonc không có route và `workers_dev: false`; một
    // `fetch` export sẽ là một ranh giới mới cần auth mà không endpoint nào được định
    // nghĩa trong tài liệu — ghim cho nó không bao giờ xuất hiện lặng lẽ.
    expect(Object.keys(workerDefault).toSorted()).toEqual(['scheduled']);
  });
});

describe('runOnce — config gate', () => {
  it('throws the config error before any target runs when a binding is missing', async () => {
    // Fail-closed theo hợp đồng của script cũ: thiếu cấu hình là đỏ mỗi lần chạy, không
    // phải "bỏ qua run này". `runOnce` throw ngay ở loader — KHÔNG pool nào được dựng,
    // KHÔNG target nào chạy; dòng log `not_configured` là việc của handler `scheduled`
    // (test dưới nó).
    const env = makeEnv({ [DB_AUTH_BINDING]: undefined });
    let caught: unknown;
    const capture = captureConsoleLog();
    try {
      caught = await runOnce(env as PruneJobEnv, 0).catch((e: unknown) => e);
    } finally {
      capture.restore();
    }
    expect(caught).toBeInstanceOf(PruneJobConfigError);
    expect(pruneMock).not.toHaveBeenCalled();
    expect(capture.lines).toEqual([]);
  });

  it('does not run any target when a binding has an invalid shape', async () => {
    // Loader phải từ chối TRƯỚC khi pool nào được dựng — DSN sai shape không được phép
    // chạm Hyperdrive. `pruneTarget` là mock, nên "chưa được gọi" là kiểm trực tiếp.
    pruneMock.mockClear();
    let caught: unknown;
    const capture = captureConsoleLog();
    try {
      caught = await runOnce(
        makeEnv({ [DB_AUTH_BINDING]: { connectionString: '' } }) as PruneJobEnv,
        0,
      ).catch((e: unknown) => e);
    } finally {
      capture.restore();
    }
    expect(caught).toBeInstanceOf(PruneJobConfigError);
    expect(pruneMock).not.toHaveBeenCalled();
    expect(capture.lines).toEqual([]);
  });
});

describe('runOnce — two-target orchestration', () => {
  it('lets one target fail without preventing the other from running and logs both, then rethrows', async () => {
    // Cốt lõi của `Promise.allSettled`: kho account throw (identity mismatch — shape dòng
    // lỗi script cũ) KHÔNG cản kho auth chạy tới xong. Cả hai kết quả đều được log (kho
    // hỏng có dòng `nonce_prune_error` riêng với message nguyên văn), và handler cuối
    // cùng vẫn `throw` để cron đỏ đúng nguyên nhân.
    const rejection = new Error(
      'service=account outcome=identity_mismatch connected_as=x expected=y pruned=0 batches=0 duration_s=0 retries=0',
    );
    pruneMock.mockReset();
    pruneMock.mockImplementation((target) => {
      if (target.service === 'auth') {
        return Promise.resolve(okRun('auth'));
      }
      return Promise.reject(rejection);
    });
    let caught: unknown;
    const capture = captureConsoleLog();
    try {
      caught = await runOnce(makeEnv({}) as PruneJobEnv, 0).catch((e: unknown) => e);
    } finally {
      capture.restore();
    }
    expect(caught).toBe(rejection);
    expect(pruneMock).toHaveBeenCalledTimes(2);
    const okLine = capture.lines.find(
      (l) => l['event'] === 'nonce_prune' && l['service'] === 'auth',
    );
    expect(okLine).toMatchObject({ outcome: 'ok', pruned: 12_345 });
    const errorLine = capture.lines.find((l) => l['event'] === 'nonce_prune_error');
    expect(errorLine?.['message']).toBe(rejection.message);
  });

  it('logs a JSON result line per target when both succeed and never a connection string', async () => {
    // Hai kho đều ok → hai dòng `event=nonce_prune` theo đúng thứ tự service khai. Log
    // không chứa một giá trị connection string nào — DSN không bao giờ vào log (SR-001).
    pruneMock.mockReset();
    pruneMock.mockImplementation((target) => Promise.resolve(okRun(target.service)));
    const capture = captureConsoleLog();
    let caught: unknown;
    try {
      caught = await runOnce(makeEnv({}) as PruneJobEnv, 0).catch((e: unknown) => e);
    } finally {
      capture.restore();
    }
    expect(caught).toBeUndefined();
    expect(capture.lines.map((l) => l['event'])).toEqual(['nonce_prune', 'nonce_prune']);
    expect(capture.lines.map((l) => l['service'])).toEqual(['auth', 'account']);
    expect(JSON.stringify(capture.lines)).not.toContain('postgres://');
  });

  it('passes a single-line JSON retry logger per service into the algorithm', async () => {
    // `retryLogger` phải ghi JSON một dòng `event=nonce_prune_retry` + service + what +
    // attempt — cùng nội dung `::warning::` của script cũ, kênh log Worker.
    pruneMock.mockReset();
    pruneMock.mockImplementation((target, opts) => {
      opts?.logRetry?.('identity_check', 2);
      return Promise.resolve(okRun(target.service));
    });
    const capture = captureConsoleLog();
    try {
      await runOnce(makeEnv({}) as PruneJobEnv, 0);
    } finally {
      capture.restore();
    }
    expect(capture.lines.filter((l) => l['event'] === 'nonce_prune_retry')).toMatchObject([
      { service: 'auth', what: 'identity_check', attempt: 2 },
      { service: 'account', what: 'identity_check', attempt: 2 },
    ]);
  });
});

describe('scheduled handler', () => {
  it('rethrows errors after logging so the cron invocation goes red', async () => {
    // Lỗi của handler là status của cron invocation (Past events đỏ) — một try/catch nuốt
    // ở đây là một run hỏng trông giống một run xanh. Ghim: handler phải throw.
    const env = makeEnv({ [DB_ACCOUNT_BINDING]: undefined });
    await expect(
      scheduled({ cron: '17 3 * * *' } as const, env as PruneJobEnv, {
        waitUntil: (_p: Promise<unknown>): void => undefined,
      }),
    ).rejects.toThrow(PruneJobConfigError);
  });

  it('never routes the main path through ctx.waitUntil', async () => {
    // `waitUntil` che một lỗi ra khỏi trạng thái invocation — đường chính phải await
    // trực tiếp. Ghim bằng cách gọi handler với một `ctx.waitUntil` spyOn: nó không
    // được nhận bất kỳ promise nào của đường chính.
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>(
      (_p: Promise<unknown>): void => undefined,
    );
    const env = makeEnv({ [DB_AUTH_BINDING]: undefined });
    await expect(
      scheduled({ cron: '17 3 * * *' } as const, env as PruneJobEnv, { waitUntil }),
    ).rejects.toThrow(PruneJobConfigError);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
