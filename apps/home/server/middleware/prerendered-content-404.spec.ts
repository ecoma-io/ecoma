import { createApp, defineEventHandler, toWebHandler } from 'h3';
import { describe, expect, it } from 'vitest';

import contentGate from './prerendered-content-404';

/**
 * Unit test của middleware gate content path.
 *
 * Middleware đọc manifest từ virtual module `virtual:prerendered-content-paths`
 * — trong Vitest được alias sang `shared/test-fixtures/prerendered-content-paths.ts`
 * với manifest **rỗng** (xem `vitest.config.mts`). Vì vậy:
 *
 * - Case "manifest rỗng → pass through" test được trực tiếp trên bản thật.
 * - Case "manifest đầy → 404 path lạ, pass path đã prerender" cần manifest
 *   non-empty, nhưng handler đóng trên Set khởi tạo lúc import (không có
 *   seams mutate) và vitest alias là tĩnh. Test được tách thành hai bộ:
 *   bộ trên chạy bản thật với manifest rỗng; hành vi với manifest đầy được
 *   phủ bởi test tích hợp `tests/static-output.spec.ts` (assert manifest
 *   non-empty được nhúng vào server bundle) — hai nửa ghép lại cho cùng
 *   contract.
 *
 * App test dựng giống cấu trúc production: middleware trước, catch-all sau
 * (đóng vai renderer) trả 200 — nhờ đó phân biệt rõ "middleware để đi qua"
 * (catch-all trả 200) với "middleware chặn" (middleware 404 trước catch-all;
 * một h3 app trần không có handler nào sau middleware sẽ trả 404 mặc định,
 * không tách được hai trường hợp).
 */
const catchAll = defineEventHandler(() => 'renderer-reached');

const handler = toWebHandler(createApp().use(contentGate).use(catchAll));

async function getBody(path: string): Promise<{ status: number; text: string }> {
  const response = await handler(new Request(`http://localhost${path}`));
  return { status: response.status, text: await response.text() };
}

describe('server/middleware/prerendered-content-404', () => {
  it('lets every request through to the renderer when the manifest is empty (dev / unit test)', async () => {
    // Manifest trong môi trường test là rỗng — middleware phải skip hoàn toàn,
    // đúng như `nuxt dev` (content query chạy sqlite local, không gate).
    for (const path of [
      '/en/docs/unknown',
      '/vi/blog/not-a-post',
      '/en/blog',
      '/vi/docs',
      '/en/docs/api',
    ]) {
      const res = await getBody(path);
      expect(res.text).toBe('renderer-reached');
    }
  });

  it('does not interfere with paths outside the two content mounts', async () => {
    // Những path này thuộc renderer/validate (locale-root, legal, locale lạ,
    // server route) — gate không được chặn kể cả khi manifest đầy.
    for (const path of ['/', '/en', '/vi', '/en/legal/privacy', '/fr/docs', '/api/greet']) {
      const res = await getBody(path);
      expect(res.text).toBe('renderer-reached');
    }
  });
});
