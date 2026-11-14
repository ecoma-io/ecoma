import { EventEmitter } from 'node:events';

import type { Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import {
  describeBrowserSession,
  summarizeBrowserSession,
  watchBrowserSession,
  type PageSnapshot,
} from './browser/support/diagnostics';

/**
 * Unit test cho instrumentation chẩn đoán của vế warm-up browser (issue #253).
 *
 * Instrumentation này là thứ biến một lần đỏ không giải thích được thành bằng
 * chứng đọc được, nên phần logic phải kiểm được mà không cần Playwright thật:
 * thay `Page` bằng một `EventEmitter` và một snapshot tĩnh, giữ nguyên hình dạng
 * dữ liệu mà Playwright phát ra.
 */

type FakePageOptions = {
  readonly content?: () => Promise<string>;
  readonly evaluate?: (...args: unknown[]) => Promise<PageSnapshot>;
};

/**
 * `Page` giả: chỉ có đúng ba thành viên mà instrumentation dùng, và phát sự kiện
 * qua `EventEmitter` như Playwright.
 *
 * Kiểu hẹp cố ý: nếu instrumentation cần thêm thành viên `Page`, kiểu của
 * `watchBrowserSession`/`describeBrowserSession` đổi theo và lời gọi trong spec
 * này đỏ ngay khi biên dịch, thay vì lọt tới lỗi runtime.
 */
type FakePage = Pick<Page, 'on' | 'content' | 'evaluate'>;

function fakePage(options: FakePageOptions = {}): {
  page: FakePage;
  emit: (event: string, payload: unknown) => void;
} {
  const emitter = new EventEmitter();
  const page = {
    on(event: string, listener: (...args: unknown[]) => void) {
      emitter.on(event, listener);
      return page;
    },
    content: options.content ?? (async () => '<html><body><div id="__nuxt"></div></body></html>'),
    evaluate: options.evaluate ?? (async () => snapshot()),
  };

  return {
    page: page as unknown as FakePage,
    emit: (event, payload) => {
      emitter.emit(event, payload);
    },
  };
}

/** Snapshot mặc định: app non-SSR chưa mount, data mode đọc được là prototype. */
function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'http://127.0.0.1:4311/',
    title: 'Backoffice',
    readyState: 'complete',
    nuxtRootPresent: true,
    nuxtRootChildren: 0,
    nuxtRootHtmlLength: 0,
    noticeInDom: false,
    dataMode: '"prototype"',
    bodyExcerpt: '<div id="__nuxt"></div>',
    ...overrides,
  };
}

/** Một `ConsoleMessage` giả. */
function consoleMessage(type: string, text: string) {
  return { type: () => type, text: () => text };
}

/** Một `Response` giả; request kèm theo có đủ method/URL/resourceType. */
function response(status: number, resourceType: string, url = 'http://127.0.0.1:4311/') {
  return {
    status: () => status,
    request: () => ({
      method: () => 'GET',
      url: () => url,
      resourceType: () => resourceType,
    }),
  };
}

describe('watchBrowserSession', () => {
  it('collapses repeated console messages into one entry with a count', () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);

    for (let index = 0; index < 3; index += 1) {
      emit('console', consoleMessage('warning', 'reloading page'));
    }

    expect(log.consoleKinds.size).toBe(1);
    expect([...log.consoleKinds.values()][0]).toMatchObject({
      type: 'warning',
      text: 'reloading page',
      count: 3,
    });
  });

  it('keeps separate entries for different console text', () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);

    emit('console', consoleMessage('log', 'first'));
    emit('console', consoleMessage('log', 'second'));

    expect(log.consoleKinds.size).toBe(2);
  });

  it('records failed responses with their status and ignores successful ones', () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);

    emit('response', response(500, 'fetch', 'http://127.0.0.1:4311/api/staff'));
    emit('response', response(200, 'fetch', 'http://127.0.0.1:4311/api/roles'));

    expect(log.failedRequests.size).toBe(1);
    expect([...log.failedRequests.values()][0]).toMatchObject({
      method: 'GET',
      url: 'http://127.0.0.1:4311/api/staff',
      status: 500,
    });
  });

  it('counts document requests separately from other responses', () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);

    emit('response', response(200, 'document', 'http://127.0.0.1:4311/'));
    emit('response', response(200, 'document', 'http://127.0.0.1:4311/'));
    emit('response', response(200, 'script', 'http://127.0.0.1:4311/_nuxt/entry.js'));

    expect(log.documentRequestCount).toBe(2);
    expect(log.documentRequests).toHaveLength(2);
    expect(log.documentRequests[0]).toMatchObject({ url: 'http://127.0.0.1:4311/', status: 200 });
  });

  it('records page errors and request failures', () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);

    emit('pageerror', new TypeError('__NUXT__ is undefined'));
    emit('requestfailed', {
      method: () => 'GET',
      url: () => 'http://127.0.0.1:4311/_nuxt/client.js',
      failure: () => ({ errorText: 'net::ERR_ABORTED' }),
    });

    expect(log.pageErrors).toHaveLength(1);
    expect(log.pageErrors[0]).toBe('TypeError: __NUXT__ is undefined');
    expect(log.failedRequests.size).toBe(1);
    expect([...log.failedRequests.values()][0]).toMatchObject({
      url: 'http://127.0.0.1:4311/_nuxt/client.js',
      failure: 'net::ERR_ABORTED',
    });
  });

  it('records both the first and the last occurrence of a repeated failed request', () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page, 0);

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000);
    now.mockReturnValueOnce(4_234);
    emit('response', response(500, 'fetch', 'http://127.0.0.1:4311/api/staff'));
    emit('response', response(500, 'fetch', 'http://127.0.0.1:4311/api/staff'));
    now.mockRestore();

    const entry = [...log.failedRequests.values()][0];
    expect(entry.count).toBe(2);
    expect(entry.firstAtMs).toBe(1_000);
    expect(entry.lastAtMs).toBe(4_234);
  });

  it('caps the number of retained console kinds', () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);

    for (let index = 0; index < 45; index += 1) {
      emit('console', consoleMessage('log', `message ${String(index)}`));
    }

    expect(log.consoleKinds.size).toBe(40);
  });

  it('truncates long console messages', () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);

    emit('console', consoleMessage('error', 'x'.repeat(2_000)));

    const entry = [...log.consoleKinds.values()][0];
    expect(entry.text.length).toBeLessThanOrEqual(400);
    expect(entry.text.endsWith('...')).toBe(true);
  });
});

