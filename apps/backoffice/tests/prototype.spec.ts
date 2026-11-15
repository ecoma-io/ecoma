import { describe, expect, it } from 'vitest';

import { waitForRouteReady } from './browser/support/prototype';

/**
 * Trang giả: `getByTestId` trả locator có `waitFor` tuỳ chọn; `reload()` tuỳ
 * chọn bị giả xử lý.
 *
 * ⚠️ Mỗi lần `waitFor` bị giả phải tiêu tốn thời gian thực (`setTimeout` 1 ms
 * trước khi kết quả): vòng lặp trong `waitForRouteReady` đọc `Date.now()` để
 * kiểm trần, một giả ném lập tức sẽ biến vòng lặp thành busy-spin vô hạn — test
 * không bao giờ kết thúc bằng lỗi thiết kế mà chỉ chờ vitest timeout.
 */
type FakeLocator = {
  waitFor: (options: { readonly state: string; readonly timeout: number }) => Promise<void>;
};

type FakePage = {
  getByTestId: (testId: string) => FakeLocator;
  reload: (options: { readonly waitUntil: string }) => Promise<void>;
};

/**
 * Lỗi timeout đúng hình dạng Playwright phát ra khi hết trần một lần chờ:
 * `name` là `TimeoutError`, thông điệp mang đúng trần của lượt chờ.
 */
function timeoutError(ms: number): Error {
  const error = new Error(`Timeout ${String(ms)}ms exceeded`);
  error.name = 'TimeoutError';
  return error;
}

/**
 * Tạo trang giả có thể lập trình: lần nth `waitFor` thành công hay ném.
 *
 * Kết quả mặc định khi danh sách cạn: ném `TimeoutError` — và xác nhận hợp đồng
 * `state: 'visible'` mà triển khai thật truyền vào, để một đổi trạng thái chờ
 * lọt qua là test đỏ.
 */
function fakePage(
  waitForOutcome: (() => Promise<void>)[] = [],
  reloadCalls: Array<{ waitUntil: string }> = [],
): FakePage {
  let callIndex = 0;
  const locator: FakeLocator = {
    waitFor: async (options) => {
      if (options.state !== 'visible') {
        throw new Error(`Unexpected waitFor state: ${String(options.state)}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
      const outcome = waitForOutcome[callIndex];
      callIndex += 1;
      if (outcome === undefined) {
        throw timeoutError(options.timeout);
      }
      await outcome();
    },
  };

  const page: FakePage = {
    getByTestId: () => locator,
    reload: async (options) => {
      reloadCalls.push(options);
    },
  };

  return page;
}

describe('waitForRouteReady', () => {
  it('trả về ngay khi phần tử xuất hiện ở lần chờ đầu', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage(
      [
        async () => {
          // phần tử đã visible
        },
      ],
      reloadCalls,
    );
    await waitForRouteReady(page, '/', 10_000);
    expect(reloadCalls).toHaveLength(0);
  });

  it('ném lỗi nếu route không có tín hiệu ready, không chờ và không reload', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage([], reloadCalls);

    await expect(waitForRouteReady(page, '/nonexistent', 1_000)).rejects.toThrow(
      'Không có tín hiệu ready cho route "/nonexistent".',
    );
    expect(reloadCalls).toHaveLength(0);
  });

  it('ném lỗi gốc ngay nếu lần chờ ném lỗi không phải timeout', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage(
      [
        async () => {
          throw new Error('element is detached');
        },
      ],
      reloadCalls,
    );

    await expect(waitForRouteReady(page, '/', 1_000)).rejects.toThrow('element is detached');
    expect(reloadCalls).toHaveLength(0);
  });

  it('ném lỗi nếu phần tử chưa xuất hiện và hết trần, chỉ reload tối đa một lần', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage(
      [
        async () => {
          throw timeoutError(3_000);
        },
      ],
      reloadCalls,
    );

    await expect(waitForRouteReady(page, '/', 1_000)).rejects.toThrow(/Timeout \d+ms exceeded/u);
    expect(reloadCalls).toHaveLength(1);
  });

  it('reload một lần khi lần chờ đầu hết trần, rồi chờ tiếp', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage(
      [
        async () => {
          throw timeoutError(3_000);
        },
        async () => {
          // phần tử xuất hiện sau reload
        },
      ],
      reloadCalls,
    );

    await waitForRouteReady(page, '/', 5_000);

    expect(reloadCalls).toHaveLength(1);
    expect(reloadCalls[0].waitUntil).toBe('domcontentloaded');
  });

  it('không reload lần hai nếu lần chờ sau reload cũng hết trần', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage(
      [
        async () => {
          throw timeoutError(3_000);
        },
        async () => {
          throw timeoutError(3_000);
        },
      ],
      reloadCalls,
    );

    await expect(waitForRouteReady(page, '/', 1_000)).rejects.toThrow(/Timeout \d+ms exceeded/u);
    expect(reloadCalls).toHaveLength(1);
  });

  it('ném lỗi mới nhất nếu lần chờ sau reload ném lỗi không phải timeout', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage(
      [
        async () => {
          throw timeoutError(3_000);
        },
        async () => {
          throw new Error('frame has been closed');
        },
      ],
      reloadCalls,
    );

    await expect(waitForRouteReady(page, '/', 1_000)).rejects.toThrow('frame has been closed');
    expect(reloadCalls).toHaveLength(1);
  });

  it('trần cạn thì ném timeout đúng trần gọi', async () => {
    const page = fakePage([
      async () => {
        throw timeoutError(500);
      },
    ]);

    await expect(waitForRouteReady(page, '/', 500)).rejects.toThrow(/Timeout \d+ms exceeded/u);
  });
});
