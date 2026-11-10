import { createApp, toWebHandler } from 'h3';
import { describe, expect, it } from 'vitest';

import catchAll from '../api/[...path]';
import apiIndex from '../api/index';
import { apiNotFound } from '../utils/api-not-found';

/**
 * Hợp đồng **response** của route bắt `/api/**` không tồn tại: status 404,
 * content-type JSON, body ổn định và không bao giờ là SPA shell.
 *
 * Ở đây handler được gắn làm middleware của một h3 app trần, nên mọi request đều
 * chạm nó. Đó là chủ ý: **việc path nào dẫn vào handler là của router Nitro**, và
 * chỉ runtime thật mới chứng minh được — suite
 * `tests/integrations/worker-runtime.spec.ts` làm đúng điều đó bằng workerd.
 * Dựng lại bảng route của Nitro trong unit test chỉ tạo một bản sao có thể lệch
 * khỏi router thật rồi xanh vì lý do sai.
 *
 * ⚠️ Vì sao không `createError`: lỗi của h3 đi qua error renderer của Nuxt và
 * trả trang HTML. Khẳng định `not.toContain('<!DOCTYPE')` làm một refactor sang
 * `createError` đỏ ngay tại đây.
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
