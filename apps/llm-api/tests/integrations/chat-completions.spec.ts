/**
 * Integration serving của POST /v1/chat/completions (slice P4, Issue #24):
 * admission → dispatch → settlement đo trên runtime Worker thật (workerd qua
 * `createTestHarness`, cùng mô hình `http-contract.spec.ts`) + PostgreSQL thật
 * (ba binding Hyperdrive local) + mock upstream thật (`tools/llm-upstream-mock`
 * spawn làm tiến trình con — module boundary cấm import, xem `upstream-mock.ts`).
 *
 * Nhóm kịch bản ghim các invariant của #24 ở tầng HTTP + database:
 * - Happy path: 200 envelope OpenAI, charge = admission amount của usage thật,
 *   quota `settled`, financial reservation `captured`, charge row `posted`.
 * - Auth: thiếu header/key lạ → 401; key revoked → 403; tenant isolation — key
 *   tenant khác ghi journal/quota/wallet DƯỚI tenant của nó, không đụng dữ liệu
 *   tenant kia.
 * - Fail-closed trước dispatch (không có row journal nào): model không có offer
 *   → 404; không endpoint khoẻ → 503 `no_candidate`; credential lệch hash → 503
 *   `upstream_credential_unavailable`; restriction chat hiệu lực → 403.
 * - Validation: `stream:true` → 400; thiếu `max_tokens` → 422; method GET/HEAD
 *   trên path POST → 405 `allow: POST` (hợp đồng 405 mở rộng, invariant 12).
 * - Bảng mapping upstream (evidence của invariant 6/F5): 401 structured refusal
 *   → `confirmed_not_executed` + release CẢ reservation; 429 → 429 forward
 *   Retry-After + release; 500/timeout → `may_have_executed` + settle capped
 *   tại held (KHÔNG timeout-release); 200 malformed → `confirmed_completed` +
 *   usage missing + settle capped + 502.
 * - Idempotency: replay cùng `x-request-id` → 409 `request_id_replay`, đúng
 *   MỘT attempt/charge; payload khác cùng id → 409 `idempotency_conflict`.
 * - Trần quota concurrent: hai request song song với trần vừa đủ → đúng một
 *   200 (khoá FOR UPDATE trên `tenant_quota` serialize admission per-tenant).
 * - Trần metadata-only: catalogue cột journal không có cột nội dung; capture
 *   log của mock không chứa prompt/response/key plaintext (hàng rào chống lộ).
 *
 * Hyperdrive local đọc env lúc dựng binding nên mọi env (connection string,
 * `CLOUDFLARE_INCLUDE_PROCESS_ENV`, hai biến `LLM_UPSTREAM_*`) phải set TRƯỚC
 * `createTestHarness`. `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` là kênh production
 * WIC dùng để đưa `LLM_UPSTREAM_PROVIDER`/`LLM_UPSTREAM_CREDENTIAL_PLAINTEXT`
 * vào worker (`deploys/llm-api-deploy` container envs) — test dùng đúng kênh
 * đó, không .dev.vars, không đụng `wrangler.jsonc`.
 *
 * Docker là phụ thuộc cứng (globalSetup probe và NÉM khi thiếu) — suite ĐỎ chứ
 * không skip. Seed là SQL trực tiếp idempotent (`ON CONFLICT DO NOTHING`);
 * migration `0005` seed sẵn pricing snapshot `dronie-flash` khi apply.
 */
import { createHash } from 'node:crypto';
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
import { startUpstreamMock, stopAllUpstreamMocks, type UpstreamMockProcess } from './upstream-mock';

const APP_DIR = resolve(import.meta.dirname, '..', '..');

/** `require('wrangler')` thay vì `await import`: CLI bundle lớn (tiền lệ http-contract). */
const wranglerCli = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');

type TestHarness = Awaited<ReturnType<typeof wranglerCli.createTestHarness>>;

const WORKER_CONFIG_PATH = resolve(APP_DIR, 'wrangler.jsonc');

const BINDING_BY_KEY: Record<LlmDatabaseKey, string> = {
  gateway: 'DB_LLM_GATEWAY',
  tenant: 'DB_LLM_TENANT',
  marketplace: 'DB_LLM_MARKETPLACE',
};

// ---------------------------------------------------------------------------
// Hằng số kịch bản — mọi id tất định, khớp derivation của `admission.ts`
// ---------------------------------------------------------------------------

/** Provider upstream của test (trục provider của credential + env worker). */
const UPSTREAM_PROVIDER = 'mock-openai';
/** Plaintext credential serving — chỉ sống trong env worker + header upstream. */
const UPSTREAM_KEY = 'itest-upstream-credential-plaintext';

/** Endpoint path mà serving dispatch lên mock (mock route đúng path này). */
const UPSTREAM_PATH = '/v1/chat/completions';

/** Nội dung mock trả — deterministic để assert usage/charge. */
const MOCK_CONTENT = 'Dronie at your service.';
/** Model upstream raw — khớp `MOCK_UPSTREAM_MODELS` và offer `normalized_model_id`. */
const UPSTREAM_MODEL = 'dronie-flash';

const SELLER_TENANT_ID = 'seller-tenant-itest';
const OFFER_ID = 'offer-itest-dronie';
const POOL_ID = 'pool-itest-dronie';
const ENDPOINT_ID = 'endpoint-itest-dronie';
const CREDENTIAL_ID = 'credential-itest-1';

const TENANT_MAIN = 'tenant-ecoma-main-itest';
const KEY_MAIN = 'itest-key-main-plaintext';
const BILLING_MAIN = 'billing-account-main-itest';

const TENANT_B = 'tenant-ecoma-b-itest';
const KEY_B = 'itest-key-b-plaintext';
const BILLING_B = 'billing-account-b-itest';

const TENANT_REVOKED = 'tenant-ecoma-revoked-itest';
const KEY_REVOKED = 'itest-key-revoked-plaintext';

const TENANT_QUOTA = 'tenant-quota-itest';
const KEY_QUOTA = 'itest-key-quota-plaintext';
const BILLING_QUOTA = 'billing-account-quota-itest';
const QUOTA_AUTHZ_ID = 'authz-itest-quota';
const QUOTA_GRANT_ID = 'grant-itest-quota';

