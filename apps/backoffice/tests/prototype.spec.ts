import { describe, expect, it } from 'vitest';

import { waitForRouteReady } from './browser/support/prototype';

/**
 * Trang giả: `getByTestId` trả locator có `waitFor` tuỳ chọn;
 * `reload()` tuỳ chọn bị giả xử lý.
 */
type FakeLocator = {
  waitFor: (options: { readonly state: string; readonly timeout: number }) => Promise<void>;
};

type FakePage = {
  getByTestId: (testId: string) => FakeLocator;
  reload: (options: { readonly waitUntil: string }) => Promise<void>;
  url: () => string;
};

/** Tạo trang giả có thể lập trình: lần nth `waitFor` thành công hay ném. */
function fakePage(
  waitForOutcome: (() => Promise<void>)[] = [],
  reloadCalls: Array<{ waitUntil: string }> = [],
): FakePage {
  let callIndex = 0;
  const locator: FakeLocator = {
    waitFor: async (options) => {
      const outcome = waitForOutcome[callIndex];
      callIndex += 1;
      if (outcome === undefined) {
        throw new Error(`Timeout ${options.timeout}ms exceeded`);
      }
      await outcome();
    },
  };

  const page: FakePage = {
    getByTestId: () => locator,
    reload: async (options) => {
      reloadCalls.push(options);
    },
    url: () => 'http://127.0.0.1:4311/',
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

  it('ném lỗi nếu phần tử chưa xuất hiện và hết trần, chỉ reload tối đa một lần', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage(
      [
        async () => {
          throw new Error('Timeout 3000ms exceeded');
        },
      ],
      reloadCalls,
    );

    await expect(waitForRouteReady(page, '/', 1_000)).rejects.toThrow('Timeout 3000ms exceeded');
    expect(reloadCalls).toHaveLength(1);
  });

  it('reload một lần khi lần chờ đầu hết trần, rồi chờ tiếp', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage(
      [
        async () => {
          throw new Error('Timeout 3000ms exceeded');
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
          throw new Error('Timeout 3000ms exceeded');
        },
        async () => {
          throw new Error('Timeout 3000ms exceeded');
        },
      ],
      reloadCalls,
    );

    await expect(waitForRouteReady(page, '/', 1_000)).rejects.toThrow('Timeout 3000ms exceeded');
    expect(reloadCalls).toHaveLength(1);
  });

  it('không reload nếu đã reload rồi và lần chờ tiếp theo cũng hết trần', async () => {
    const reloadCalls: Array<{ waitUntil: string }> = [];
    const page = fakePage(
      [
        async () => {
          throw new Error('Timeout 3000ms exceeded');
        },
        async () => {
          throw new Error('Timeout 3000ms exceeded');
        },
      ],
      reloadCalls,
    );

    await expect(waitForRouteReady(page, '/', 1_000)).rejects.toThrow('Timeout 3000ms exceeded');
    expect(reloadCalls).toHaveLength(1);
  });

  it('trần cạn thì ném timeout đúng trần gọi', async () => {
    const page = fakePage([
      async () => {
        throw new Error('Timeout 500ms exceeded');
      },
    ]);

    await expect(waitForRouteReady(page, '/', 500)).rejects.toThrow('Timeout 500ms exceeded');
  });
});
