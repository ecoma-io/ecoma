/**
 * Pact Broker API trên **runtime Worker thật** — workerd qua `createTestHarness`
 * của wrangler (cùng mô hình `apps/llm-seller` / `apps/backoffice`), Hyperdrive
 * local emulation qua biến môi trường `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`
 * (platform fact PF3) và PostgreSQL thật (testcontainers, cùng harness của suite
 * integration khác).
 *
 * Vì sao suite này tồn tại (issue #118): mọi tầng test cũ chạy `pg` trong Node —
 * socket không bao giờ đi qua `cloudflare:sockets`, nên cơ chế "socket gắn với
 * request context tạo ra nó" không thể tái hiện ở đó. Bài toán gốc: Pool cache
 * module-scope tái sử dụng socket chết xuyên request và treo vĩnh viễn; Pool
 * tạo mới trong request luôn hoạt động, kể cả nhiều connection đồng thời. Suite
 * này ghim hành vi đó trên runtime thật: **ít nhất 10 request đọc-DB tuần tự
 * không restart** worker/container, **nhiều connection vật lý đồng thời trên
 * cùng isolate (xuyên invocation)**, và **không rò connection** sau khi runtime
 * tắt.
 *
 * ⚠️ Cùng isolate theo cấu tạo: harness khởi động workerd MỘT lần trong
 * `beforeAll` và chỉ tắt ở `afterAll` — không restart giữa các request. Không
 * thêm header/endpoint "isolate id" nào vào production code chỉ để phục vụ test.
 *
 * ⚠️ Harness đọc `dist/main.js` (bundle esbuild của target `build`), nên target
 * `test-integration` phải `dependsOn: ["build"]` — thiếu build thì `listen()`
 * ném ngay (đỏ, không pass rỗng).
 *
 * ⚠️ Docker là phụ thuộc cứng (probe fail-loud của `vitest.integration.config.mts`).
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as Infra from '@ecoma-io/pact-broker-api-infrastructure';

import { samplePact } from '../fixtures/pact';
import { type PactBrokerDatabase, PACT_BROKER_DATABASE, startPactBrokerDatabase } from './harness';

/** `require('wrangler')` thay vì `await import`: CLI bundle lớn (tiền lệ llm-seller). */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');
type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

const APP_DIR = resolve(import.meta.dirname, '..', '..');
const BASE = 'http://worker.invalid';

/** Biến môi trường mà Hyperdrive local emulation đọc lúc harness được dựng (PF3). */
const HD_LOCAL_ENV = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE';

let harness: TestHarness;
let db: PactBrokerDatabase;
let tenantASecret = '';
const savedEnv = { value: undefined as string | undefined, had: false };

/** Chuỗi kết nối runtime-role — đúng credential mà Worker nhận qua Hyperdrive. */
function runtimeConnectionString(): string {
  return `postgres://ecoma_pact_broker_runtime:ecoma_test_role_pw@${db.host}:${db.port}/${PACT_BROKER_DATABASE}`;
}

async function fetchJson(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await harness.fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // non-JSON — giữ text
  }
  return { status: res.status, body };
}

const auth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

beforeAll(async () => {
  db = await startPactBrokerDatabase();

  // Bootstrap hai tenant + token admin qua repo trực tiếp (đường dashboard dùng),
  // đúng pattern `api.spec.ts`.
  const pool = await db.createRuntimePool();
  try {
    const repo = new Infra.PgTenantRepo(pool);
    await repo.ensureDefaultTenant('tenant-a', 'sub-a-owner');
    const token = await repo.createMachineToken(
      (await repo.getTenantByName('tenant-a'))?.id ?? '',
      'sub-a-owner',
      'ci-worker-runtime',
      ['admin'],
    );
    tenantASecret = token.token;
  } finally {
    await pool.end();
  }

  // Hyperdrive local đọc biến môi trường lúc binding được DỰNG — phải set
  // TRƯỚC `createTestHarness` (giá trị cũ được giữ để restore, cùng luật
  // `apps/backoffice/tests/integrations/worker-runtime.spec.ts`).
  savedEnv.had = HD_LOCAL_ENV in process.env;
  savedEnv.value = process.env[HD_LOCAL_ENV];
  process.env[HD_LOCAL_ENV] = runtimeConnectionString();

  harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [{ configPath: resolve(APP_DIR, 'wrangler.jsonc') }],
  });
  await harness.listen();
}, 300_000);

afterAll(async () => {
  // Dọn ngược thứ tự: workerd trước (đóng mọi socket của runtime), rồi kiểm
  // PostgreSQL không còn connection nào của runtime role, rồi container.
  await harness?.close().catch(() => undefined);
  if (savedEnv.had) {
    process.env[HD_LOCAL_ENV] = savedEnv.value;
  } else {
    Reflect.deleteProperty(process.env, HD_LOCAL_ENV);
  }
  await stopAndAssertNoLeakedConnections();
}, 120_000);

