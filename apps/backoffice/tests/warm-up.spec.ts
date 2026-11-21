import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CI_WARM_UP_CAP_MS,
  WARM_UP_CAP_MS,
  WARM_UP_MIN_WAIT_MS,
  gotoWithReloadRetry,
  isNavigationAborted,
  isNavigationCanceledByAnother,
  remainingWarmUpMs,
  warmUpCapMs,
} from './browser/support/warm-up';
import { waitForRouteReady } from './browser/support/prototype';

/**
 * Unit test cho `gotoWithReloadRetry` — logic retry navigation của warm-up
 * browser suite (nay ở `tests/browser/`, xem #182: dời từ `e2e/` sang
 * `tests/browser/` và gắn target `test-integration`).
 *
 * Flake này không tái hiện deterministic được (đó chính là bản chất của nó), nên
 * verification là **mô phỏng**: thay `Page` thật bằng một fake chỉ có `goto`, và
 * thay `Date.now` bằng đồng hồ tay để test không phụ thuộc thời gian thực.
 */

/** Fake `goto` theo kịch bản: mỗi lần gọi lấy một kết quả tiếp theo trong danh sách. */
function fakeGoto(results: Array<() => Promise<unknown>>): {
  goto: () => Promise<unknown>;
  calls: () => number;
} {
  let index = 0;

  const goto = (): Promise<unknown> => {
    const step = results[Math.min(index, results.length - 1)];
    index += 1;
    return step();
  };

  return { goto, calls: () => index };
}

/** Lỗi mà `page.goto` ném khi `full-reload` huỷ navigation đang bay. */
function abortedError(): Error {
  return new Error(
    'page.goto: net::ERR_ABORTED: navigation to "http://127.0.0.1:4311/staff" was canceled by another one',
  );
}

/** Lỗi thật (không phải abort do reload): network sập giữa navigation. */
function netError(): Error {
  return new Error('page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:4311/staff');
}

/** Abort ở dạng "frame bị tháo" — race warm-up chưa được đo, run 44900808358. */
function detachedError(): Error {
  return new Error('page.goto: net::ERR_ABORTED; maybe frame was detached?');
}

/** Cùng dạng frame-detached nhưng tại `page.reload`. */
function detachedReloadError(): Error {
  return new Error('page.reload: net::ERR_ABORTED; maybe frame was detached?');
}

/** Abort ở dạng "huỷ bởi navigation khác" — race đã đo, deadline-bounded. */
function canceledReloadError(): Error {
  return new Error(
    'page.reload: net::ERR_ABORTED: navigation to "http://x/" was canceled by another one',
  );
}

/**
 * Fake `Page` đủ mặt cho `waitForRouteReady`: locator `getByTestId` với kịch bản
 * từng lượt chờ ("visible" resolve ngay, "timeout" ném TimeoutError sau một lát),
 * và `reload` với kịch bản từng lượt tương tự.
 */
function fakePage(options: {
  readonly reloads: Array<() => Promise<unknown>>;
  readonly waitForOutcomes: Array<'visible' | 'timeout'>;
}): { page: never; reloadCalls: () => number } {
  let reloadIndex = 0;
  let waitForIndex = 0;

  const page = {
    getByTestId: () => ({
      waitFor: () => {
        const outcome =
          options.waitForOutcomes[Math.min(waitForIndex, options.waitForOutcomes.length - 1)];
        waitForIndex += 1;

        if (outcome === 'visible') {
          return Promise.resolve();
        }

        return new Promise((_resolve, reject) => {
          setTimeout(() => {
            const error = new Error('Timeout 3000ms exceeded');
            error.name = 'TimeoutError';
            reject(error);
          }, 1_000);
        });
      },
    }),
    reload: () => {
      const step = options.reloads[Math.min(reloadIndex, options.reloads.length - 1)];
      reloadIndex += 1;
      return step();
    },
  };

  return { page: page as never, reloadCalls: () => reloadIndex };
}

/** Đồng hồ tay: bắt đầu ở 0, `advance` để giả thời gian trôi. */
function fakeClock() {
  let current = 0;
  return {
    now: (): number => current,
    advance: (ms: number): void => {
      current += ms;
    },
  };
}

