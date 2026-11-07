import { createApp, defineEventHandler, toWebHandler } from 'h3';
import { describe, expect, it, vi } from 'vitest';

import { createPrerenderedContent404Gate } from './prerendered-content-404';

/**
 * Regression test của middleware gate content path với manifest **non-empty**
 * — nửa còn thiếu của contract (bộ trong `prerendered-content-404.spec.ts`
 * chạy bản thật với manifest rỗng; hai nửa ghép lại cho cùng contract, phần
 * giải thích đầy đủ ở docblock của bộ đó).
 *
 * Nguồn manifest: test này **không** dùng vitest alias tĩnh (fixture rỗng
 * của `shared/test-fixtures/prerendered-content-paths.ts`) mà inject trực
 * tiếp qua factory `createPrerenderedContent404Gate` — seam duy nhất của
 * middleware, không mutate state module. Dữ liệu mẫu chép từ manifest thật
 * của build gần nhất (34 path, gồm cả `_payload.json` — hook `prerender:done`
 * giữ mọi route khớp regex mount, cả HTML lẫn payload).
 */
const SAMPLE_MANIFEST: readonly string[] = [
  '/en/blog',
  '/en/blog/_payload.json',
  '/en/blog/static-deployment',
  '/en/blog/static-deployment/_payload.json',
  '/en/blog/url-model',
  '/en/blog/url-model/_payload.json',
  '/en/docs',
  '/en/docs/_payload.json',
  '/en/docs/getting-started',
  '/en/docs/getting-started/installation',
  '/en/docs/getting-started/installation/_payload.json',
  '/vi/blog',
  '/vi/blog/_payload.json',
  '/vi/docs',
  '/vi/docs/getting-started/first-steps',
  '/vi/docs/getting-started/first-steps/_payload.json',
];

/**
 * App test dựng giống cấu trúc production: gate trước, catch-all sau (đóng
 * vai renderer) trả 200. Renderer được spy để assertion phân biệt được hai
 * trường hợp mà status một mình không tách: "middleware để đi qua" (renderer
 * nhận request) với "middleware chặn" (renderer không bao giờ chạy).
 */
function buildApp(manifest: readonly string[]) {
  const renderer = vi.fn<() => string>(() => 'renderer-reached');
  const handler = toWebHandler(
    createApp()
      .use(createPrerenderedContent404Gate(new Set(manifest)))
      .use(defineEventHandler(renderer)),
  );
  return {
    renderer,
    /** Thực hiện GET và trả status + body text. */
    get: async (path: string): Promise<{ status: number; text: string }> => {
      const response = await handler(new Request(`http://localhost${path}`));
      return { status: response.status, text: await response.text() };
    },
  };
}

