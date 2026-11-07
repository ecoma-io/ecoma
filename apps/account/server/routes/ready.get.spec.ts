import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import readyHandler from './ready.get';
import { writeLog } from '../utils/logger';

/**
 * Test `/ready` ở đúng hai điểm nó có thể sai âm thầm mà không unit test nào bắt:
 *
 * 1. `useRuntimeConfig()` phải nhận `event` — trên Workers preset, binding của
 *    request đến từ env và Nitro nối vào runtime config **theo event**; bỏ event
 *    là đọc config không gắn với request hiện tại (đúng hình dạng cũ mà review
 *    bắt được). Không test này thì mutation về `useRuntimeConfig()` không red
 *    test nào.
 * 2. Thiếu binding ⇒ 503 fail closed — không phải "sẵn sàng một phần".
 *
 * ⚠️ Test cố tình đi nhánh **thiếu binding** để không mở pool: nhánh đó cắt
 * `probeDatabase` trước khi chạm DB, nên unit test không cần container.
 */

vi.mock('../utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));

const mockedWriteLog = vi.mocked(writeLog);

describe('GET /ready', () => {
  let handler: WebHandler;
  /** Ghi lại argument mà handler truyền cho `useRuntimeConfig`. */
  let capturedRuntimeConfigArg: unknown;

  beforeAll(() => {
    const app = createApp();
    const router = createRouter();
    router.get('/ready', readyHandler);
    app.use(router.handler);
    handler = toWebHandler(app);
  });

  beforeEach(() => {
    capturedRuntimeConfigArg = undefined;
    // Auto-import của Nitro, không tồn tại ngoài runtime — stub bằng hàm ghi
    // lại argument. Trả config **không có binding**: nhánh này fail closed 503
    // trước khi `probeDatabase` mở pool, nên test không đụng DB thật.
    vi.stubGlobal('useRuntimeConfig', (event?: unknown): Record<string, unknown> => {
      capturedRuntimeConfigArg = event;
      return {};
    });
    mockedWriteLog.mockClear();
  });

  it('reads runtime config through the request event, not a bare global', async () => {
    // `accountHyperdrive(useRuntimeConfig())` (không truyền event) là mutation
    // cần bắt: trên Workers, binding nằm trong runtime config gắn với event —
    // gọi không event đọc nhầm config request. Assert argument là H3Event thật
    // (có `path`), không phải `undefined`.
    const response = await handler(new Request('http://localhost/ready'));

    // Config không có binding ⇒ 503 fail closed — đúng hợp đồng của route.
    expect(response.status).toBe(503);
    // Điều test này thực sự bảo vệ: `useRuntimeConfig` được gọi VỚI event.
    expect(capturedRuntimeConfigArg).toBeDefined();
    expect(capturedRuntimeConfigArg).toHaveProperty('path', '/ready');
  });

  it('fails closed with 503 when the Hyperdrive binding is absent', async () => {
    const response = await handler(new Request('http://localhost/ready'));

    expect(response.status).toBe(503);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ready.failed', status: 503, reason: 'binding_missing' }),
    );
  });

  it('fails closed with the stable data mode reason when an artifact is configured for mock', async () => {
    // Gate DATA_MODE ở lớp readiness: artifact bị cấu hình `mock` là cấu hình
    // sai phải chặn — `/ready` 503 với reason ổn định, không nuốt về `real`
    // trong im lặng. Stub trả public.accountDataMode = 'mock'; `import.meta.dev`
    // của runner test là `undefined` — cùng nhánh artifact với production,
    // vì Nitro thay tĩnh cờ này theo `nitro.options.dev` lúc build thật.
    vi.stubGlobal('useRuntimeConfig', (event?: unknown): Record<string, unknown> => {
      capturedRuntimeConfigArg = event;
      return { public: { accountDataMode: 'mock' } };
    });

    const response = await handler(new Request('http://localhost/ready'));

    expect(response.status).toBe(503);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ready.failed',
        status: 503,
        reason: 'data_mode_mock_in_artifact',
      }),
    );
  });
});
