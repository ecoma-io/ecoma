import { createRequire } from 'node:module';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Hợp đồng HTTP của `backoffice` ở chế độ **non-SSR SPA** (issue #67) trên
 * **runtime Worker thật**.
 *
 * Vì sao suite này tồn tại: lỗi nó ghim từng sống sót qua mọi test cũ, vì các
 * test đó chỉ đọc `wrangler.jsonc` và source. Khi `ssr: false`, Nitro cài route
 * catch-all `/**` trả shell HTML — mọi path không khớp route/API đều nhận
 * **HTML 200**, kể cả một path `/api` sai, đúng hình dạng "thành công" với mọi
 * client chỉ kiểm `response.ok`. Không assertion cấu hình nào nhìn thấy điều
 * đó, nên nó phải được đo bằng request thật.
 *
 * `createTestHarness` của wrangler khởi động **workerd** với chính
 * `wrangler.jsonc` của app rồi gửi HTTP qua `server.fetch()`: assets layer,
 * router Nitro, middleware authn và handler đều chạy như production. Không
 * Docker, không mock router — workerd chạy in-process từ devDependency
 * `wrangler` (cùng mô hình `apps/llm-console`, `apps/llm-seller`).
 *
 * ## Service binding giả — chỉ để boot, không phải mock hành vi
 *
 * `wrangler.jsonc` khai hai `services` (`ACCOUNT_SERVICE`,
 * `STAFF_ACCESS_SERVICE`); workerd từ chối boot khi service được trỏ tới không
 * nằm trong harness. Stub ở đây **chỉ tồn tại để runtime lên được** — trả 503
 * cho mọi fetch, và không nhánh test nào gọi tới: môi trường harness không có
 * cấu hình OIDC nên middleware authn fail-closed **trước** khi route nào chạm
 * binding. Env có cấu hình thật và đường đọc DB là việc của
 * `authn-middleware.spec.ts` / `read-routes.spec.ts` (PostgreSQL thật) — suite
 * này chỉ ghim hình dạng routing ở tầng Worker.
 *
 * ⚠️ Harness được tạo trong `beforeAll`, không ở top level: Vitest import mọi
 * spec file trước khi chạy, nên dựng workerd lúc import sẽ boot runtime kể cả
 * khi cả file bị skip. `close()` trong `afterAll` là bắt buộc — workerd còn
 * sống giữ port và tiến trình vitest không thoát.
 *
 * ⚠️ Suite đọc `.output/` thật, nên target `test-integration` phải
 * `dependsOn: build`. Thiếu output thì `listen()` ném ngay — đỏ, không pass rỗng.
 */

const APP_DIR = resolve(import.meta.dirname, '..', '..');

/** `require('wrangler')` thay vì `await import`: CLI bundle lớn, giữ ngoài pipeline transform của vitest (tiền lệ `apps/transactional-mail`). */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');

type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

let harness: TestHarness;

beforeAll(async () => {
  // Stub script ghi vào tmpdir lúc chạy — không nằm trong repo, vì nội dung của
  // nó không từng được đọc bởi nhánh test nào (xem JSDoc đầu file).
  const stubDir = await mkdtemp(join(tmpdir(), 'ecoma-backoffice-worker-stub-'));
  const stubScript = join(stubDir, 'index.mjs');
  await writeFile(
    stubScript,
    'export default { fetch: () => new Response(null, { status: 503 }) };',
  );

  harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [
      { configPath: resolve(APP_DIR, 'wrangler.jsonc') },
      // Tên stub phải khớp **đúng** tên service trong `wrangler.jsonc` —
      // workerd resolve `services` theo tên worker trong cùng harness.
      {
        config: {
          name: 'ecoma-account-bridge',
          main: stubScript,
          compatibility_date: '2026-10-05',
        },
      },
      {
        config: {
          name: 'ecoma-staff-access',
          main: stubScript,
          compatibility_date: '2026-10-05',
        },
      },
    ],
  });
  await harness.listen();
}, 120_000);

afterAll(async () => {
  await harness.close();
});

interface RouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * Gọi một path qua worker runtime.
 *
 * URL phải **tuyệt đối**: `harness.fetch` không resolve path tương đối —
 * undici từ chối với `ERR_INVALID_URL` ở mọi path, lỗi dễ bị đọc nhầm thành
 * "runtime không phục vụ được". Hostname `.invalid` là cố ý: request đi thẳng
 * vào Worker, không phụ thuộc DNS hay hostname của môi trường.
 */
