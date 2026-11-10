import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Hợp đồng HTTP của scaffold `llm-console` trên **runtime Worker thật**.
 *
 * Vì sao suite này tồn tại: lỗi nó ghim từng sống sót qua mọi test cũ, vì các
 * test đó chỉ đọc `wrangler.jsonc` và source. Trên build thật (`cloudflare-module`
 * + `wrangler dev`), `GET /api/anything` trả **HTML 200** — shell SPA do route
 * `/**` của Nitro render, không phải 404 JSON mà client BFF cần. Không assertion
 * cấu hình nào nhìn thấy điều đó, nên nó phải được đo bằng request thật.
 *
 * `createTestHarness` của wrangler khởi động **workerd** với chính
 * `wrangler.jsonc` của app rồi gửi HTTP qua `server.fetch()`: assets layer,
 * `run_worker_first`, router Nitro và handler đều chạy như production. Không
 * Docker, không mock router — workerd chạy in-process từ devDependency
 * `wrangler` (cùng mô hình `apps/transactional-mail`).
 *
 * ⚠️ Harness được tạo trong `beforeAll`, không ở top level: Vitest import mọi
 * spec file trước khi chạy, nên dựng workerd lúc import sẽ boot runtime kể cả
 * khi cả file bị skip. `close()` trong `afterAll` là bắt buộc — workerd còn sống
 * giữ port và tiến trình vitest không thoát.
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
async function fetchRoute(path: string): Promise<RouteResponse> {
  const response = await harness.fetch(`http://worker.invalid${path}`);

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

describe('llm-console worker runtime', () => {
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
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', service: 'llm-console' });
  });

  it('answers /ready with JSON readiness', async () => {
    const response = await fetchRoute('/ready');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/json');
    expect(JSON.parse(response.body)).toEqual({ status: 'ready' });
  });

  it.each(['/api/nonexistent', '/api', '/api/', '/api/nested/deep'])(
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
});
