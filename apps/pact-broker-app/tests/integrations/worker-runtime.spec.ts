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
 * `vars` nào ở top-level — base URL và token chỉ có ở env staging/production
 * và qua Worker Secrets), nên suite này ghim được luôn chiều fail-closed: BFF
 * và `/ready` trả 503 `broker_not_configured`, không bao giờ đoán origin hay
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

  // BFF thật với cấu hình thiếu: cùng hợp đồng fail-closed, đo được trên
  // runtime thật (unit suite dựng h3 thủ công, không thấy tầng routing này).
  // Body khẳng định **đúng hình dạng** — một token hay base URL nào lọt vào
  // response đều làm test đỏ ở đây.
  it.each(['/api/broker/pacts', '/api/broker/machine-tokens'])(
    'answers %s with the fail-closed 503 when unconfigured',
    async (path) => {
      const response = await fetchRoute(path);

      expect(response.status).toBe(503);
      expect(response.contentType).toContain('application/json');
      expect(JSON.parse(response.body)).toEqual({
        error: 'Service Unavailable',
        code: 'broker_not_configured',
      });
      expect(response.body).not.toContain('Bearer');
    },
  );

  it.each(['/api/non-existent', '/api/nested/deep', '/api/', '/api'])(
    'answers %s with a JSON 404, never the SPA shell',
    async (path) => {
      const response = await fetchRoute(path);

      expect(response.status).toBe(404);
      expect(response.contentType).toContain('application/json');
      expect(response.body).not.toContain('<!DOCTYPE html>');
      expect(JSON.parse(response.body)).toEqual({
        statusCode: 404,
        statusMessage: 'Not Found',
      });
    },
  );

  // Một path dưới namespace BFF nhưng không có route thật phải gặp catch-all
  // 404 — không phải 503 của nhánh fail-closed (chứng minh catch-all chỉ chạy
  // khi thật sự không có handler nào) và không bao giờ là shell.
  it('answers an unknown /api/broker path with the catch-all 404, not the BFF 503', async () => {
    const response = await fetchRoute('/api/broker/definitely-not-a-route');

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
  // chứa `text/html`, nên nếu handler dùng `createError` thì request này nhận
  // **trang HTML 404** thay vì JSON — đo được trên workerd trước khi đổi sang
  // object thuần. Đây là lý do phải gửi header thật: request mặc định của
  // harness không có `Accept`, nên một mình nó không phân biệt được hai cách
  // cài.
  it.each(['/api/browser-navigation', '/api'])(
    'answers %s with JSON even for a browser navigation',
    async (path) => {
      const response = await fetchRoute(path, {
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
    },
  );
});
