import type { H3Event } from 'h3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Test middleware qua spy trên `setResponseHeader` thay vì chạy cả server
 * Nitro: middleware là hàm thuần nhận `H3Event`, cách ly này giữ test nhanh
 * và không phụ thuộc build Nuxt.
 *
 * `useRuntimeConfig` là auto-import của Nitro runtime — trong test, global
 * này bị stub để mô phỏng runtime config mà `applyEnv` đã áp env var.
 */

/**
 * Import động sau `vi.doMock` (gọi trong `beforeEach`) — luôn lấy bản
 * middleware mới với mock đang hiệu lực.
 */
async function loadMiddleware(): Promise<(event: H3Event) => void> {
  const mod = await import('./no-index');
  return (mod as { default: (event: H3Event) => void }).default;
}

describe('no-index middleware', () => {
  let setHeaderSpy: ReturnType<typeof vi.fn>;
  let noIndexValue: boolean | string;
  const fakeEvent = {} as H3Event;

  beforeEach(async () => {
    setHeaderSpy = vi.fn<(event: H3Event, name: string, value: string) => void>();
    vi.doMock('h3', async (importOriginal) => ({
      ...(await importOriginal<typeof import('h3')>()),
      setResponseHeader: setHeaderSpy,
    }));
    // Xoá cache để `vi.doMock` có hiệu lực với import động phía dưới.
    vi.resetModules();
    // Stub auto-import `useRuntimeConfig` thành global trước khi import
    // module — middleware gọi nó như một định nghĩa tự do (Nitro inject).
    (globalThis as { useRuntimeConfig?: unknown }).useRuntimeConfig = () => ({
      public: { noIndex: noIndexValue },
    });
  });

  afterEach(() => {
    vi.doUnmock('h3');
    vi.resetModules();
    vi.restoreAllMocks();
    delete (globalThis as { useRuntimeConfig?: unknown }).useRuntimeConfig;
  });

  it('sets the X-Robots-Tag: noindex header when the flag is on', async () => {
    noIndexValue = true;
    const middleware = await loadMiddleware();
    middleware(fakeEvent);
    expect(setHeaderSpy).toHaveBeenCalledWith(fakeEvent, 'X-Robots-Tag', 'noindex');
  });

  it('sets no header when the flag is off (production default)', async () => {
    noIndexValue = false;
    const middleware = await loadMiddleware();
    middleware(fakeEvent);
    expect(setHeaderSpy).not.toHaveBeenCalled();
  });

  it('sets no header when the flag is not strictly boolean true (fail-safe)', async () => {
    noIndexValue = 'true';
    const middleware = await loadMiddleware();
    middleware(fakeEvent);
    expect(setHeaderSpy).not.toHaveBeenCalled();
  });
});