describe('describeBrowserSession', () => {
  it('reports the client data mode and whether the notice is in the rendered DOM', async () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);
    emit('console', consoleMessage('warning', 'reloading page'));

    const report = await describeBrowserSession(page, log, { capMs: 120_000 });

    expect(report).toContain(
      'data mode (window.__NUXT__.config.public.backofficeDataMode): "prototype"',
    );
    expect(report).toContain('notice in rendered DOM: absent');
    expect(report).toContain('notice in page.content() (server HTML): absent');
    expect(report).toContain('console messages: 1 distinct');
    expect(report).toContain('[warning]');
  });

  it('reports the notice as present when the app already rendered it', async () => {
    const { page } = fakePage({
      evaluate: async () =>
        snapshot({ noticeInDom: true, nuxtRootChildren: 1, nuxtRootHtmlLength: 120 }),
      content: async () =>
        '<html><body><p data-testid="backoffice-sample-notice">sample</p></body></html>',
    });
    const log = watchBrowserSession(page);

    const report = await describeBrowserSession(page, log, { capMs: 120_000 });

    expect(report).toContain('notice in rendered DOM: present');
    expect(report).toContain('notice in page.content() (server HTML): present');
  });

  it('reports an absent data mode distinctly from a wrong one', async () => {
    const { page } = fakePage({ evaluate: async () => snapshot({ dataMode: null }) });
    const log = watchBrowserSession(page);

    const report = await describeBrowserSession(page, log, { capMs: 120_000 });

    expect(report).toContain('backofficeDataMode): absent');
  });

  it('includes document requests and failed requests as evidence', async () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);
    emit('response', response(200, 'document', 'http://127.0.0.1:4311/'));
    emit('response', response(200, 'document', 'http://127.0.0.1:4311/'));
    emit('response', response(503, 'fetch', 'http://127.0.0.1:4311/api/staff'));

    const report = await describeBrowserSession(page, log, { capMs: 120_000 });

    expect(report).toContain('document requests: 2');
    expect(report).toContain('HTTP 503');
    expect(report).toContain('failed requests: 1 distinct');
  });

  it('still reports collected events when the page cannot be read', async () => {
    const { page, emit } = fakePage({
      evaluate: async () => {
        throw new Error('Execution context was destroyed');
      },
      content: async () => {
        throw new Error('Target page, context or browser has been closed');
      },
    });
    const log = watchBrowserSession(page);
    emit('pageerror', new RangeError('mount failed'));

    const report = await describeBrowserSession(page, log, { capMs: 120_000 });

    expect(report).toContain('page snapshot unavailable: Error: Execution context was destroyed');
    expect(report).toContain(
      'page.content() unavailable: Error: Target page, context or browser has been closed',
    );
    expect(report).toContain('RangeError: mount failed');
  });

  it('keeps the body excerpt bounded instead of dumping the document', async () => {
    const { page } = fakePage({ evaluate: async () => snapshot({ bodyExcerpt: 'a'.repeat(900) }) });
    const log = watchBrowserSession(page);

    const report = await describeBrowserSession(page, log, { capMs: 120_000 });

    expect(report).toContain(`body excerpt: ${'a'.repeat(900)}`);
    expect(report).not.toContain('a'.repeat(901));
  });

  it('passes the excerpt bound as an argument instead of closing over a module constant', async () => {
    const calls: unknown[][] = [];
    const { page } = fakePage({
      evaluate: async (...args: unknown[]) => {
        calls.push(args);
        return snapshot();
      },
    });
    const log = watchBrowserSession(page);

    await describeBrowserSession(page, log, { capMs: 120_000 });

    // Hàm `evaluate` được serialize và chạy trong browser, nơi hằng số module
    // không tồn tại; trần excerpt phải đi qua đối số thứ hai (lỗi đã thấy trên
    // CI ở lượt chạy đầu của #253).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0][1]).toBe(900);
  });
});

describe('summarizeBrowserSession', () => {
  it('summarizes counts in a single line without event details', () => {
    const { page, emit } = fakePage();
    const log = watchBrowserSession(page);
    emit('console', consoleMessage('warning', 'reloading page'));
    emit('pageerror', new TypeError('boom'));

    const summary = summarizeBrowserSession(log);

    expect(summary).toContain('1 console kinds');
    expect(summary).toContain('1 page errors');
    expect(summary).not.toContain('reloading page');
  });
});