describe('gotoWithReloadRetry', () => {
  it('resolves when navigation succeeds on the first attempt', async () => {
    const calls = fakeGoto([async () => 'response-1']);
    const page = { goto: calls.goto } as never;
    const clock = fakeClock();

    const response = await gotoWithReloadRetry(page, '/staff', { now: clock.now });

    expect(response).toBe('response-1');
    expect(calls.calls()).toBe(1);
  });

  it('retries and recovers when full-reload aborts the first navigation', async () => {
    const calls = fakeGoto([
      async () => {
        throw abortedError();
      },
      async () => 'response-2',
    ]);
    const page = { goto: calls.goto } as never;
    const clock = fakeClock();

    const response = await gotoWithReloadRetry(page, '/staff', { now: clock.now });

    expect(response).toBe('response-2');
    expect(calls.calls()).toBe(2);
  });

  it('recovers from two consecutive aborted navigations', async () => {
    const calls = fakeGoto([
      async () => {
        throw abortedError();
      },
      async () => {
        throw abortedError();
      },
      async () => 'response-3',
    ]);
    const page = { goto: calls.goto } as never;
    // Cũng giả thời gian trôi qua từng attempt: đây là hành vi thật của
    // `page.goto` (async, mất thời gian thật), và là điều kiện để chuỗi retry
    // kết thúc được nếu mọi attempt đều abort — xem test deadline bên dưới.
    const clock = fakeClock();
    clock.advance(1);

    const response = await gotoWithReloadRetry(page, '/staff', { now: clock.now });

    expect(response).toBe('response-3');
    expect(calls.calls()).toBe(3);
  });

  it('fails with a clear reason when every navigation stays aborted past the deadline', async () => {
    const clock = fakeClock();
    const calls = fakeGoto([
      // Mỗi lần abort tiêu tốn thời gian thực (60 ms): nếu đồng hồ đứng yên thì
      // deadline không bao giờ tới, và vòng retry synchronous của fake sẽ quay
      // vô hạn - khoá luôn worker vitest. `page.goto` thật là async nên event
      // loop luôn được yield, và thời gian thật trôi qua từng lần retry; fake
      // phải mô phỏng đúng điều đó.
      async () => {
        clock.advance(60);
        throw abortedError();
      },
    ]);
    const page = { goto: calls.goto } as never;

    const promise = gotoWithReloadRetry(page, '/staff', { now: clock.now, capMs: 100 });

    await expect(promise).rejects.toThrow(/bị huỷ liên tục.*full-reload/u);

    // Attempt 1 t=60: abort, 60 < 100 -> retry. Attempt 2 t=120: abort,
    // 120 >= 100 -> ném lỗi rõ ràng. Hai attempt, không Attempt 3.
    expect(calls.calls()).toBe(2);
  });

  it('rethrows non-abort errors immediately without retrying', async () => {
    const calls = fakeGoto([
      async () => {
        throw netError();
      },
      async () => 'should-not-be-reached',
    ]);
    const page = { goto: calls.goto } as never;
    const clock = fakeClock();

    await expect(gotoWithReloadRetry(page, '/staff', { now: clock.now })).rejects.toThrow(
      'net::ERR_CONNECTION_REFUSED',
    );
    expect(calls.calls()).toBe(1);
  });

  it('retries goto when the abort reads "maybe frame was detached"', async () => {
    const calls = fakeGoto([
      async () => {
        throw detachedError();
      },
      async () => 'response-detached',
    ]);
    const page = { goto: calls.goto } as never;
    const clock = fakeClock();

    const response = await gotoWithReloadRetry(page, '/staff', { now: clock.now });

    expect(response).toBe('response-detached');
    expect(calls.calls()).toBe(2);
  });

  it('recognizes a wrapped "Execution context was destroyed" through the cause chain', () => {
    const wrapped = new Error(
      'page.evaluate: Execution context was destroyed, most likely because of a navigation',
    );
    const top = new Error('Failed to warm up route', { cause: wrapped });

    expect(isNavigationAborted(top)).toBe(true);
    expect(isNavigationAborted(wrapped)).toBe(true);
    expect(isNavigationAborted(new Error('something else entirely'))).toBe(false);
  });

  it('recognizes "Failed to fetch dynamically imported module" as a warm-up race', () => {
    const loaderError = new Error(
      'Failed to fetch dynamically imported module: http://127.0.0.1:4311/_nuxt/node_modules/nuxt/dist/app/entry.js',
    );

    expect(isNavigationAborted(loaderError)).toBe(true);
  });

  it('keeps the original canceled-by-another-one form as the measured, deadline-bounded race', () => {
    const error = abortedError();

    expect(isNavigationAborted(error)).toBe(true);
    expect(isNavigationCanceledByAnother(error)).toBe(true);
    expect(
      isNavigationCanceledByAnother(
        new Error('page.goto: net::ERR_ABORTED; maybe frame was detached?'),
      ),
    ).toBe(false);
  });
});