describe('server/middleware/prerendered-content-404 with a non-empty manifest', () => {
  it('lets prerendered content paths through to the renderer', async () => {
    // Mount root, article HTML và `_payload.json` đều nằm trong manifest thật
    // (hook `prerender:done` giữ mọi route khớp regex mount) — tất cả phải
    // đi qua gate tới renderer.
    const { renderer, get } = buildApp(SAMPLE_MANIFEST);
    for (const path of [
      '/en/docs',
      '/vi/blog',
      '/en/blog/url-model',
      '/en/blog/static-deployment',
      '/vi/docs/getting-started/first-steps',
      '/en/docs/getting-started/installation',
      '/en/blog/url-model/_payload.json',
    ]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.text).toBe('renderer-reached');
    }
    expect(renderer).toHaveBeenCalledTimes(7);
  });

  it('returns 404 without reaching the renderer for unknown content paths', async () => {
    // Path lạ trong mount → middleware 404 ngay (đúng kịch bản production:
    // request không khớp asset nào được invoke Worker, gate chặn trước cả
    // query content); renderer không được gọi.
    const { renderer, get } = buildApp(SAMPLE_MANIFEST);
    for (const path of ['/en/docs/unknown', '/vi/blog/not-a-post']) {
      const res = await get(path);
      expect(res.status).toBe(404);
    }
    expect(renderer).not.toHaveBeenCalled();
  });

  it('returns 404 for the reserved docs/api mount boundary', async () => {
    // `docs/api` là mount reserved (deepest-first trong `PUBLIC_MOUNTS`) cho
    // `api-reference` tương lai: không có content, không có route — không bao
    // giờ nằm trong manifest. `parsePublicLayoutPath` cũng từ chối nó trước
    // query, nhưng gate đứng trước renderer nên ở đây 404 sớm hơn cả validate:
    // mọi depth dưới `/en/docs/api` đều chặn tại middleware.
    const { renderer, get } = buildApp(SAMPLE_MANIFEST);
    for (const path of ['/en/docs/api', '/vi/docs/api', '/en/docs/api/reference']) {
      const res = await get(path);
      expect(res.status).toBe(404);
    }
    expect(renderer).not.toHaveBeenCalled();
  });

  it('does not interfere with paths outside the three content mounts', async () => {
    // Locale-root, locale lạ, server route: không khớp regex mount → đi tiếp
    // renderer (ở production, `validate` topology của route mới là tầng quyết
    // định tiếp theo) — gate không can thiệp kể cả manifest đầy.
    const { renderer, get } = buildApp(SAMPLE_MANIFEST);
    for (const path of ['/', '/en', '/vi', '/fr/docs', '/api/greet']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.text).toBe('renderer-reached');
    }
    expect(renderer).toHaveBeenCalledTimes(5);
  });

  it('serves prerendered legal paths and 404s draft legal paths before the renderer', async () => {
    // Legal mount NẰM TRONG regex mount (cùng docs/blog): path có trong
    // manifest → renderer chạy (HTML prerendered trả như thường); path vắng
    // (draft ở production build — không bao giờ vào manifest) → gate 404
    // TRƯỚC renderer, không query content. Đây là access control thật của
    // draft, không phải UI filter.
    const { renderer, get } = buildApp([
      ...SAMPLE_MANIFEST,
      '/en/legal',
      '/en/legal/privacy',
      '/en/legal/privacy/_payload.json',
    ]);
    const prerendered = await get('/en/legal/privacy');
    expect(prerendered.status).toBe(200);
    expect(renderer).toHaveBeenCalledTimes(1);
    const draft = await get('/en/legal/platform-terms-of-service');
    expect(draft.status).toBe(404);
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('matches the mount regex on segment boundaries, not string prefixes', async () => {
    // Regex mount neo `(/|$)`: `/en/docsary` không phải path trong mount
    // `docs` — nếu regex so prefix trần thì path này bị nuốt vào gate và 404
    // nhầm; đúng hành vi là đi tiếp renderer.
    const { renderer, get } = buildApp(SAMPLE_MANIFEST);
    const res = await get('/en/docsary');
    expect(res.status).toBe(200);
    expect(res.text).toBe('renderer-reached');
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('looks up the manifest by decoded pathname, ignoring the query string', async () => {
    // Gate so khớp trên `event.path` đã tách query: h3 `_decodePath` đã
    // percent-decode pathname (đúng dạng khoá manifest) nhưng giữ kèm query
    // — URL content hợp lệ kèm query tracking phải đi qua gate, và slug
    // non-ASCII (browser luôn percent-encode request) phải khớp khoá decoded
    // của manifest thay vì bị 404 nhầm.
    const { renderer, get } = buildApp(SAMPLE_MANIFEST);
    for (const path of [
      '/en/docs/getting-started?utm_source=newsletter',
      '/vi/docs/getting-started/first-steps?fbclid=x',
      '/en/blog/static-deployment/_payload.json?v=2',
    ]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.text).toBe('renderer-reached');
    }
    expect(renderer).toHaveBeenCalledTimes(3);
  });

  it('matches percent-encoded non-ASCII slugs against the decoded manifest keys', async () => {
    // Browser luôn percent-encode byte non-ASCII trong request target:
    // `/vi/blog/t%E1%BA%A1m` là cách wire thật của slug `tạm`. Manifest khoá
    // dạng decoded (`/vi/blog/tạm`) — `getRequestURL().pathname` giữ encoding
    // sẽ không bao giờ khớp (404 nhầm trang đã prerender); `event.path` đã
    // decode phải khớp.
    const manifest = [...SAMPLE_MANIFEST, '/vi/blog/tạm'];
    const { renderer, get } = buildApp(manifest);
    const res = await get('/vi/blog/t%E1%BA%A1m');
    expect(res.status).toBe(200);
    expect(res.text).toBe('renderer-reached');
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it('treats an empty injected manifest as a full pass-through', async () => {
    // Cùng nhánh skip với `nuxt dev` (manifest rỗng): gate tắt hoàn toàn, kể
    // cả path lạ trong mount. Contract "dev không gate" phải đúng cả khi
    // manifest rỗng được inject qua seam, không chỉ trên bản thật với alias
    // fixture (bộ test kia).
    const { renderer, get } = buildApp([]);
    for (const path of ['/en/docs/unknown', '/vi/blog/not-a-post', '/en/blog/url-model']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.text).toBe('renderer-reached');
    }
    expect(renderer).toHaveBeenCalledTimes(3);
  });
});