/**
 * Sau khi workerd tắt, PostgreSQL không được còn connection nào của runtime
 * role — kiểm đây là vệ sinh teardown: bắt socket còn SÓNG sau khi runtime đã
 * kết thúc (rò ngoài vòng đời runtime). Kỷ luật `end()` theo invocation thì
 * unit lifecycle specs giữ, không phải check này — workerd tắt là mọi socket
 * của nó đóng theo, nên một pool quên `end()` không hiện được ở đây. Poll ngắn
 * cho giống dọn dẹp hệ điều hành.
 */
async function stopAndAssertNoLeakedConnections(): Promise<void> {
  // Setup có thể ném giữa chừng (vd Docker port race) khi `db` chưa gán —
  // không có container nào để kiểm, cleanup chỉ cần không ném thêm.
  if (db === undefined) return;
  const { Client: PgClient } = await import('pg');
  const client = new PgClient({
    host: db.host,
    port: db.port,
    user: 'ecoma_test_superuser',
    password: 'ecoma_test_superuser_pw',
    database: PACT_BROKER_DATABASE,
  });
  await client.connect();
  try {
    let leaked: unknown[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      const { rows } = await client.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE usename = 'ecoma_pact_broker_runtime'`,
      );
      leaked = rows;
      if (rows.length === 0) break;
      await new Promise((r) => {
        setTimeout(r, 500);
      });
    }
    expect(leaked).toEqual([]);
  } finally {
    await client.end();
    await db?.stop();
  }
}

describe('pact-broker-api worker runtime (issue #118)', () => {
  it('serves /health without touching the database or credentials', async () => {
    const { status, body } = await fetchJson('/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', service: 'pact-broker-api' });
  }, 30_000);

  it('serves at least 10 sequential DB-reading requests on one isolate without restart or hang', async () => {
    // Acceptance của #118: request đọc-DB lặp liên tục trên CÙNG isolate —
    // với Pool cache module-scope, request thứ hai trở đi treo vĩnh viễn
    // ("code had hung") hoặc connect-timeout; với pool-per-request, mọi
    // request tạo connection mới trong context của mình và phải 200/404
    // theo nội dung. 12 lượt > mốc 10 của acceptance.
    for (let i = 0; i < 12; i++) {
      const { status, body } = await fetchJson('/', { headers: auth(tenantASecret) });
      expect(status, `sequential request ${i + 1} failed`).toBe(200);
      expect(body).toMatchObject({ _links: expect.any(Object) });
    }
  }, 120_000);

  it('serves concurrent DB-reading requests with simultaneous physical connections on one isolate', async () => {
    // (1) Nhiều request đồng thời — mỗi request một pool riêng sống song song
    // trong cùng isolate: ≥2 connection vật lý ĐỒNG THỜI xuyên invocation
    // (giả thuyết giới hạn "1 connection/isolate" của Miniflare đã bị bác bỏ).
    // (2) POST /environments đi qua HAI client kế tiếp của pool trong MỘT
    // invocation (repo qua `pool.query`, rồi audit client qua `pool.connect()`
    // cho transaction audit) — kiểm đường checkout-lần-hai trong cùng request.
    // Tuần tự, không đồng thời: không route nào hiện giữ 2 connection cùng lúc
    // trong một invocation.
    const reads = await Promise.all(
      [0, 1, 2].map((i) =>
        fetchJson('/', { headers: auth(tenantASecret) }).then(({ status, body }) => {
          expect(status, `concurrent read ${i} failed`).toBe(200);
          expect(body).toMatchObject({ _links: expect.any(Object) });
          return true;
        }),
      ),
    );
    expect(reads).toHaveLength(3);

    const create = await fetchJson('/environments', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({ name: 'worker-runtime-env' }),
    });
    expect(create.status).toBe(201);
    expect(create.body).toMatchObject({ name: 'worker-runtime-env' });

    const again = await fetchJson('/environments', {
      method: 'POST',
      headers: auth(tenantASecret),
      body: JSON.stringify({ name: 'worker-runtime-env' }),
    });
    expect(again.status).toBe(201);
  }, 60_000);

  it('publishes a pact through the real worker — transaction path survives the per-request pool', async () => {
    // Publish đi qua transaction (BEGIN/COMMIT trên PoolClient, release trong
    // finally) — pool-per-request không được đổi semantics của nó.
    const path = '/pacts/provider/payment-service/consumer/order-service/version/1.0.0';
    const first = await fetchJson(path, {
      method: 'PUT',
      headers: auth(tenantASecret),
      body: JSON.stringify(samplePact({ consumer: 'order-service', provider: 'payment-service' })),
    });
    expect(first.status).toBe(201);

    const republish = await fetchJson(path, {
      method: 'PUT',
      headers: auth(tenantASecret),
      body: JSON.stringify(samplePact({ consumer: 'order-service', provider: 'payment-service' })),
    });
    expect(republish.status).toBe(200);
  }, 60_000);
});
