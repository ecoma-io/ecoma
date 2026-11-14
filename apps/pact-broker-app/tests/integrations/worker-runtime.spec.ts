import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Hợp đồng HTTP của `pact-broker-app` ở chế độ **non-SSR SPA** (issue #68) trên
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
 * `run_worker_first`, router Nitro và handler đều chạy như production. Không
 * Docker, không mock router — workerd chạy in-process từ devDependency
 * `wrangler` (cùng mô hình `apps/llm-console`, `apps/backoffice`).
 *
 * Harness chạy ở trạng thái **chưa cấu hình** (`wrangler.jsonc` không khai
 * `vars` nào ở top-level — cấu hình broker và OIDC chỉ có ở env
 * staging/production và qua Worker Secrets), nên suite này ghim được luôn
 * chiều fail-closed: `/ready` trả 503 `broker_not_configured`, còn mọi
 * `/api/**` (trừ các path auth) bị middleware authn chặn bằng 503
 * `authorization unavailable` (ADR-0031, #206) — không bao giờ đoán origin hay
 * rò token vào response.
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
  harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [{ configPath: resolve(APP_DIR, 'wrangler.jsonc') }],
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
  /** Header của response — dùng cho assert `cache-control`/`set-cookie`. */
  readonly headers: Headers;
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
    body: await response.text(),
    headers: response.headers,
  };
}

describe('pact-broker-app worker runtime (SPA, issue #68)', () => {
  // Bốn route thật của app — deep link phải mở đúng shell, rồi client router
  // mới render nội dung. `/` là trang Pacts (route index của Nuxt).
  it.each(['/', '/pacts', '/environments', '/tokens'])(
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
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', service: 'pact-broker-app' });
  });

  // Harness chưa cấu hình broker (`wrangler.jsonc` không có `vars` top-level),
  // nên readiness phải fail closed với mã ổn định — không đoán origin, không
  // probe HTTP (xem `server/routes/ready.get.ts`).
  it('answers /ready with the fail-closed 503 when unconfigured', async () => {
    const response = await fetchRoute('/ready');

    expect(response.status).toBe(503);
    expect(response.contentType).toContain('application/json');
    expect(JSON.parse(response.body)).toEqual({
      status: 'unavailable',
      code: 'broker_not_configured',
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
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  // BFF thật với cấu hình OIDC thiếu: middleware authn chặn **mọi** `/api/**`
  // (deny-by-default, `AUTH_PATHS` là danh sách đóng) và fail-closed 503
  // trước cả khi nhìn thấy phiên — không có nhánh nào coi "chưa cấu hình" là
  // "cho phép". Body là hình dạng lỗi của **Nitro** (`createError` đi qua error
  // renderer: `statusCode` + `statusMessage` + `error`/`message`/`url`), không
  // phải object tự dựng — nên assert đúng những trường hợp đồng ổn định, và
  // khẳng định không token/credential nào lọt vào response.
  it.each([
    '/api/broker/pacts',
    '/api/broker/machine-tokens',
    '/api/broker/definitely-not-a-route',
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
  // credential nào lọt vào body của cả hai hình dạng.
  it('answers the middleware 503 to a browser navigation as an HTML error page', async () => {
    const response = await fetchRoute('/api/blocked-by-authn', {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-mode': 'navigate',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    });

    expect(response.status).toBe(503);
    expect(response.contentType).toContain('text/html');
    // Không credential nào trong body — hình dạng HTML hay JSON đều vậy.
    expect(response.body).not.toContain('Bearer');
    expect(response.body).not.toContain('postgres://');
    expect(response.body).not.toContain('PACT_BROKER_AUTH_CLIENT_ID');
  });
});
