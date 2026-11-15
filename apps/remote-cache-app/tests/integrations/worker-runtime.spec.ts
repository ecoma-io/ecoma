import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Hợp đồng HTTP của BFF `remote-cache-app` trên **runtime Worker thật**
 * (ADR-0035).
 *
 * Vì sao suite này tồn tại: lỗi nó ghim từng sống sót qua mọi test cũ, vì các
 * test đó chỉ đọc `wrangler.jsonc` và source. Trên build thật (`cloudflare-module`
 * + `wrangler dev`), `GET /api/anything` trả **HTML 200** — shell SPA do route
 * `/**` của Nitro render, không phải 404 JSON mà client BFF cần. Không assertion
 * cấu hình nào nhìn thấy điều đó, nên nó phải được đo bằng request thật.
 *
 * Hợp đồng BFF được ghim ở **chiều fail-closed**: harness không cấu hình OIDC
 * hay control plane (`wrangler.jsonc` không có `vars` top-level), nên
 *
 * - `/ready` trả `503 { status: 'not_ready', code: 'oidc_not_configured' }`;
 * - middleware authn chặn **mọi** `/api/**` (deny-by-default) bằng 503
 *   `authorization unavailable` trước cả khi nhìn thấy phiên;
 * - `/api/auth/session` (ngoài ranh giới authn) trả `{ authenticated: false }`
 *   ngay khi không có cookie — không chạm cấu hình, không bao giờ 5xx.
 *
 * `createTestHarness` của wrangler khởi động **workerd** với chính
 * `wrangler.jsonc` của app rồi gửi HTTP qua `server.fetch()`: assets layer,
 * `run_worker_first`, router Nitro và handler đều chạy như production. Binding
 * Hyperdrive được mô phỏng bằng connection string giả — suite không chạm DB.
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

/**
 * Connection string giả cho Hyperdrive local emulation — wrangler từ chối boot
 * workerd khi binding Hyperdrive không có
 * `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_*` (PHẢI set TRƯỚC
 * `createTestHarness`). Suite này **không** chạm DB: mọi route đo được đều
 * fail-closed trước lớp pool, nên giá trị chỉ cần tồn tại.
 */
const FAKE_PG_URL = 'postgres://unused:unused@localhost:1/unused';
const HD_ENV_NAME = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB_REMOTE_CACHE_APP';

let savedHd: { had: boolean; value: string | undefined };

/** `require('wrangler')` thay vì `await import`: CLI bundle lớn, giữ ngoài pipeline transform của vitest (tiền lệ `apps/transactional-mail`). */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');

type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

let harness: TestHarness;

beforeAll(async () => {
  savedHd = { had: HD_ENV_NAME in process.env, value: process.env[HD_ENV_NAME] };
  process.env[HD_ENV_NAME] = FAKE_PG_URL;
  harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [{ configPath: resolve(APP_DIR, 'wrangler.jsonc') }],
  });
  await harness.listen();
}, 120_000);

afterAll(async () => {
  await harness.close();
  if (savedHd.had) {
    process.env[HD_ENV_NAME] = savedHd.value;
  } else {
    Reflect.deleteProperty(process.env, HD_ENV_NAME);
  }
});

interface RouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly cacheControl: string | null;
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
): Promise<RouteResponse> {
  const response = await harness.fetch(`http://worker.invalid${path}`, { headers });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    cacheControl: response.headers.get('cache-control'),
    body: await response.text(),
  };
}