const SPONSOR_ID = 'sponsor-itest';
/** Trần sponsor/authorization — đủ lớn để không cản các test thường. */
const SPONSOR_CEILING = 10_000_000n;
/** Grant mỗi tenant main/b — credited bền, replay của serving post bút toán. */
const GRANT_AMOUNT = 1_000_000n;

const MAIN_AUTHZ_ID = 'authz-itest-main';
const MAIN_GRANT_ID = 'grant-itest-main';
const B_AUTHZ_ID = 'authz-itest-b';
const B_GRANT_ID = 'grant-itest-b';

// Pricing seed của migration 0005: VND 5000/15000 per 1M, cap 8192/4096 —
// các hằng số hold/charge dưới đây suy ra từ schedule đó.

/** Prompt test 'hello world' — 11 ký tự → ceil(11/2) = 6 token input. */
const PROMPT_TEXT = 'hello world';
/** Token cap output client-side. */
const MAX_TOKENS = 16;
/** Hold: ceil(6×5000/1M) + ceil(16×15000/1M) = 1 + 1 = 2 minor UC. */
const HOLD_AMOUNT = 2n;
const HOLD_TOKENS = 6n + 16n;

/** Usage của mock 'ok' — estimateTokens(JSON.stringify('dronie-flash'))=4, estimateTokens(content)=6. */
const MOCK_PROMPT_TOKENS = 4;
const MOCK_COMPLETION_TOKENS = 6;
/** Charge thật theo usage: ceil(4×5000/1M) + ceil(6×15000/1M) = 1 + 1 = 2 minor. */
const EXPECTED_CHARGE = 2n;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function keyHash(key: string): string {
  return sha256Hex(key);
}

/** Id quota reservation tất định của một request (khớp `deriveQuotaReservationId`). */
const quotaReservationId = (requestId: string): string => `quota:${requestId}`;

/** Id financial reservation tất định của (request, attempt 1). */
const financialReservationId = (requestId: string): string =>
  `finres:${requestId}:attempt:${requestId}:1`;

const chargeId = (requestId: string): string => `charge:${requestId}:attempt:${requestId}:1`;

// ---------------------------------------------------------------------------
// Harness + seed
// ---------------------------------------------------------------------------

let db: LlmApiDatabase;
let harness: TestHarness;
let degradedHarness: TestHarness | undefined;
const mocks: Partial<Record<string, UpstreamMockProcess>> = {};

const previousEnv = new Map<string, string | undefined>();

function setEnv(name: string, value: string): void {
  previousEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function restoreEnv(): void {
  for (const [name, previous] of previousEnv) {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = previous;
    }
  }
  previousEnv.clear();
}

function hyperdriveEnvName(binding: string): string {
  return `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`;
}

/** POST body chat qua worker runtime. */
interface ChatResponse {
  readonly status: number;
  readonly contentType: string;
  readonly retryAfter: string;
  readonly body: string;
}