describe('remainingWarmUpMs', () => {
  it('returns the whole cap before any time has elapsed', () => {
    const clock = fakeClock();

    expect(remainingWarmUpMs({ capMs: 30_000, phaseStart: 0, stage: '/', now: clock.now })).toBe(
      30_000,
    );
  });

  it('returns the remaining slice while more than the floor is left', () => {
    const clock = fakeClock();
    clock.advance(5_000);

    expect(remainingWarmUpMs({ capMs: 30_000, phaseStart: 0, stage: '/', now: clock.now })).toBe(
      25_000,
    );
  });

  it('floors a nearly exhausted budget instead of returning a 1 ms wait', () => {
    const clock = fakeClock();
    clock.advance(29_500);

    expect(remainingWarmUpMs({ capMs: 30_000, phaseStart: 0, stage: '/', now: clock.now })).toBe(
      WARM_UP_MIN_WAIT_MS,
    );
  });

  it('throws a clear budget-exhausted error once the cap is spent', () => {
    const clock = fakeClock();
    clock.advance(30_000);

    expect(() =>
      remainingWarmUpMs({
        capMs: 30_000,
        phaseStart: 0,
        stage: '/staff ready',
        now: clock.now,
      }),
    ).toThrow(/budget exhausted after 30000 ms \(cap 30000 ms\) at \/staff ready/u);
  });
});

describe('warmUpCapMs', () => {
  it('selects the local cap outside CI', () => {
    expect(warmUpCapMs(false)).toBe(WARM_UP_CAP_MS);
  });

  it('selects the CI cap in CI', () => {
    expect(warmUpCapMs(true)).toBe(CI_WARM_UP_CAP_MS);
  });
});

describe('waitForRouteReady bounded race retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reloads once and recovers when the reload race reads "frame was detached"', async () => {
    vi.useFakeTimers();
    const { page, reloadCalls } = fakePage({
      reloads: [
        async () => {
          throw detachedReloadError();
        },
        async () => undefined,
      ],
      waitForOutcomes: ['timeout', 'visible'],
    });
    const promise = waitForRouteReady(page, '/', 30_000);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
    // Sau retry, lượt waitFor kế tiếp resolve thành công nên chỉ đúng một reload.
    expect(reloadCalls()).toBe(1);
  });

  it('throws after the single bounded retry when the unrecognized race repeats', async () => {
    vi.useFakeTimers();
    const { page, reloadCalls } = fakePage({
      reloads: [
        async () => {
          throw detachedReloadError();
        },
      ],
      waitForOutcomes: ['timeout'],
    });
    const promise = waitForRouteReady(page, '/', 30_000);
    // Gắn handler trước khi chạy timers: rejection xảy ra trong lúc timers chạy,
    // nếu không có handler trước đó sẽ thành unhandled rejection.
    const outcome = promise.then(
      () => 'resolved',
      (error: Error) => error,
    );
    await vi.runAllTimersAsync();

    // Một lần reload thử lại + đúng một retry, lần thứ hai ném.
    expect(reloadCalls()).toBe(2);
    const error = (await outcome) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/hết lượt retry/u);
  });

  it('keeps the deadline-bounded retry for the measured canceled-by-another race', async () => {
    vi.useFakeTimers();
    const { page, reloadCalls } = fakePage({
      reloads: [
        async () => {
          throw canceledReloadError();
        },
        async () => {
          throw canceledReloadError();
        },
        async () => undefined,
      ],
      waitForOutcomes: ['timeout', 'timeout', 'visible'],
    });
    const promise = waitForRouteReady(page, '/', 30_000);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBeUndefined();
    // Dạng gốc không tốn lượt retry có giới hạn: hai lần race đều được
    // deadline-bounded tiếp nhận rồi lượt waitFor kế tiếp resolve — hai reload.
    expect(reloadCalls()).toBe(2);
  });
});
