import { createApp, toWebHandler } from 'h3';
import { describe, expect, it } from 'vitest';

import catchAll from './[...path]';
import apiIndex from './index';
import { apiNotFound } from '../utils/api-not-found';

/**
 * Hợp đồng **response** của route bắt `/api/**` không tồn tại: status 404,
 * content-type JSON, body ổn định và không bao giờ là SPA shell.
 *
 * Ở đây handler được gắn làm middleware của một h3 app trần, nên mọi request
 * đều chạm nó. Đó là chủ ý: **việc path nào dẫn vào handler là của router
 * Nitro**, và chỉ runtime thật mới chứng minh được — suite
 * `tests/integrations/worker-runtime.spec.ts` làm đúng điều đó bằng workerd.
 * Dựng lại bảng route của Nitro trong unit test chỉ tạo một bản sao có thể lệch
 * khỏi router thật rồi xanh vì lý do sai.
 *
 * ⚠️ Phạm vi của assertion cuối: h3 trần trả JSON cho `createError`, nên khẳng
 * định đó **không** bắt được một refactor sang `createError`. Chỉ middleware
 * lỗi của Nitro/Nuxt mới đổi hình dạng theo `Accept` header (bỏ qua error
 * renderer khi request trông giống JSON), và điều đó chỉ lộ ra trên runtime
 * thật — suite workerd mới là chỗ ghim nó.
 */
const webHandler = toWebHandler(createApp().use(apiNotFound));

interface Result {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

async function get(path: string): Promise<Result> {
  const response = await webHandler(new Request(`http://localhost${path}`));

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

describe('api-not-found handler', () => {
  it.each(['/api/anything', '/api/nested/deep', '/api/', '/api'])(
    'answers %s with JSON 404',
    async (path) => {
      const result = await get(path);

      expect(result.status).toBe(404);
      expect(result.contentType).toContain('application/json');
      expect(JSON.parse(result.body)).toEqual({
        statusCode: 404,
        statusMessage: 'Not Found',
      });
    },
  );

  it('never answers with the SPA shell', async () => {
    const result = await get('/api/anything');

    expect(result.body).not.toContain('<!DOCTYPE');
  });

  it('is the handler behind both entry points', () => {
    // `/api` và `/api/<path>` cần hai file route (catch-all của Nitro không phủ
    // tiền tố trần), nhưng chúng phải cùng một handler — lệch nhau là hai hình
    // dạng 404 cho cùng một namespace.
    expect(catchAll).toBe(apiNotFound);
    expect(apiIndex).toBe(apiNotFound);
  });
});