async function chatPost(
  path: string,
  init: {
    key?: string;
    requestId?: string;
    body?: unknown;
    method?: string;
  } = {},
): Promise<ChatResponse> {
  const headers: Record<string, string> = {};
  if (init.key !== undefined) {
    headers['authorization'] = `Bearer ${init.key}`;
  }
  if (init.requestId !== undefined) {
    headers['x-request-id'] = init.requestId;
  }
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await harness.fetch(`http://worker.invalid${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    retryAfter: response.headers.get('retry-after') ?? '',
    body: await response.text(),
  };
}

const VALID_BODY = {
  model: UPSTREAM_MODEL,
  messages: [{ role: 'user', content: PROMPT_TEXT }],
  max_tokens: MAX_TOKENS,
};

function expectJson(body: string): Record<string, unknown> {
  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(body) as unknown;
  }).not.toThrow();
  return parsed as Record<string, unknown>;
}

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

/** Seed toàn bộ dữ liệu phục vụ các kịch bản (idempotent — re-run no-op). */
async function seedServingData(okMockUrl: string): Promise<void> {
  const upstreamUrl = `${okMockUrl}${UPSTREAM_PATH}`;
  const now = 1_760_000_000_000;

  const gateway = await db.connect('gateway');
  const marketplace = await db.connect('marketplace');
  const tenant = await db.connect('tenant');
  try {
    // Seller tenant + restriction surface (không row hiệu lực khi seed).
    await gateway.query(
      `INSERT INTO llm_seller.seller_tenants (id, name, classification, owner_sub, created_at)
       VALUES ($1, 'dronie', 'first_party', 'itest-superadmin-sub', $2)
       ON CONFLICT (id) DO NOTHING`,
      [SELLER_TENANT_ID, now],
    );

    // Offer active + endpoint pool + endpoint khoẻ trỏ mock 'ok'.
    await marketplace.query(
      `INSERT INTO llm_marketplace.model_offers
         (id, seller_tenant_id, normalized_model_id, status, public_alias, capabilities, created_at, updated_at, activated_at, deactivated_at, retired_at)
       VALUES ($1, $2, $3, 'active', NULL, '["chat"]'::jsonb, $4, $4, $4, NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [OFFER_ID, SELLER_TENANT_ID, UPSTREAM_MODEL, now],
    );
    await marketplace.query(
      `INSERT INTO llm_marketplace.endpoint_pools (id, offer_id, created_at, updated_at)
       VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
      [POOL_ID, OFFER_ID, now],
    );
    await marketplace.query(
      `INSERT INTO llm_marketplace.upstream_endpoints
         (id, pool_id, url, protocol, health, weight, created_at, health_recorded_at, updated_at)
       VALUES ($1, $2, $3, 'openai-chat', 'healthy', 500, $4, $4, $4)
       ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, health = 'healthy'`,
      [ENDPOINT_ID, POOL_ID, upstreamUrl, now],
    );
    // Credential serving — hash của plaintext env (invariant 8).
    await marketplace.query(
      `INSERT INTO llm_marketplace.provider_credentials
         (id, provider, seller_tenant_id, credential_hash, created_by, created_at, revoked_at, revoked_by)
       VALUES ($1, $2, $3, $4, 'itest', $5, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET credential_hash = EXCLUDED.credential_hash, revoked_at = NULL, revoked_by = NULL`,
      [CREDENTIAL_ID, UPSTREAM_PROVIDER, SELLER_TENANT_ID, sha256Hex(UPSTREAM_KEY), now],
    );

    // Consumer tenants + api keys (hash-only).
    const tenants: Array<[string, string]> = [
      [TENANT_MAIN, 'ecoma-main'],
      [TENANT_B, 'ecoma-b'],
      [TENANT_REVOKED, 'ecoma-revoked'],
      [TENANT_QUOTA, 'ecoma-quota'],
    ];
    for (const [tenantId, tenantName] of tenants) {
      await tenant.query(
        `INSERT INTO llm_tenant.tenants (id, name, classification, owner_sub, created_at)
         VALUES ($1, $2, 'customer', 'itest-owner-sub', $3) ON CONFLICT (id) DO NOTHING`,
        [tenantId, tenantName, now],
      );
    }
    const keys: Array<[string, string, string, number | null]> = [
      ['apikey-itest-main', TENANT_MAIN, KEY_MAIN, null],
      ['apikey-itest-b', TENANT_B, KEY_B, null],
      ['apikey-itest-revoked', TENANT_REVOKED, KEY_REVOKED, now],
      ['apikey-itest-quota', TENANT_QUOTA, KEY_QUOTA, null],
    ];
    for (const [keyId, tenantId, plaintext, revokedAt] of keys) {
      await gateway.query(
        `INSERT INTO llm_gateway.api_keys (id, tenant_id, key_hash, created_by, created_at, revoked_at, revoked_by)
         VALUES ($1, $2, $3, 'itest', $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET key_hash = EXCLUDED.key_hash, revoked_at = EXCLUDED.revoked_at, revoked_by = EXCLUDED.revoked_by`,
        [keyId, tenantId, keyHash(plaintext), now, revokedAt, revokedAt === null ? null : 'itest'],
      );
    }

    // Financial: billing account + sponsor funding 'credited' (chưa có bút toán
    // credit trong ledger — serving replay post đúng như step-10 bootstrap đã ghi).
    const fundings: Array<[string, string, string, string]> = [
      [BILLING_MAIN, MAIN_AUTHZ_ID, MAIN_GRANT_ID, TENANT_MAIN],
      [BILLING_B, B_AUTHZ_ID, B_GRANT_ID, TENANT_B],
      // Tenant trần quota cũng cần funding: admission reserve quota TRƯỚC rồi
      // mở financial reserve — thiếu billing account là 503 trước khi chạm trần.
      [BILLING_QUOTA, QUOTA_AUTHZ_ID, QUOTA_GRANT_ID, TENANT_QUOTA],
    ];
    for (const [billingId, , , tenantId] of fundings) {
      await gateway.query(
        `INSERT INTO llm_financial.billing_accounts (billing_account_id, tenant_ref, owner_ref, created_at)
         VALUES ($1, $2, 'ecoma', $3) ON CONFLICT (billing_account_id) DO NOTHING`,
        [billingId, tenantId, now],
      );
    }
    await gateway.query(
      `INSERT INTO llm_financial.sponsors (sponsor_id, owner_ref, ceiling_minor, ceiling_denomination, status, created_at, created_by)
       VALUES ($1, 'itest', $2, 'UC', 'active', $3, 'itest') ON CONFLICT (sponsor_id) DO NOTHING`,
      [SPONSOR_ID, SPONSOR_CEILING.toString(), now],
    );
    for (const [billingId, authzId, grantId] of fundings) {
      await gateway.query(
        `INSERT INTO llm_financial.sponsor_funding_authorizations
           (authorization_id, sponsor_id, billing_account_id, ceiling_minor, ceiling_denomination, status, evidence_ref, created_at, created_by)
         VALUES ($1, $2, $3, $4, 'UC', 'active', 'itest-evidence', $5, 'itest') ON CONFLICT (authorization_id) DO NOTHING`,
        [authzId, SPONSOR_ID, billingId, SPONSOR_CEILING.toString(), now],
      );
      await gateway.query(
        `INSERT INTO llm_financial.sponsor_grants
           (grant_id, authorization_id, sponsor_id, billing_account_id, amount_minor, amount_denomination, state, actor_ref, created_at)
         VALUES ($1, $2, $3, $4, $5, 'UC', 'credited', 'itest', $6) ON CONFLICT (grant_id) DO NOTHING`,
        [grantId, authzId, SPONSOR_ID, billingId, GRANT_AMOUNT.toString(), now],
      );
    }
  } finally {
    await gateway.end();
    await marketplace.end();
    await tenant.end();
  }
}

beforeAll(async () => {
  // Chụp giá trị env cũ NGAY ĐẦU (tiền lệ http-contract.spec) — afterAll khôi
  // phục đúng trạng thái ban đầu kể cả khi setup ném lỗi giữa chừng.
  for (const binding of Object.values(BINDING_BY_KEY)) {
    previousEnv.set(hyperdriveEnvName(binding), process.env[hyperdriveEnvName(binding)]);
  }

  db = await startLlmApiDatabase();

  // Connection string runtime cho cả ba binding — set TRƯỚC createTestHarness.
  for (const key of ['gateway', 'tenant', 'marketplace'] as const) {
    const url = roleConnectionString(runtimeRole(key), databaseName(key), db.host, db.port);
    setEnv(hyperdriveEnvName(BINDING_BY_KEY[key]), url);
  }
  // Kênh env của production WIC: biến process trở thành worker bindings
  // (wrangler loadDotEnv includeProcessEnv) — provider + plaintext credential.
  setEnv('CLOUDFLARE_INCLUDE_PROCESS_ENV', 'true');
  setEnv('LLM_UPSTREAM_PROVIDER', UPSTREAM_PROVIDER);
  setEnv('LLM_UPSTREAM_CREDENTIAL_PLAINTEXT', UPSTREAM_KEY);

  // Sáu mock scenario — mỗi cái một port ephemeral; test đổi URL endpoint row.
  mocks['ok'] = await startUpstreamMock({
    MOCK_UPSTREAM_SCENARIO: 'ok',
    MOCK_UPSTREAM_MODELS: JSON.stringify([UPSTREAM_MODEL]),
    MOCK_UPSTREAM_CONTENT: MOCK_CONTENT,
    MOCK_UPSTREAM_EXPECTED_AUTHORIZATION: JSON.stringify([`Bearer ${UPSTREAM_KEY}`]),
  });
  for (const scenario of ['unauthorized', 'rate_limited', 'server_error', 'malformed'] as const) {
    mocks[scenario] = await startUpstreamMock({ MOCK_UPSTREAM_SCENARIO: scenario });
  }
  // Timeout: mock treo socket 45s — worker tự abort ở 30s trước (F5 đo phía serving).
  mocks['timeout'] = await startUpstreamMock({
    MOCK_UPSTREAM_SCENARIO: 'timeout',
    MOCK_UPSTREAM_TIMEOUT_MS: '45000',
  });

  await seedServingData(mocks['ok']?.url ?? '');

  harness = wranglerCli.createTestHarness({
    root: APP_DIR,
    workers: [{ configPath: WORKER_CONFIG_PATH }],
  });
  await harness.listen();
}, 300_000);

afterAll(async () => {
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
      await stopAllUpstreamMocks();
    },
    async () => {
      if (db !== undefined) {
        await db.stop();
      }
    },
    async () => {
      restoreEnv();
    },
  );
});

// ---------------------------------------------------------------------------
// Đọc DB phục vụ assertion
// ---------------------------------------------------------------------------

interface JournalRow {
  readonly status: string;
  readonly evidence: string | null;
  readonly usage_status: string | null;
  readonly input_tokens: string | null;
  readonly output_tokens: string | null;
  readonly charge_minor: string | null;
  readonly error_code: string | null;
}

async function journalRow(requestId: string): Promise<JournalRow | null> {
  const client = await db.connect('gateway');
  try {
    const result = await client.query<JournalRow>(
      `SELECT status, evidence, usage_status, input_tokens, output_tokens, charge_minor, error_code
         FROM llm_gateway.logical_requests WHERE request_id = $1`,
      [requestId],
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

interface QuotaRow {
  readonly state: string;
  readonly token_amount: string;
  readonly settled_tokens: string | null;
}

async function quotaRow(requestId: string): Promise<QuotaRow | null> {
  const client = await db.connect('gateway');
  try {
    const result = await client.query<QuotaRow>(
      `SELECT state, token_amount, settled_tokens FROM llm_gateway.quota_reservations
        WHERE reservation_id = $1`,
      [quotaReservationId(requestId)],
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

interface FinancialReservationRow {
  readonly state: string;
  readonly reserved_minor: string;
  readonly captured_minor: string;
  readonly released_minor: string;
}

async function financialReservationRow(requestId: string): Promise<FinancialReservationRow | null> {
  const client = await db.connect('gateway');
  try {
    const result = await client.query<FinancialReservationRow>(
      `SELECT state, reserved_minor, captured_minor, released_minor FROM llm_financial.financial_reservations
        WHERE reservation_id = $1`,
      [financialReservationId(requestId)],
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

interface ChargeRow {
  readonly state: string;
  readonly amount_minor: string;
}

async function chargeRow(requestId: string): Promise<ChargeRow | null> {
  const client = await db.connect('gateway');
  try {
    const result = await client.query<ChargeRow>(
      `SELECT state, amount_minor FROM llm_financial.customer_charges WHERE charge_id = $1`,
      [chargeId(requestId)],
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

interface AttemptEvidenceRow {
  readonly evidence: string;
  readonly usage_status: string | null;
  readonly ended_at: number | null;
}

async function attemptEvidence(requestId: string): Promise<AttemptEvidenceRow | null> {
  const client = await db.connect('gateway');
  try {
    const result = await client.query<AttemptEvidenceRow>(
      `SELECT evidence, usage_status, ended_at FROM llm_gateway.attempts
        WHERE request_id = $1 AND attempt_no = 1`,
      [requestId],
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

async function countRows(sql: string, params: readonly unknown[]): Promise<number> {
  const client = await db.connect('gateway');
  try {
    const result = await client.query<{ count: string }>(sql, params as unknown[]);
    return Number(result.rows[0]?.count ?? '0');
  } finally {
    await client.end();
  }
}

/** Đổi URL endpoint của offer sang mock một scenario, trả hàm khôi phục 'ok'. */
async function pointEndpointAt(mockUrl: string): Promise<() => Promise<void>> {
  const marketplace = await db.connect('marketplace');
  try {
    await marketplace.query(
      `UPDATE llm_marketplace.upstream_endpoints SET url = $1 WHERE id = $2`,
      [`${mockUrl}${UPSTREAM_PATH}`, ENDPOINT_ID],
    );
  } finally {
    await marketplace.end();
  }
  return async () => {
    const restore = await db.connect('marketplace');
    try {
      await restore.query(`UPDATE llm_marketplace.upstream_endpoints SET url = $1 WHERE id = $2`, [
        `${mocks['ok']?.url ?? ''}${UPSTREAM_PATH}`,
        ENDPOINT_ID,
      ]);
    } finally {
      await restore.end();
    }
  };
}

// ---------------------------------------------------------------------------
// Kịch bản
// ---------------------------------------------------------------------------

describe('POST /v1/chat/completions serving (worker runtime + PostgreSQL + mock upstream)', () => {
  it('serves a completion from the active offer, settles the usage-based charge and journals metadata only', async () => {
    const requestId = 'itest-req-ok';
    const response = await chatPost('/v1/chat/completions', {
      key: KEY_MAIN,
      requestId,
      body: VALID_BODY,
    });

    expect(response.status).toBe(200);
    expect(response.contentType).toBe('application/json');
    const body = expectJson(response.body);
    expect(body['id']).toBe(`chatcmpl-${requestId}`);
    expect(body['object']).toBe('chat.completion');
    // Model identity trả client là alias catalogue, không phải giá trị khác.
    expect(body['model']).toBe(UPSTREAM_MODEL);
    const choices = body['choices'] as Array<{
      index: number;
      message: { role: string; content: string };
      finish_reason: string | null;
    }>;
    expect(choices).toHaveLength(1);
    expect(choices[0]?.message).toEqual({ role: 'assistant', content: MOCK_CONTENT });
    expect(body['usage']).toEqual({
      prompt_tokens: MOCK_PROMPT_TOKENS,
      completion_tokens: MOCK_COMPLETION_TOKENS,
      total_tokens: MOCK_PROMPT_TOKENS + MOCK_COMPLETION_TOKENS,
    });

    // Journal: completed + evidence confirmed_completed + usage known + charge đúng.
    const journal = await journalRow(requestId);
    expect(journal).not.toBeNull();
    expect(journal?.status).toBe('completed');
    expect(journal?.evidence).toBe('confirmed_completed');
    expect(journal?.usage_status).toBe('known');
    expect(journal?.input_tokens).toBe(MOCK_PROMPT_TOKENS.toString());
    expect(journal?.output_tokens).toBe(MOCK_COMPLETION_TOKENS.toString());
    expect(journal?.charge_minor).toBe(EXPECTED_CHARGE.toString());
    expect(journal?.error_code).toBeNull();

    // Quota: settled đúng usage thật (invariant 1: reserve trước, settle sau).
    const quota = await quotaRow(requestId);
    expect(quota?.state).toBe('settled');
    expect(quota?.token_amount).toBe(HOLD_TOKENS.toString());
    expect(quota?.settled_tokens).toBe((MOCK_PROMPT_TOKENS + MOCK_COMPLETION_TOKENS).toString());

    // Financial: reservation captured tại charge thật; charge row posted.
    const reservation = await financialReservationRow(requestId);
    expect(reservation?.state).toBe('captured');
    expect(reservation?.reserved_minor).toBe(HOLD_AMOUNT.toString());
    expect(reservation?.captured_minor).toBe(EXPECTED_CHARGE.toString());
    expect(reservation?.released_minor).toBe('0');
    const charge = await chargeRow(requestId);
    expect(charge?.state).toBe('posted');
    expect(charge?.amount_minor).toBe(EXPECTED_CHARGE.toString());

    // Attempt: evidence cuối + end time (evidence chỉ strengthen).
    const attempt = await attemptEvidence(requestId);
    expect(attempt?.evidence).toBe('confirmed_completed');
    expect(attempt?.usage_status).toBe('known');
    expect(attempt?.ended_at).not.toBeNull();

    // Replay credit grant của bootstrap đã được serving post vào ledger
    // (projection wallet/ledger thuộc serving slice).
    const ledgerTxCount = await countRows(
      `SELECT count(*)::text AS count FROM llm_financial.ledger_transactions
        WHERE transaction_id = $1`,
      [`sponsor_grant:${MAIN_GRANT_ID}:credit`],
    );
    expect(ledgerTxCount).toBe(1);
  });

  it('answers 409 request_id_replay for the same x-request-id and payload without a second attempt or charge', async () => {
    const requestId = 'itest-req-ok';
    const before = await countRows(
      'SELECT count(*)::text AS count FROM llm_gateway.attempts WHERE request_id = $1',
      [requestId],
    );

    const response = await chatPost('/v1/chat/completions', {
      key: KEY_MAIN,
      requestId,
      body: VALID_BODY,
    });

    expect(response.status).toBe(409);
    const body = expectJson(response.body);
    const error = body['error'] as { code: string | null };
    expect(error.code).toBe('request_id_replay');

    const after = await countRows(
      'SELECT count(*)::text AS count FROM llm_gateway.attempts WHERE request_id = $1',
      [requestId],
    );
    expect(after).toBe(before);
    expect(after).toBe(1);
    // Terminal replay mở reserve mới: quota reservation vẫn đúng một row.
    const quotaCount = await countRows(
      'SELECT count(*)::text AS count FROM llm_gateway.quota_reservations WHERE request_id = $1',
      [requestId],
    );
    expect(quotaCount).toBe(1);
  });

  it('answers 409 idempotency_conflict when the same x-request-id carries a different payload', async () => {
    const response = await chatPost('/v1/chat/completions', {
      key: KEY_MAIN,
      requestId: 'itest-req-ok',
      body: { ...VALID_BODY, max_tokens: MAX_TOKENS + 1 },
    });
    expect(response.status).toBe(409);
    const error = expectJson(response.body)['error'] as { code: string | null };
    expect(error.code).toBe('idempotency_conflict');
  });

  it('rejects a missing Authorization header with 401 invalid_api_key before any journal write', async () => {
    const before = await countRows(
      `SELECT count(*)::text AS count FROM llm_gateway.logical_requests WHERE tenant_id = $1`,
      [TENANT_MAIN],
    );
    const response = await chatPost('/v1/chat/completions', { body: VALID_BODY });
    expect(response.status).toBe(401);
    const error = expectJson(response.body)['error'] as { code: string | null; type: string };
    expect(error.code).toBe('invalid_api_key');
    expect(error.type).toBe('invalid_request_error');

    const after = await countRows(
      `SELECT count(*)::text AS count FROM llm_gateway.logical_requests WHERE tenant_id = $1`,
      [TENANT_MAIN],
    );
    expect(after).toBe(before);
  });

  it('rejects an unknown key with 401 invalid_api_key', async () => {
    const response = await chatPost('/v1/chat/completions', {
      key: 'itest-unknown-key',
      body: VALID_BODY,
    });
    expect(response.status).toBe(401);
    expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
      'invalid_api_key',
    );
  });

  it('rejects a revoked key with 403 api_key_revoked', async () => {
    const response = await chatPost('/v1/chat/completions', {
      key: KEY_REVOKED,
      requestId: 'itest-req-revoked',
      body: VALID_BODY,
    });
    expect(response.status).toBe(403);
    expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
      'api_key_revoked',
    );
    expect(await journalRow('itest-req-revoked')).toBeNull();
  });

  it('keeps tenant data isolated: another tenant key journals and reserves under its own ids only', async () => {
    const requestId = 'itest-req-tenant-b';
    const mainRowsBefore = await countRows(
      `SELECT count(*)::text AS count FROM llm_gateway.logical_requests WHERE tenant_id = $1`,
      [TENANT_MAIN],
    );
    const mainQuotaBefore = await countRows(
      `SELECT count(*)::text AS count FROM llm_gateway.quota_reservations WHERE tenant_id = $1`,
      [TENANT_MAIN],
    );

    const response = await chatPost('/v1/chat/completions', {
      key: KEY_B,
      requestId,
      body: VALID_BODY,
    });
    expect(response.status).toBe(200);

    // Journal + quota của request này nằm dưới tenant B, không phải tenant main.
    const owner = await countRows(
      `SELECT count(*)::text AS count FROM llm_gateway.logical_requests
        WHERE request_id = $1 AND tenant_id = $2`,
      [requestId, TENANT_B],
    );
    expect(owner).toBe(1);
    const quotaOwner = await countRows(
      `SELECT count(*)::text AS count FROM llm_gateway.quota_reservations
        WHERE request_id = $1 AND tenant_id = $2`,
      [requestId, TENANT_B],
    );
    expect(quotaOwner).toBe(1);
    expect(await journalRow(requestId)).not.toBeNull();

    // Tenant main không có row mới nào (invariant 11: key tenant khác không thể
    // serve và ghi dữ liệu dưới danh nghĩa tenant kia).
    expect(
      await countRows(
        `SELECT count(*)::text AS count FROM llm_gateway.logical_requests WHERE tenant_id = $1`,
        [TENANT_MAIN],
      ),
    ).toBe(mainRowsBefore);
    expect(
      await countRows(
        `SELECT count(*)::text AS count FROM llm_gateway.quota_reservations WHERE tenant_id = $1`,
        [TENANT_MAIN],
      ),
    ).toBe(mainQuotaBefore);
  });

  it('answers 404 model_not_found for a model with no active offer', async () => {
    const response = await chatPost('/v1/chat/completions', {
      key: KEY_MAIN,
      requestId: 'itest-req-ghost-model',
      body: { ...VALID_BODY, model: 'ghost-model' },
    });
    expect(response.status).toBe(404);
    const error = expectJson(response.body)['error'] as { code: string | null; message: string };
    expect(error.code).toBe('model_not_found');
    // Thông điệp echo đúng model client yêu cầu, không lộ nội bộ.
    expect((error.message as string).includes('ghost-model')).toBe(true);
    expect(await journalRow('itest-req-ghost-model')).toBeNull();
  });

  it('rejects stream:true with 400 streaming_not_supported', async () => {
    const response = await chatPost('/v1/chat/completions', {
      key: KEY_MAIN,
      requestId: 'itest-req-stream',
      body: { ...VALID_BODY, stream: true },
    });
    expect(response.status).toBe(400);
    expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
      'streaming_not_supported',
    );
    expect(await journalRow('itest-req-stream')).toBeNull();
  });

  it('requires max_tokens with 422 max_tokens_required when absent', async () => {
    const response = await chatPost('/v1/chat/completions', {
      key: KEY_MAIN,
      requestId: 'itest-req-no-max-tokens',
      body: { model: UPSTREAM_MODEL, messages: [{ role: 'user', content: PROMPT_TEXT }] },
    });
    expect(response.status).toBe(422);
    expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
      'max_tokens_required',
    );
    expect(await journalRow('itest-req-no-max-tokens')).toBeNull();
  });

  it('answers 405 with allow: POST for GET and HEAD on the chat path, and 405 with allow: GET for POST on the models path', async () => {
    const getResponse = await chatPost('/v1/chat/completions', { method: 'GET' });
    expect(getResponse.status).toBe(405);
    expect(getResponse.retryAfter).toBe('');

    const headResponse = await chatPost('/v1/chat/completions', { method: 'HEAD' });
    expect(headResponse.status).toBe(405);

    const mirrorResponse = await chatPost('/llm/v1/chat/completions', { method: 'PUT' });
    expect(mirrorResponse.status).toBe(405);

    const modelsResponse = await chatPost('/v1/models', {
      method: 'POST',
      key: KEY_MAIN,
      body: VALID_BODY,
    });
    expect(modelsResponse.status).toBe(405);
    expect(modelsResponse.body).toBe('method not allowed');
  });

  it('excludes a draft offer from GET /v1/models while the active one stays listed', async () => {
    const marketplace = await db.connect('marketplace');
    try {
      await marketplace.query(
        `INSERT INTO llm_marketplace.model_offers
           (id, seller_tenant_id, normalized_model_id, status, public_alias, capabilities, created_at, updated_at, activated_at, deactivated_at, retired_at)
         VALUES ('offer-itest-draft', $1, 'dronie-flash-draft', 'draft', NULL, '["chat"]'::jsonb, 1760000000000, 1760000000000, NULL, NULL, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [SELLER_TENANT_ID],
      );
      const response = await harness.fetch('http://worker.invalid/v1/models', { method: 'GET' });
      expect(response.status).toBe(200);
      const body = expectJson(await response.text()) as { data: Array<{ id: string }> };
      const ids = body.data.map((model) => model.id);
      expect(ids).toContain(UPSTREAM_MODEL);
      expect(ids).not.toContain('dronie-flash-draft');
    } finally {
      await marketplace.query(
        `DELETE FROM llm_marketplace.model_offers WHERE id = 'offer-itest-draft'`,
      );
      await marketplace.end();
    }
  });

  it('answers 503 no_candidate and writes nothing when the offer has no healthy endpoint', async () => {
    const marketplace = await db.connect('marketplace');
    try {
      await marketplace.query(
        `UPDATE llm_marketplace.upstream_endpoints SET health = 'down' WHERE id = $1`,
        [ENDPOINT_ID],
      );
      const response = await chatPost('/v1/chat/completions', {
        key: KEY_MAIN,
        requestId: 'itest-req-no-endpoint',
        body: VALID_BODY,
      });
      expect(response.status).toBe(503);
      const error = expectJson(response.body)['error'] as { code: string | null };
      expect(error.code).toBe('no_candidate');
      expect(await journalRow('itest-req-no-endpoint')).toBeNull();
      expect(await quotaRow('itest-req-no-endpoint')).toBeNull();
    } finally {
      await marketplace.query(
        `UPDATE llm_marketplace.upstream_endpoints SET health = 'healthy' WHERE id = $1`,
        [ENDPOINT_ID],
      );
      await marketplace.end();
    }
  });

  it('answers 503 upstream_credential_unavailable when no active credential hash matches the serving plaintext', async () => {
    const marketplace = await db.connect('marketplace');
    try {
      await marketplace.query(
        `UPDATE llm_marketplace.provider_credentials SET credential_hash = 'itest-mismatch-hash' WHERE id = $1`,
        [CREDENTIAL_ID],
      );
      const response = await chatPost('/v1/chat/completions', {
        key: KEY_MAIN,
        requestId: 'itest-req-cred-mismatch',
        body: VALID_BODY,
      });
      expect(response.status).toBe(503);
      expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
        'upstream_credential_unavailable',
      );
      // Không route khi credential lệch (invariant 7/8): không dispatch, không journal.
      expect(await journalRow('itest-req-cred-mismatch')).toBeNull();
      expect(await quotaRow('itest-req-cred-mismatch')).toBeNull();
    } finally {
      await marketplace.query(
        `UPDATE llm_marketplace.provider_credentials SET credential_hash = $1 WHERE id = $2`,
        [sha256Hex(UPSTREAM_KEY), CREDENTIAL_ID],
      );
      await marketplace.end();
    }
  });

  it('denies serving with 403 offer_restricted while a chat restriction is effective on the seller tenant', async () => {
    const gateway = await db.connect('gateway');
    try {
      await gateway.query(
        `INSERT INTO llm_seller.restriction_records
           (id, tenant_id, policy, public_reason, internal_reason, scope_kind, capability, activates_at, expires_at, lifted_at, appeal_deadline)
         VALUES ('restriction-itest-chat', $1, 'policy-itest', 'chat suspended', 'internal', 'capability', 'chat', $2, NULL, NULL, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [SELLER_TENANT_ID, Date.now() - 1_000],
      );
      const response = await chatPost('/v1/chat/completions', {
        key: KEY_MAIN,
        requestId: 'itest-req-restricted',
        body: VALID_BODY,
      });
      expect(response.status).toBe(403);
      expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
        'offer_restricted',
      );
      expect(await journalRow('itest-req-restricted')).toBeNull();
    } finally {
      await gateway.query(
        `DELETE FROM llm_seller.restriction_records WHERE id = 'restriction-itest-chat'`,
      );
      await gateway.end();
    }
  });

  it('maps a structured upstream 401 refusal to 502 upstream_error with confirmed_not_executed and releases both reservations', async () => {
    const restoreUrl = await pointEndpointAt(mocks['unauthorized']?.url ?? '');
    try {
      const response = await chatPost('/v1/chat/completions', {
        key: KEY_MAIN,
        requestId: 'itest-req-up-401',
        body: VALID_BODY,
      });
      expect(response.status).toBe(502);
      expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
        'upstream_error',
      );

      const journal = await journalRow('itest-req-up-401');
      expect(journal?.status).toBe('failed');
      expect(journal?.evidence).toBe('confirmed_not_executed');
      expect(journal?.usage_status).toBe('missing');
      expect(journal?.charge_minor).toBe('0');
      expect(journal?.error_code).toBe('upstream_error');

      const quota = await quotaRow('itest-req-up-401');
      expect(quota?.state).toBe('released');

      const reservation = await financialReservationRow('itest-req-up-401');
      expect(reservation?.state).toBe('released');
      expect(reservation?.released_minor).toBe(HOLD_AMOUNT.toString());
      expect(reservation?.captured_minor).toBe('0');
      expect(await chargeRow('itest-req-up-401')).toBeNull();
    } finally {
      await restoreUrl();
    }
  });

  it('maps upstream 429 to 429 rate_limit_exceeded, forwards retry-after and releases both reservations', async () => {
    const restoreUrl = await pointEndpointAt(mocks['rate_limited']?.url ?? '');
    try {
      const response = await chatPost('/v1/chat/completions', {
        key: KEY_MAIN,
        requestId: 'itest-req-up-429',
        body: VALID_BODY,
      });
      expect(response.status).toBe(429);
      expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
        'rate_limit_exceeded',
      );
      expect(response.retryAfter).toBe('1');

      const journal = await journalRow('itest-req-up-429');
      expect(journal?.evidence).toBe('confirmed_not_executed');
      expect(journal?.error_code).toBe('rate_limit_exceeded');
      expect(journal?.charge_minor).toBe('0');

      expect((await quotaRow('itest-req-up-429'))?.state).toBe('released');
      const reservation = await financialReservationRow('itest-req-up-429');
      expect(reservation?.state).toBe('released');
      expect(reservation?.released_minor).toBe(HOLD_AMOUNT.toString());
    } finally {
      await restoreUrl();
    }
  });

  it('maps upstream 500 to 502 upstream_error with may_have_executed and settles capped at the held amount (F5, never timeout-release)', async () => {
    const restoreUrl = await pointEndpointAt(mocks['server_error']?.url ?? '');
    try {
      const response = await chatPost('/v1/chat/completions', {
        key: KEY_MAIN,
        requestId: 'itest-req-up-500',
        body: VALID_BODY,
      });
      expect(response.status).toBe(502);
      expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
        'upstream_error',
      );

      const journal = await journalRow('itest-req-up-500');
      expect(journal?.status).toBe('failed');
      expect(journal?.evidence).toBe('may_have_executed');
      expect(journal?.usage_status).toBe('missing');
      expect(journal?.charge_minor).toBe(HOLD_AMOUNT.toString());

      const quota = await quotaRow('itest-req-up-500');
      expect(quota?.state).toBe('settled');
      expect(quota?.settled_tokens).toBe(HOLD_TOKENS.toString());

      const reservation = await financialReservationRow('itest-req-up-500');
      expect(reservation?.state).toBe('captured');
      expect(reservation?.captured_minor).toBe(HOLD_AMOUNT.toString());
      const charge = await chargeRow('itest-req-up-500');
      expect(charge?.state).toBe('posted');
      expect(charge?.amount_minor).toBe(HOLD_AMOUNT.toString());
    } finally {
      await restoreUrl();
    }
  });

  it('treats a malformed 200 body as confirmed_completed with missing usage, settles capped at held and answers 502', async () => {
    const restoreUrl = await pointEndpointAt(mocks['malformed']?.url ?? '');
    try {
      const response = await chatPost('/v1/chat/completions', {
        key: KEY_MAIN,
        requestId: 'itest-req-up-malformed',
        body: VALID_BODY,
      });
      expect(response.status).toBe(502);
      expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
        'upstream_error',
      );

      const journal = await journalRow('itest-req-up-malformed');
      expect(journal?.evidence).toBe('confirmed_completed');
      expect(journal?.usage_status).toBe('missing');
      expect(journal?.input_tokens).toBeNull();
      expect(journal?.output_tokens).toBeNull();
      expect(journal?.charge_minor).toBe(HOLD_AMOUNT.toString());

      const reservation = await financialReservationRow('itest-req-up-malformed');
      expect(reservation?.state).toBe('captured');
      expect(reservation?.captured_minor).toBe(HOLD_AMOUNT.toString());
    } finally {
      await restoreUrl();
    }
  });

  it('maps an upstream timeout to 502 upstream_error with may_have_executed and a capped settlement (worker abort wins over the hanging mock)', async () => {
    const restoreUrl = await pointEndpointAt(mocks['timeout']?.url ?? '');
    try {
      const response = await chatPost('/v1/chat/completions', {
        key: KEY_MAIN,
        requestId: 'itest-req-up-timeout',
        body: VALID_BODY,
      });
      expect(response.status).toBe(502);
      expect((expectJson(response.body)['error'] as { code: string | null }).code).toBe(
        'upstream_error',
      );

      const journal = await journalRow('itest-req-up-timeout');
      expect(journal?.evidence).toBe('may_have_executed');
      expect(journal?.charge_minor).toBe(HOLD_AMOUNT.toString());

      // F5: timeout KHÔNG bao giờ release — settle capped tại held.
      const reservation = await financialReservationRow('itest-req-up-timeout');
      expect(reservation?.state).toBe('captured');
      expect(reservation?.captured_minor).toBe(HOLD_AMOUNT.toString());
      expect((await quotaRow('itest-req-up-timeout'))?.state).toBe('settled');
    } finally {
      await restoreUrl();
    }
  }, 60_000);

  it('admits exactly one of two concurrent requests against a just-fitting token ceiling', async () => {
    // Trần 2 token, mỗi request hold 2 token ('hi' → ceil(2/2)=1 input + 1 output).
    // FOR UPDATE trên tenant_quota serialize admission per-tenant — đúng một
    // request qua, request kia 429 insufficient_quota (durable reserve, invariant 2).
    const gateway = await db.connect('gateway');
    try {
      await gateway.query(
        `INSERT INTO llm_gateway.tenant_quota (tenant_id, token_ceiling, created_at, created_by)
         VALUES ($1, 2, 1760000000000, 'itest') ON CONFLICT (tenant_id) DO UPDATE SET token_ceiling = 2`,
        [TENANT_QUOTA],
      );
    } finally {
      await gateway.end();
    }

    const smallBody = {
      model: UPSTREAM_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    };
    const [first, second] = await Promise.all([
      chatPost('/v1/chat/completions', {
        key: KEY_QUOTA,
        requestId: 'itest-req-quota-1',
        body: smallBody,
      }),
      chatPost('/v1/chat/completions', {
        key: KEY_QUOTA,
        requestId: 'itest-req-quota-2',
        body: smallBody,
      }),
    ]);

    const statuses = [first.status, second.status].toSorted();
    expect(statuses).toEqual([200, 429]);
    const rejectedBody = first.status === 429 ? first : second;
    expect((expectJson(rejectedBody.body)['error'] as { code: string | null }).code).toBe(
      'insufficient_quota',
    );

    // Đúng MỘT reservation row cho tenant: request thắng chốt quota trước (khoá
    // FOR UPDATE serialize), request thua bị chặn TRƯỚC khi INSERT — không bao
    // giờ có hai row active đồng thời (invariant 1: reserve là duy nhất/dua
    // identity). Người thắng đã settle theo usage thật sau dispatch.
    const totalRows = await countRows(
      `SELECT count(*)::text AS count FROM llm_gateway.quota_reservations
        WHERE tenant_id = $1`,
      [TENANT_QUOTA],
    );
    expect(totalRows).toBe(1);
    const winnerState = await countRows(
      `SELECT count(*)::text AS count FROM llm_gateway.quota_reservations
        WHERE tenant_id = $1 AND state = 'settled'`,
      [TENANT_QUOTA],
    );
    expect(winnerState).toBe(1);
  });

  it('keeps the journal metadata-only (no prompt/response/body columns) and keeps the mock capture free of prompt, response or key plaintext', async () => {
    // Catalog fence: bảng journal không có cột nào chứa nội dung — metadata only
    // là thuộc tính schema, không chỉ discipline của writer.
    const client = await db.connect('gateway');
    const columns: string[] = [];
    try {
      const result = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'llm_gateway' AND table_name IN ('logical_requests', 'attempts')
          ORDER BY table_name, column_name`,
      );
      columns.push(...result.rows.map((row) => row.column_name));
    } finally {
      await client.end();
    }
    for (const forbidden of ['prompt', 'response_body', 'messages', 'content', 'key_plaintext']) {
      expect(
        columns.some((column) => column.includes(forbidden)),
        `journal column containing "${forbidden}"`,
      ).toBe(false);
    }

    // Capture fence: stdout/stderr của mock 'ok' không chứa prompt, response
    // hay key plaintext nào (credential mock đi qua env, không qua log).
    const okMock = mocks['ok'];
    expect(okMock).toBeDefined();
    const captured = `${okMock?.stdout() ?? ''}${okMock?.stderr() ?? ''}`;
    expect(captured.includes(PROMPT_TEXT)).toBe(false);
    expect(captured.includes(MOCK_CONTENT)).toBe(false);
    expect(captured.includes(KEY_MAIN)).toBe(false);
    expect(captured.includes(UPSTREAM_KEY)).toBe(false);
  });

  it('fails closed with 503 and retry-after on the chat path when a database binding is degraded', async () => {
    // Harness thứ hai dựng SAU khi một binding trỏ địa chỉ chết — Hyperdrive
    // local đọc env lúc dựng binding (cùng mô hình http-contract.spec).
    const binding = hyperdriveEnvName(BINDING_BY_KEY.marketplace);
    setEnv(
      binding,
      `postgresql://ecoma_llm_marketplace_runtime:wrong@127.0.0.1:1/db-llm-marketplace`,
    );
    degradedHarness = wranglerCli.createTestHarness({
      root: APP_DIR,
      workers: [{ configPath: WORKER_CONFIG_PATH }],
    });
    await degradedHarness.listen();
    // Readiness gate (bước 1) chạy TRƯỚC auth — request thiếu key vẫn chạm 503,
    // không phải 401: fail-closed hạ tầng precedes mọi logic business.
    const response = await degradedHarness.fetch('http://worker.invalid/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    const error = expectJson(await response.text())['error'] as { code: string | null };
    expect(error.code).toBe('service_unavailable');
  });
});
