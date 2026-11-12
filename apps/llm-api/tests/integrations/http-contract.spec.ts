import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  databaseName,
  roleConnectionString,
  runtimeRole,
  startLlmApiDatabase,
  type LlmApiDatabase,
  type LlmDatabaseKey,
} from './harness';

/**
 * Hợp đồng HTTP của deploy unit `llm-api` (Issue #22; hai finding review PR
 * #113) đo trên **runtime Worker thật** — workerd khởi động từ artifact
 * `build/index.js` mà `worker-build` sinh ra, qua `createTestHarness` của
 * wrangler, cùng mô hình `apps/backoffice/tests/integrations/worker-runtime.spec.ts`.
 *
 * Vì sao suite này tồn tại: cả hai finding đều chỉ thấy được khi gọi HTTP thật.
 * `/llm/v1/models` trả 404 dù base path `/llm` là public contract
 * (docs/architecture/01, bảng domain; A13 ranh giới routing), và `Response::ok`
 * ghim cứng `Content-Type: text/plain; charset=utf-8` (response.rs worker
 * 0.8.7) thay vì `application/json` — không assertion nào đọc source nhìn thấy
 * được hai hành vi đó.
 *
 * Hyperdrive local emulation (miniflare/workerd) KHÔNG nhận connection string
 * từ config — nó đọc biến môi trường
 * `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` lúc **dựng**
 * binding, nên biến phải được set TRƯỚC `createTestHarness` (tiền lệ
 * worker-runtime spec của backoffice). PostgreSQL thật đến từ
 * `startLlmApiDatabase()` — cùng harness của suite `tests/databases`.
 *
 * Docker là phụ thuộc cứng: `globalSetup` của config probe Docker một lần và
 * NÉM khi thiếu Docker — suite ĐỎ chứ không skip (06-testing.md §6). Suite đọc
 * artifact build thật nên target `test-integration` có `dependsOn: ["build"]`
 * (package.json) — thiếu artifact thì `listen()` ném ngay, đỏ thay vì pass rỗng.
 *
 * ⚠️ Harness được tạo trong `beforeAll`, không ở top level: Vitest import mọi
 * spec file trước khi chạy, nên dựng workerd lúc import sẽ boot runtime kể cả
 * khi cả file bị skip. `close()` trong `afterAll` là bắt buộc — workerd còn
 * sống giữ tiến trình vitest không thoát.
 *
 * ⚠️ Hai describe dùng **hai harness riêng** vì Hyperdrive local đọc env lúc
 * dựng binding: harness lành mạnh dùng cả ba connection string thật; harness
 * fail-closed dựng SAU khi một biến bị trỏ sang địa chỉ chết. Describe chạy
 * tuần tự trong file nên mutate env giữa hai `beforeAll` là an toàn — harness
 * đầu đã chốt connection string của nó từ lúc dựng.
 */

const APP_DIR = resolve(import.meta.dirname, '..', '..');

/** `require('wrangler')` thay vì `await import`: CLI bundle lớn, giữ ngoài pipeline transform của vitest (tiền lệ backoffice). */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');

type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

const WORKER_CONFIG_PATH = resolve(APP_DIR, 'wrangler.jsonc');

/** Ánh xạ khóa database → tên Hyperdrive binding, khớp chính xác `wrangler.jsonc` và `readiness.rs`. */
const BINDING_BY_KEY: Record<LlmDatabaseKey, string> = {
  gateway: 'DB_LLM_GATEWAY',
  tenant: 'DB_LLM_TENANT',
  marketplace: 'DB_LLM_MARKETPLACE',
};

/** Binding bị trỏ sang địa chỉ chết trong describe fail-closed — một trong ba là đủ để toàn bộ data plane phải 503. */
const DEGRADED_KEY: LlmDatabaseKey = 'marketplace';

/** Tên biến môi trường connection string local của một binding Hyperdrive. */
function hyperdriveEnvName(binding: string): string {
  return `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`;
}

let db: LlmApiDatabase;
let harness: TestHarness;
let degradedHarness: TestHarness;

/** Giá trị env trước khi suite chạy — `afterAll` khôi phục đúng trạng thái ban đầu kể cả khi setup hỏng giữa chừng. */
const previousConnectionStrings = new Map<string, string | undefined>();

