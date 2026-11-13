import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `GET /ready` ở chiều **đã cấu hình** trên runtime Worker thật (issue #240).
 *
 * Vì sao suite này tách khỏi `worker-runtime.spec.ts`: workerd đọc env binding
 * lúc boot — harness chưa cấu hình và harness đã cấu hình không thể là cùng
 * một instance, mỗi chiều readiness cần harness riêng. Suite gốc ghim chiều
 * fail-closed (503 `broker_not_configured` khi thiếu cấu hình); chiều còn lại —
 * 200 `ready` khi cấu hình hợp lệ — trước đây không test nào phủ, đúng khe hở
 * mà bug #240 sống sót: route đọc slot `event.context.runtimeConfig` (không ai
 * gắn trên runtime thật) thay vì `useRuntimeConfig(event)`, nên readiness 503
 * vĩnh viễn kể cả khi Worker đã có base URL + token đầy đủ.
 *
 * Config cấp đúng kênh production (cùng pattern `broker-stack.ts`): base URL
 * qua `vars`, token qua `secrets`. Giá trị chỉ cần **có cấu trúc hợp lệ** —
 * readiness chỉ kiểm cấu hình có mặt và parse được, tuyệt đối không probe HTTP
 * tới broker API (docstring `server/routes/ready.get.ts`), nên không cần API
 * worker nào chạy sau origin `.invalid`.
 *
 * ⚠️ Harness được tạo trong `beforeAll`, `close()` trong `afterAll` — cùng luật
 * `worker-runtime.spec.ts`: workerd còn sống giữ port và tiến trình vitest
 * không thoát.
 */

const APP_DIR = resolve(import.meta.dirname, '..', '..');

/** `require('wrangler')` thay vì `await import`: CLI bundle lớn, giữ ngoài pipeline transform của vitest (tiền lệ `apps/transactional-mail`). */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');

type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

let harness: TestHarness;

beforeAll(async () => {
  harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [
      {
        configPath: resolve(APP_DIR, 'wrangler.jsonc'),
        vars: { NITRO_PACT_BROKER_API_BASE_URL: 'https://ready-probe-broker.invalid' },
        secrets: { NITRO_PACT_BROKER_API_TOKEN: 'readiness-test-token' },
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
 * Gọi một path qua worker runtime — cùng quy ước `worker-runtime.spec.ts`:
 * URL tuyệt đối (harness.fetch không resolve path tương đối) và hostname
 * `.invalid` để request đi thẳng vào Worker, không phụ thuộc DNS.
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

describe('pact-broker-app /ready with a fully configured BFF (issue #240)', () => {
  it('answers 200 ready when vars and secrets carry a valid broker config', async () => {
    const response = await fetchRoute('/ready');

    expect(response.status).toBe(200);
    expect(response.contentType).toContain('application/json');
    // Khẳng định **đúng hình dạng** body: readiness không probe broker API và
    // không được lộ base URL/token vào response — một giá trị cấu hình nào lọt
    // ra đều làm test đỏ ở đây.
    expect(JSON.parse(response.body)).toEqual({ status: 'ready' });
  });
});