describe('remote-cache-app worker runtime', () => {
  it.each(['/', '/settings'])('serves the SPA shell for %s', async (path) => {
    const response = await fetchRoute(path);

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('text/html');
    expect(response.body).toContain('<!DOCTYPE html>');
  });

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
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', service: 'remote-cache-app' });
  });

  // Harness chưa cấu hình OIDC hay control plane (`wrangler.jsonc` không có
  // `vars` top-level), nên readiness phải fail closed với mã ổn định — không
  // đoán origin, không probe HTTP (xem `server/routes/ready.get.ts`).
  it('answers /ready with the fail-closed 503 when unconfigured', async () => {
    const response = await fetchRoute('/ready');

    expect(response.status).toBe(503);
    expect(response.contentType).toContain('application/json');
    expect(JSON.parse(response.body)).toEqual({
      status: 'not_ready',
      code: 'oidc_not_configured',
    });
  });

  // Probe phiên nằm NGOÀI ranh giới authn (`AUTH_PATHS`): không cookie ⇒
  // `{ authenticated: false }` ngay, không chạm cấu hình hay DB — kể cả khi
  // harness chưa cấu hình OIDC gì (route không bao giờ 5xx, xem
  // `server/api/auth/session.get.ts`).
  it('answers /api/auth/session with authenticated:false without a cookie, even unconfigured', async () => {
    const response = await fetchRoute('/api/auth/session');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/json');
    expect(JSON.parse(response.body)).toEqual({ authenticated: false });
    expect(response.cacheControl).toBe('no-store');
  });

  // BFF thật với cấu hình thiếu: middleware authn chặn **mọi** `/api/**`
  // (deny-by-default, `AUTH_PATHS` là danh sách đóng) và fail-closed 503
  // trước cả khi nhìn thấy phiên — không có nhánh nào coi "chưa cấu hình" là
  // "cho phép". Body là hình dạng lỗi của **Nitro** (`createError` đi qua error
  // renderer), khẳng định không token/credential nào lọt vào response.
  it.each([
    '/api/portal/tenants/acme/projects',
    '/api/auth/login',
    '/api/definitely-not-a-route',
    '/api/non-existent',
    '/api/nested/deep',
    '/api/',
  ])('answers %s with the middleware fail-closed 503 when OIDC is unconfigured', async (path) => {
    const response = await fetchRoute(path);

    expect(response.status).toBe(503);
    expect(response.contentType).toContain('application/json');
    const body = JSON.parse(response.body) as {
      statusCode?: unknown;
      statusMessage?: unknown;
    };
    expect(body.statusCode).toBe(503);
    expect(body.statusMessage).toBe('authorization unavailable');
    expect(response.body).not.toContain('Bearer');
    expect(response.body).not.toContain('postgres://');
  });

  // `/api` (không trailing slash) KHÔNG nằm dưới prefix `/api/` của middleware
  // — đi qua tự do và gặp catch-all 404 của router. Đường ranh giới prefix này
  // là hợp đồng của `AUTH_PATHS`/`API_PREFIX`, ghim ở đây để một sửa đổi lệch
  // một ký tự bị bắt ngay trên runtime thật.
  it('answers /api (no trailing slash) with the catch-all 404', async () => {
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
  // Nuxt renderer chọn JSON hay trang lỗi HTML theo **`Accept`**:
  // `isJsonRequest` trả false khi `Accept` chứa `text/html`, bất kể path
  // (`nuxt/dist/runtime/server/renderer/error.js`). Một browser navigation
  // thẳng vào `/api/**` vì thế nhận trang lỗi HTML — hành vi của framework cho
  // người dùng cuối; client thật của BFF (`fetch`) vẫn nhận JSON, đã ghim ở
  // `it.each` phía trên. Bất biến cần đo ở đây là **status** và việc không
  // credential nào lọt vào body.
  it('answers the middleware 503 to a browser navigation as an HTML error page', async () => {
    const response = await fetchRoute('/api/portal/tenants/acme/projects', {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-mode': 'navigate',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    });

    expect(response.status).toBe(503);
    expect(response.contentType).toContain('text/html');
    // Không credential nào trong body — hình dạng HTML hay JSON đều vậy.
    expect(response.body).not.toContain('Bearer');
    expect(response.body).not.toContain('postgres://');
    expect(response.body).not.toContain('INTERNAL_AUTH_SECRET');
  });
});