beforeAll(async () => {
  // Chụp giá trị env cũ NGAY ĐẦU — trước mọi bước có thể ném lỗi — để `afterAll`
  // luôn khôi phục đúng trạng thái ban đầu (tiền lệ worker-runtime backoffice).
  for (const binding of Object.values(BINDING_BY_KEY)) {
    previousConnectionStrings.set(binding, process.env[hyperdriveEnvName(binding)]);
  }

  db = await startLlmApiDatabase();

  // Connection string của **role runtime** — đúng hình vai Worker trong
  // production (credential migrator chỉ dành cho runner `db:migrate`).
  for (const key of ['gateway', 'tenant', 'marketplace'] as const) {
    const url = roleConnectionString(runtimeRole(key), databaseName(key), db.host, db.port);
    process.env[hyperdriveEnvName(BINDING_BY_KEY[key])] = url;
  }

  harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [{ configPath: WORKER_CONFIG_PATH }],
  });
  await harness.listen();
}, 240_000);

afterAll(async () => {
  // Cleanup chống lỗi setup: `beforeAll` ném giữa chừng thì tài nguyên chưa kịp
  // tạo còn là `undefined` — mỗi bước tự kiểm, `disposeAll` cách ly lỗi từng
  // bước để khôi phục env ở bước cuối vẫn chạy (connection string trỏ tới
  // PostgreSQL test đã đóng không được rò ra ngoài tiến trình).
  await disposeAll(
    async () => {
      if (harness !== undefined) {
        await harness.close();
      }
    },
    async () => {
      if (degradedHarness !== undefined) {
        await degradedHarness.close();
      }
    },
    async () => {
      if (db !== undefined) {
        await db.stop();
      }
    },
    async () => {
      for (const [binding, previous] of previousConnectionStrings) {
        const name = hyperdriveEnvName(binding);
        if (previous === undefined) {
          // `Reflect.deleteProperty` thay cho `delete process.env[name]`: rule
          // `no-dynamic-delete` cấm `delete` với key động, semantics như nhau.
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = previous;
        }
      }
    },
  );
});

interface RouteResponse {
  readonly status: number;
  readonly contentType: string;
  readonly allow: string;
  readonly body: string;
}

/**
 * Gọi một path qua worker runtime của harness cho trước.
 *
 * URL phải **tuyệt đối** (tiền lệ backoffice): `harness.fetch` không resolve
 * path tương đối — undici từ chối với `ERR_INVALID_URL`. Hostname `.invalid` là
 * cố ý: request đi thẳng vào Worker, không phụ thuộc DNS hay hostname môi trường.
 */
async function fetchRouteOn(
  target: TestHarness,
  path: string,
  init: { method?: string } = {},
): Promise<RouteResponse> {
  const response = await target.fetch(`http://worker.invalid${path}`, {
    method: init.method ?? 'GET',
  });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    allow: response.headers.get('allow') ?? '',
    body: await response.text(),
  };
}

/**
 * Parse JSON body với assertion tường minh — body sai định dạng là **failure
 * của expect** (`not.toThrow`), không phải `SyntaxError` nổ ngoài vòng assertion
 * biến test thành crash thay vì báo đỏ đúng chỗ (tiền lệ backoffice).
 */
function expectJson(body: string): unknown {
  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(body) as unknown;
  }).not.toThrow();
  return parsed as unknown;
}

/**
 * Chạy các bước dọn dẹp tuần tự, **cách ly lỗi từng bước**: mọi bước đều được
 * chạy dù bước trước ném lỗi, rồi lỗi đầu tiên được ném lại sau cùng (tiền lệ
 * backoffice — workerd sống giữ port sẽ giữ tiến trình vitest không thoát).
 */