async function fetchRoute(
  path: string,
  headers: Record<string, string> = {},
  method: 'GET' | 'POST' = 'GET',
): Promise<RouteResponse> {
  const response = await harness.fetch(`http://worker.invalid${path}`, { headers, method });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

describe('backoffice worker runtime (SPA, issue #67)', () => {
  // Sáu route thật của app — deep link phải mở đúng shell, rồi client router
  // mới render nội dung. Đủ cả hai route ngoài bộ prototype của e2e (`/audit`,
  // `/onboarding`) ở tầng HTTP, nơi không cần binding hay phiên.
  it.each(['/', '/staff', '/roles', '/permissions', '/audit', '/onboarding'])(
    'serves the SPA shell for %s',
    async (path) => {
      const response = await fetchRoute(path);

      expect(response.status).toBe(200);
      expect(response.contentType).toContain('text/html');
      expect(response.body).toContain('<!DOCTYPE html>');
    },
  );

  it('serves the static asset that the shell references', async () => {
    const shell = await fetchRoute('/');
    // Không dùng message thứ hai của `expect` (bị rule `vitest/valid-expect`
    // cấm): một asset path `undefined` làm test đỏ ngay ở dòng dưới.
    const assetPath = /\/_nuxt\/[\w.-]+\.js/u.exec(shell.body)?.[0] ?? '';

    expect(assetPath).not.toBe('');

    const asset = await fetchRoute(assetPath);

    expect(asset.status).toBe(200);
    expect(asset.contentType).toContain('javascript');
  });

  it('answers /health with JSON liveness', async () => {
    const response = await fetchRoute('/health');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/json');
    expect(JSON.parse(response.body)).toEqual({ status: 'ok' });
  });

  // Middleware authn chạy trước mọi route và fail-closed khi thiếu cấu hình
  // OIDC (503). Đây chính là hành vi "mặc định đóng" cần giữ nguyên sau khi
  // tắt SSR: path lạ dưới `/api/` **không bao giờ** rơi vào shell HTML — nó
  // bị chặn ở middleware trước, với JSON lỗi, kể cả khi không có route nào
  // khớp. Phân loại 401/503 chi tiết là việc của `authn-middleware.spec.ts`.
  it.each(['/api/non-existent', '/api/nested/deep', '/api/'])(
    'never answers %s with the SPA shell — authn fails closed first',
    async (path) => {
      const response = await fetchRoute(path);

      expect(response.status).toBe(503);
      expect(response.contentType).toContain('application/json');
      expect(response.body).not.toContain('<!DOCTYPE html>');
      expect(JSON.parse(response.body)).toMatchObject({ statusCode: 503 });
    },
  );

  // `/api` (không có dấu `/` phía sau) nằm ngoài tiền tố `/api/` của
  // middleware, nên nó tới được catch-all JSON 404 trong `server/api/`. Đây là
  // path từng trả **HTML 200** (shell) trước khi thêm catch-all — đo được trên
  // workerd, đúng lỗi mà issue #67 ghim.
  it('answers /api with a JSON 404, never the SPA shell', async () => {
    const response = await fetchRoute('/api');

    expect(response.status).toBe(404);
    expect(response.contentType).toContain('application/json');
    expect(response.body).not.toContain('<!DOCTYPE html>');
    expect(JSON.parse(response.body)).toEqual({
      statusCode: 404,
      statusMessage: 'Not Found',
    });
  });

  // ⚠️ Header của một lần điều hướng bằng trình duyệt, không phải của `fetch`.
  // Middleware lỗi của Nitro chỉ bỏ qua error renderer khi `Accept` **không**
  // chứa `text/html`, nên một handler dùng `createError` sẽ trả trang HTML thay
  // vì JSON khi request trông giống navigation. Đây là lý do phải gửi header
  // thật: request mặc định của harness không có `Accept`, nên một mình nó không
  // phân biệt được hai cách cài.
  it('answers /api with JSON even for a browser navigation', async () => {
    const response = await fetchRoute('/api', {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-mode': 'navigate',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    });

    expect(response.status).toBe(404);
    expect(response.contentType).toContain('application/json');
    expect(response.body).not.toContain('<!DOCTYPE html>');
    expect(JSON.parse(response.body)).toEqual({
      statusCode: 404,
      statusMessage: 'Not Found',
    });
  });

  // Ba path auth nằm ngoài ranh giới chặn của middleware (chính là luồng xác
  // thực). Login với env không cấu hình phải fail-closed 503 JSON — không bao
  // giờ là shell HTML 200.
  it('keeps the auth flow reachable: /api/auth/login fails closed with JSON', async () => {
    const response = await fetchRoute('/api/auth/login');

    expect(response.status).toBe(503);
    expect(response.contentType).toContain('application/json');
    expect(response.body).not.toContain('<!DOCTYPE html>');
  });

  // Logout là POST idempotent (ADR-0011): nhận 204 không body. Ghim ở tầng
  // Worker để một refactor đổi method không chỉ nổ ở unit test mà nổ cả ở
  // hình dạng request thật.
  it('answers POST /api/auth/logout with the idempotent 204', async () => {
    const response = await fetchRoute('/api/auth/logout', {}, 'POST');

    expect(response.status).toBe(204);
    expect(response.body).toBe('');
  });

  // Service worker vẫn được sinh ra và chiến lược cache không đổi sau khi tắt
  // SSR (issue #67 — chỉ verify, không redesign): `/api/**` là NetworkOnly
  // (response có phiên không bao giờ vào cache), `/_nuxt/*.{js,css}` là
  // CacheFirst, và manifest precache vẫn được sinh từ build thật.
  it('ships a service worker that keeps /api NetworkOnly and precaches build assets', async () => {
    const sw = await fetchRoute('/sw.js');

    expect(sw.status).toBe(200);
    expect(sw.contentType).toContain('javascript');
    expect(sw.body).toContain('precacheAndRoute');
    // NetworkOnly cho `/api/` — một runtimeCaching đổi handler là response có
    // phiên bắt đầu vào cache, vi phạm invariant "API không cache".
    expect(sw.body).toMatch(/registerRoute\([^)]*NetworkOnly/su);
    expect(sw.body).toContain('CacheFirst');
  });
});
