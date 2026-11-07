import { describe, expect, it } from 'vitest';

import { gotoWithReloadRetry } from '../e2e/support/warm-up';

/**
 * Unit test cho `gotoWithReloadRetry` — logic retry navigation của warm-up e2e.
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
});