async function disposeAll(...steps: Array<() => Promise<void>>): Promise<void> {
  let firstError: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

describe('llm-api worker HTTP contract (all Hyperdrive bindings ready)', () => {
  // Marketplace trống ⇒ `data: []` — đúng body hợp đồng khi chưa có offer
  // nào `active` (Issue #23 thay hợp đồng body đóng băng rỗng của #22).
  it('serves an empty model list as JSON on the public base path /llm/v1/models while no offer is active', async () => {
    const response = await fetchRouteOn(harness, '/llm/v1/models');

    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/json');
    expect(expectJson(response.body)).toEqual({ object: 'list', data: [] });
  });

  it('serves the same empty list on the unprefixed /v1/models', async () => {
    const response = await fetchRouteOn(harness, '/v1/models');

    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/json');
    expect(expectJson(response.body)).toEqual({ object: 'list', data: [] });
  });

  // Issue #23: catalogue thật — offer `active` của marketplace được liệt kê
  // với owner là tên Seller tenant ánh xạ từ gateway (đọc hai binding).
  it('lists an active model offer with its owning tenant name on /v1/models', async () => {
    const gateway = await db.connect('gateway');
    const marketplace = await db.connect('marketplace');
    try {
      await gateway.query(
        `INSERT INTO llm_seller.seller_tenants (id, name, classification, owner_sub, created_at)
         VALUES ('seller-tenant-dronie', 'dronie', 'first_party', 'bootstrap-superadmin-sub', 1760000000000)
         ON CONFLICT (id) DO NOTHING`,
      );
      await marketplace.query(
        `INSERT INTO llm_marketplace.model_offers
           (id, seller_tenant_id, normalized_model_id, status, public_alias, capabilities, created_at, updated_at, activated_at, deactivated_at, retired_at)
         VALUES ('model-offer-integration-test', 'seller-tenant-dronie', 'dronie-flash', 'active', NULL, '["chat"]'::jsonb,
                 1760000000000, 1760000000000, 1760000000000, NULL, NULL)
         ON CONFLICT (id) DO NOTHING`,
      );

      const response = await fetchRouteOn(harness, '/v1/models');

      expect(response.status).toBe(200);
      expect(expectJson(response.body)).toEqual({
        object: 'list',
        data: [{ id: 'dronie-flash', object: 'model', created: 1760000000, owned_by: 'dronie' }],
      });
    } finally {
      await marketplace.query(
        `DELETE FROM llm_marketplace.model_offers WHERE id = 'model-offer-integration-test'`,
      );
      await gateway.query(
        `DELETE FROM llm_seller.seller_tenants WHERE id = 'seller-tenant-dronie'`,
      );
      await marketplace.end();
      await gateway.end();
    }
  });

  // Liveness body + content-type là một phần hợp đồng: `ok` với
  // `text/plain; charset=utf-8` (worker-rs `Response::ok` ghim cứng).
  it('answers GET /health with 200 liveness body ok as plain text', async () => {
    const response = await fetchRouteOn(harness, '/health');

    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
    expect(response.contentType).toBe('text/plain; charset=utf-8');
  });

  it('answers GET /ready with 200 body ready as plain text when all three Hyperdrive bindings answer SELECT 1', async () => {
    const response = await fetchRouteOn(harness, '/ready');

    expect(response.status).toBe(200);
    expect(response.body).toBe('ready');
    expect(response.contentType).toBe('text/plain; charset=utf-8');
  });

  // Hợp đồng GET-only: method khác GET trên path đã định nghĩa không được biến
  // thành response thành công — 405 + `Allow: GET` (review PR #113). HEAD và
  // OPTIONS cũng thuộc nhánh 405: hợp đồng chỉ định nghĩa GET, không có ngoại
  // lệ cho hai method "vô hại". Body `method not allowed` là một phần hợp đồng;
  // HEAD không có body (ràng buộc HTTP, không phải của worker).
  it.each([
    ['/health', 'POST'],
    ['/health', 'HEAD'],
    ['/health', 'OPTIONS'],
    ['/health', 'PUT'],
    ['/health', 'DELETE'],
    ['/ready', 'POST'],
    ['/ready', 'HEAD'],
    ['/ready', 'OPTIONS'],
    ['/ready', 'PUT'],
    ['/ready', 'DELETE'],
    ['/v1/models', 'POST'],
    ['/v1/models', 'HEAD'],
    ['/v1/models', 'OPTIONS'],
    ['/v1/models', 'PUT'],
    ['/v1/models', 'DELETE'],
    ['/llm/v1/models', 'POST'],
    ['/llm/v1/models', 'HEAD'],
    ['/llm/v1/models', 'OPTIONS'],
    ['/llm/v1/models', 'PUT'],
    ['/llm/v1/models', 'DELETE'],
  ] as const)(
    'answers %s %s with 405, Allow: GET and body method not allowed',
    async (path, method) => {
      const response = await fetchRouteOn(harness, path, { method });

      expect(response.status).toBe(405);
      expect(response.allow).toBe('GET');
      expect(response.contentType).toBe('');
      // HEAD không có body (ràng buộc HTTP của method, không phải của worker) —
      // expected value điều kiện thay vì expect gọi có điều kiện (rule
      // `vitest/no-conditional-expect`).
      expect(response.body).toBe(method === 'HEAD' ? '' : 'method not allowed');
    },
  );

  // Không thêm route `/llm/*` nào ngoài `/llm/v1/models`: health/readiness là
  // deployment-internal, probe trên đường mạng container, không qua domain công
  // khai — nên `/llm/health` và `/llm/ready` phải ở lại 404 (review PR #113).
  // Path lạ giữ 404 bất kể method (bao gồm HEAD/OPTIONS — 405 chỉ dành cho path
  // ĐÃ định nghĩa); body `not found` là một phần hợp đồng.
  it.each([
    ['/llm/health', 'GET'],
    ['/llm/ready', 'GET'],
    ['/definitely-not-a-route', 'GET'],
    ['/llm/definitely-not-a-route', 'POST'],
    ['/definitely-not-a-route', 'HEAD'],
    ['/definitely-not-a-route', 'OPTIONS'],
    ['/definitely-not-a-route', 'PUT'],
    ['/definitely-not-a-route', 'DELETE'],
  ] as const)('answers %s %s with 404 and body not found', async (path, method) => {
    const response = await fetchRouteOn(harness, path, { method });

    expect(response.status).toBe(404);
    expect(response.contentType).toBe('');
    // HEAD không có body — cùng chú thích của ma trận 405 phía trên.
    expect(response.body).toBe(method === 'HEAD' ? '' : 'not found');
  });
});

describe('llm-api worker fails closed when a Hyperdrive binding cannot connect', () => {
  beforeAll(async () => {
    // Mô phỏng "một database xuống" bằng **địa chỉ chết** (cổng 1 trên loopback
    // — không listener nào, connect bị từ chối ngay): binding vẫn được khai nên
    // workerd boot được, probe readiness trả Unavailable (readiness.rs) và hợp
    // đồng 503 được đo ở tầng route. Không bỏ hẳn biến env: thiếu biến là lỗi
    // NGAY LÚC BOOT của lane local, khi đó nhánh 503 của hợp đồng không được
    // request nào chạm tới.
    process.env[hyperdriveEnvName(BINDING_BY_KEY[DEGRADED_KEY])] =
      `postgresql://ecoma_llm_${DEGRADED_KEY}_runtime:dead@127.0.0.1:1/dead-database`;

    degradedHarness = wranglerCli.createTestHarness({
      root: APP_DIR,
      workers: [{ configPath: WORKER_CONFIG_PATH }],
    });
    await degradedHarness.listen();
  }, 240_000);

  it('answers GET /ready with 503 body not ready when one binding cannot connect', async () => {
    const response = await fetchRouteOn(degradedHarness, '/ready');

    expect(response.status).toBe(503);
    expect(response.body).toBe('not ready');
    expect(response.contentType).toBe('');
  });

  it('answers GET /v1/models with 503 body service unavailable when one binding cannot connect', async () => {
    const response = await fetchRouteOn(degradedHarness, '/v1/models');

    expect(response.status).toBe(503);
    expect(response.body).toBe('service unavailable');
    expect(response.contentType).toBe('');
  });

  it('answers GET /llm/v1/models with 503 body service unavailable when one binding cannot connect', async () => {
    const response = await fetchRouteOn(degradedHarness, '/llm/v1/models');

    expect(response.status).toBe(503);
    expect(response.body).toBe('service unavailable');
    expect(response.contentType).toBe('');
  });

  // Liveness KHÔNG phụ thuộc database: healthcheck deployment phải vẫn thấy
  // "process sống" khi mọi binding xuống, để phân biệt với "phụ thuộc chưa
  // sẵn sàng" (hợp đồng đóng băng Issue #22).
  it('still answers GET /health with 200 because liveness never touches the database', async () => {
    const response = await fetchRouteOn(degradedHarness, '/health');

    expect(response.status).toBe(200);
  });
});
