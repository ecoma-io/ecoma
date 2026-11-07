/**
 * Integration test của composition root `src/main.ts` trên **D1 thật** (miniflare/workerd
 * qua `wrangler.getPlatformProxy`), không mock SQL: route FR-001 qua HMAC envelope thật,
 * idempotency replay/conflict trên row thật, outcome guarded transition, publish loop qua
 * Queue binding giả, và redispatch adapter hai statement (statement (1) trả 0 hàng ⇒
 * statement (2) không chạy — `budget-exhausted` phải dừng hẳn).
 *
 * Nguồn canonical: `docs/applications/transactional-mail/01-architecture.md` §6.1–§6.2.2, §6.5,
 * §7.2; `02-requirements.md` FR-001. Harness migrations theo `mail-d1.spec.ts` (`tests/integrations/`, wrangler
 * CLI `d1 migrations apply` — đúng công cụ production dùng).
 *
 * Ranh giới của suite này: KHÔNG chứng minh exactly-once provider, KHÔNG chứng minh
 * behaviour của Cloudflare Queues runtime thật (Queue ở đây là fake in-memory capture);
 * những điều đó thuộc về runtime verification (01-architecture.md, release gate).
 */

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signRequest } from '@ecoma-io/internal-auth-contracts';

import worker from '../../src/main';
import { FINGERPRINT_KEYRING_ENV, type TransactionalMailEnv } from '../../src/config';

// Không gửi telemetri khi spawn wrangler trong test.
process.env['WRANGLER_SEND_METRICS'] = 'false';

const requireFromSpec = createRequire(import.meta.url);
// `wrangler` là devDependency ở root; getPlatformProxy khởi động workerd/miniflare trong
// tiến trình, cho D1 binding thật với bound parameter.
const { getPlatformProxy } = requireFromSpec('wrangler') as typeof import('wrangler');

const appDir = join(import.meta.dirname, '..', '..');
const wranglerConfig = join(appDir, 'wrangler.jsonc');
const wranglerCli = requireFromSpec.resolve('wrangler');

/** Mốc thời gian tuyệt đối cho seed — envelope timestamp thì theo đồng hồ thật (skew check). */
const NOW_MS = 1_790_000_000_000;

const SECRET_ACCOUNT = 'secret-svc-account-main-spec';
const SECRET_PAYMENT = 'secret-svc-payment-main-spec';
const SECRET_MAILER_JOB = 'secret-svc-mailer-job-main-spec';
const KEY_A = 'b'.repeat(64);

/**
 * Thân POST /v1/messages canonical — template `account.login-otp` duy nhất được approve cho
 * `svc.account` (SR-001, seed migration `0009`), biến `code` 8 chữ số đúng schema.
 */
const TEMPLATE_BODY = JSON.stringify({
  template: 'account.login-otp',
  recipient: 'user@example.test',
  variables: { code: '12345678' },
});

type MailEnv = { readonly mail: unknown; readonly QUEUE: unknown };

let proxy: { env: MailEnv; dispose(): Promise<unknown> } | null = null;
let persistDir = '';

/**
 * Env đầy đủ cho cả `getConfig` lẫn bindings.
 *
 * ⚠️ `main.ts` cache config promise ở module scope (một isolate một lần nạp), nên MỌI test
 * trong file này dùng chung một bộ giá trị config — không test nào được override env config.
 */
function makeEnv(d1: unknown, queue: unknown): TransactionalMailEnv {
  return {
    [FINGERPRINT_KEYRING_ENV]: JSON.stringify({ current: 'p1.k1', keys: { 'p1.k1': KEY_A } }),
    MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT: SECRET_ACCOUNT,
    MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH: 'secret-svc-auth-main-spec',
    MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT: 'secret-svc-payment-main-spec',
    MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB: SECRET_MAILER_JOB,
    MAIL_RATE_LIMIT_PRINCIPAL_LIMIT: '60',
    MAIL_RATE_LIMIT_PRINCIPAL_WINDOW_MS: '60000',
    MAIL_RATE_LIMIT_SYSTEM_LIMIT: '10000',
    MAIL_RATE_LIMIT_SYSTEM_WINDOW_MS: '60000',
    MAIL_RATE_LIMIT_KEY_LIMIT: '20',
    MAIL_RATE_LIMIT_KEY_WINDOW_MS: '60000',
    MAIL_RENDER_MAX_BYTES: '64000',
    MAIL_PUBLISH_LEASE_MS: '30000',
    MAIL_PUBLISH_BATCH_LIMIT: '10',
    MAIL_PUBLISH_MAX_ATTEMPTS: '5',
    MAIL_PUBLISH_BACKOFF_BASE_MS: '1000',
    MAIL_RECONCILER_MAX_AGE_MS: '600000',
    MAIL_RECONCILER_BATCH_LIMIT: '50',
    MAIL_RECOVERY_MAX_CYCLES: '2',
    MAIL_NONCE_PRUNE_BATCH_LIMIT: '500',
    MAIL_RETENTION_CONTENT_MS: '2592000000',
    MAIL_RETENTION_STALE_ALERT_MS: '86400000',
    mail: d1,
    QUEUE: queue,
  } as unknown as TransactionalMailEnv;
}

/** Env CỐ Ý không có binding nào — cho ca chứng minh /health không chạm D1/Queue. */
function makeBindinglessEnv(): TransactionalMailEnv {
  return {
    [FINGERPRINT_KEYRING_ENV]: JSON.stringify({ current: 'p1.k1', keys: { 'p1.k1': KEY_A } }),
    MAIL_INTERNAL_AUTH_SECRET_SVC_ACCOUNT: SECRET_ACCOUNT,
    MAIL_INTERNAL_AUTH_SECRET_SVC_AUTH: 'secret-svc-auth-main-spec',
    MAIL_INTERNAL_AUTH_SECRET_SVC_PAYMENT: 'secret-svc-payment-main-spec',
    MAIL_INTERNAL_AUTH_SECRET_SVC_TRANSACTIONAL_MAILER_JOB: SECRET_MAILER_JOB,
    MAIL_RATE_LIMIT_PRINCIPAL_LIMIT: '60',
    MAIL_RATE_LIMIT_PRINCIPAL_WINDOW_MS: '60000',
    MAIL_RATE_LIMIT_SYSTEM_LIMIT: '10000',
    MAIL_RATE_LIMIT_SYSTEM_WINDOW_MS: '60000',
    MAIL_RATE_LIMIT_KEY_LIMIT: '20',
    MAIL_RATE_LIMIT_KEY_WINDOW_MS: '60000',
    MAIL_RENDER_MAX_BYTES: '64000',
    MAIL_PUBLISH_LEASE_MS: '30000',
    MAIL_PUBLISH_BATCH_LIMIT: '10',
    MAIL_PUBLISH_MAX_ATTEMPTS: '5',
    MAIL_PUBLISH_BACKOFF_BASE_MS: '1000',
    MAIL_RECONCILER_MAX_AGE_MS: '600000',
    MAIL_RECONCILER_BATCH_LIMIT: '50',
    MAIL_RECOVERY_MAX_CYCLES: '2',
    MAIL_NONCE_PRUNE_BATCH_LIMIT: '500',
    MAIL_RETENTION_CONTENT_MS: '2592000000',
    MAIL_RETENTION_STALE_ALERT_MS: '86400000',
  } as unknown as TransactionalMailEnv;
}

/** ExecutionContext mock đầy đủ hình — handler chỉ gọi `waitUntil`, còn lại là no-op. */
const executionContext = {
  waitUntil: (_promise: Promise<unknown>): void => undefined,
  passThroughOnException: (): void => undefined,
  props: {},
};

/** Ký bằng secret của MJ và gửi tới worker entrypoint — envelope HMAC thật của contract. */
async function mjFetch(
  env: TransactionalMailEnv,
  options: {
    readonly method: 'POST' | 'GET';
    readonly path: string;
    readonly body?: Uint8Array | null;
    readonly headers?: Record<string, string>;
  },
): Promise<Response> {
  const headers = await signRequest({
    method: options.method,
    path: options.path,
    body: options.body ?? null,
    secret: SECRET_MAILER_JOB,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  const request = new Request(`https://mail.internal${options.path}`, {
    method: options.method,
    headers: new Headers({ ...headers, ...options.headers }),
    body:
      options.body === undefined || options.body === null ? undefined : (options.body as BodyInit),
  });
  return await worker.fetch(request, env, executionContext);
}

/** Ký bằng secret của một principal tuỳ ý và POST /v1/messages. */
async function accountPost(
  env: TransactionalMailEnv,
  body: string,
  idempotencyKey: string,
  secret: string = SECRET_ACCOUNT,
): Promise<Response> {
  const encoded = new TextEncoder().encode(body);
  const headers = await signRequest({
    method: 'POST',
    path: '/v1/messages',
    body: encoded,
    secret,
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  const request = new Request('https://mail.internal/v1/messages', {
    method: 'POST',
    headers: new Headers({ ...headers, 'Idempotency-Key': idempotencyKey }),
    body: encoded as BodyInit,
  });
  return await worker.fetch(request, env, executionContext);
}

/**
 * Seed một delivery FRESH cho một test với key riêng — trước đây describe delivery route
 * dùng một row từ `beforeAll` và test outcome chuyển row đó sang `sent`, nên `GET envelope`
 * đỏ khi shuffle chạy nó sau (#385). Row mới tạo luôn ở trạng thái `accepted` bất kể thứ
 * tự khai báo; test chạy tuần tự trong file nên không test nào xen giữa POST và lượt đọc
 * ngay sau nó.
 */
async function seedDelivery(env: TransactionalMailEnv, idempotencyKey: string): Promise<string> {
  const response = await accountPost(env, TEMPLATE_BODY, idempotencyKey);
  expect(response.status).toBe(201);
  const body = (await response.json()) as { readonly delivery_id: string };
  return body.delivery_id;
}

async function rawRows<T = Record<string, unknown>>(
  env: TransactionalMailEnv,
  sql: string,
  ...binds: unknown[]
): Promise<T[]> {
  const db = env['mail'] as {
    prepare(sql: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } };
  };
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return results;
}

/** Queue giả — capture command theo thứ tự send. */
function captureQueue(): { readonly sent: string[]; readonly binding: unknown } {
  const sent: string[] = [];
  return {
    sent,
    binding: {
      send(message: string): Promise<void> {
        sent.push(message);
        return Promise.resolve();
      },
    },
  };
}

/**
 * Số command Queue đã send cho MỘT delivery — D1 dùng chung giữa các test nên publish
 * batch drain cả pending row của seed khác; assertion theo delivery mới là đúng nghĩa.
 */
function sentCountFor(sent: readonly string[], deliveryId: string): number {
  return sent.filter((entry) => {
    try {
      return (JSON.parse(entry) as { delivery_id?: string }).delivery_id === deliveryId;
    } catch {
      return false;
    }
  }).length;
}

beforeAll(async () => {
  persistDir = mkdtempSync(join(tmpdir(), 'tm-main-'));
  // CLI `--persist-to` ghi vào `<dir>/v3/d1/...` còn `getPlatformProxy` dùng path nguyên văn,
  // nên proxy phải trỏ vào con `v3` — cùng quy tắc `mail-d1.spec.ts` đã ghim.
  proxy = await getPlatformProxy<MailEnv>({
    configPath: wranglerConfig,
    persist: { path: join(persistDir, 'v3') },
  });
  // Áp migration bằng CLI — đúng công cụ production dùng.
  execFileSync(
    process.execPath,
    [
      wranglerCli,
      'd1',
      'migrations',
      'apply',
      'mail',
      '--local',
      '--config',
      wranglerConfig,
      '--persist-to',
      persistDir,
    ],
    {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  // Migrations phải được áp đủ — nếu thiếu file nào thì mọi test dưới fail ầm ầm, fail sớm.
  const applied = readdirSync(join(persistDir, 'v3', 'd1')).length;
  if (applied === 0) {
    throw new Error(`expected migrations applied under ${persistDir}`);
  }

  // Migration `0009` đã seed template production `account.login-otp` — template duy nhất
  // được approve cho `svc.account` (SR-001) và là template toàn bộ suite chính dùng.
  // Suite chỉ tự seed thêm `welcome`: row active trong catalog nhưng KHÔNG được approve
  // cho principal nào — fixture cho ca 403 "template tồn tại mà chưa approve" (khác 404
  // "không có row active").
  const db = proxy.env['mail'] as {
    prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
  };
  await db
    .prepare(
      `INSERT INTO mail_templates (id, name, locale, version, subject_template, body_template, ` +
        `variables_schema_json, status, created_at, updated_at) VALUES (?, ?, 'en', 1, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      'tpl-main-welcome-en',
      'welcome',
      'Reset code {{ otp }}',
      '<p>Your code is {{ otp }}</p>',
      JSON.stringify({
        schema_version: 1,
        variables: {
          otp: { type: 'string', required: true, max_length: 8 },
          cta_url: { type: 'string', required: false, max_length: 2048, format: 'url' },
        },
      }),
      NOW_MS,
      NOW_MS,
    )
    .run();
}, 120_000);

afterAll(async () => {
  await proxy?.dispose();
  if (persistDir !== '') {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

describe('GET /health (smoke, no auth, no D1)', () => {
  it('returns 200 ok on an env without any binding touched', async () => {
    // Env CỐ Ý không có `mail`/`QUEUE`: /health phải không đọc binding nào (runbook phân
    // biệt "không boot" với "còn sống" — xem main.ts JSDoc của route). Nếu route chạm D1,
    // ca này chết ngay với binding undefined.
    const response = await worker.fetch(
      new Request('https://mail.internal/health'),
      makeBindinglessEnv(),
      executionContext,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { service: string; status: string };
    expect(body.service).toBe('transactional-mail');
    expect(body.status).toBe('ok');
  });
});

describe('POST /v1/messages (FR-001 end to end on real D1)', () => {
  it('creates a message and outbox atomically through the authenticated route', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const response = await accountPost(env, TEMPLATE_BODY, 'main-spec-key-1');

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      readonly id: string;
      readonly delivery_id: string;
      readonly app: string;
      readonly status: string;
      readonly created: boolean;
    };
    // `app` suy từ principal `svc.account` — server-controlled, không phải dữ liệu caller.
    expect(body.app).toBe('account');
    expect(body.created).toBe(true);
    expect(body.status).toBe('accepted');
    expect(body.delivery_id).toMatch(/^dlv_/u);
    expect(body.id).toMatch(/^msg_/u);

    const rows = await rawRows<{ status: string }>(
      env,
      'SELECT status FROM mail_outbox WHERE delivery_id = ?',
      body.delivery_id,
    );
    expect(rows).toEqual([{ status: 'pending' }]);
  });

  it('replays the same logical result and creates no second row for the same key', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    // Key duy nhất của test này: cặp request tạo + replay nằm trọn trong test, không dựa
    // vào row do test khác tạo trước — shuffle không được đổi verdict (#385).
    const first = await accountPost(env, TEMPLATE_BODY, 'main-spec-replay-key');
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { readonly delivery_id: string };

    const replay = await accountPost(env, TEMPLATE_BODY, 'main-spec-replay-key');
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as {
      readonly delivery_id: string;
      readonly created: boolean;
    };
    expect(replayBody.delivery_id).toBe(firstBody.delivery_id);
    expect(replayBody.created).toBe(false);

    const outboxRows = await rawRows<{ delivery_id: string }>(
      env,
      'SELECT delivery_id FROM mail_outbox WHERE delivery_id = ?',
      firstBody.delivery_id,
    );
    expect(outboxRows).toEqual([{ delivery_id: firstBody.delivery_id }]);
  });

  it('returns 409 for the same key with a different payload', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    // Tự seed row của key riêng trước khi gửi payload khác: trước đây test dựa vào row
    // mà test replay tạo trước đó theo thứ tự khai báo — shuffle phải vẫn 409 (#385).
    const seedBody = JSON.stringify({
      template: 'account.login-otp',
      recipient: 'user@example.test',
      variables: { code: '11111111' },
    });
    const seed = await accountPost(env, seedBody, 'main-spec-conflict-key');
    expect(seed.status).toBe(201);

    const conflictBody = JSON.stringify({
      template: 'account.login-otp',
      recipient: 'other@example.test',
      variables: { code: '65432178' },
    });
    const conflict = await accountPost(env, conflictBody, 'main-spec-conflict-key');
    expect(conflict.status).toBe(409);
    const conflictJson = (await conflict.json()) as { readonly error: { readonly code: string } };
    expect(conflictJson.error.code).toBe('idempotency_key_conflict');
  });

  it('rejects an unsigned request with the unified 401 and never reaches the use case', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const request = new Request('https://mail.internal/v1/messages', {
      method: 'POST',
      headers: new Headers({ 'Idempotency-Key': 'unsigned-key' }),
      body: TEMPLATE_BODY,
    });
    const response = await worker.fetch(request, env, executionContext);
    expect(response.status).toBe(401);
    const rows = await rawRows<{ n: number }>(
      env,
      "SELECT COUNT(*) AS n FROM mail_messages WHERE idempotency_key = 'unsigned-key'",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('rejects a request signed with an unknown secret with the unified 401', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const encoded = new TextEncoder().encode(TEMPLATE_BODY);
    const headers = await signRequest({
      method: 'POST',
      path: '/v1/messages',
      body: encoded,
      secret: 'not-a-registered-credential',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const request = new Request('https://mail.internal/v1/messages', {
      method: 'POST',
      headers: new Headers({ ...headers, 'Idempotency-Key': 'bad-sig-key' }),
      body: encoded as BodyInit,
    });
    const response = await worker.fetch(request, env, executionContext);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('rejects a replayed nonce with the unified 401 and creates no second row', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const nonce = '11111111-2222-4333-8444-555555555555';
    const ts = String(Math.floor(Date.now() / 1000));
    const encoded = new TextEncoder().encode(TEMPLATE_BODY);

    const firstHeaders = await signRequest({
      method: 'POST',
      path: '/v1/messages',
      body: encoded,
      secret: SECRET_ACCOUNT,
      timestamp: ts,
      nonce,
    });
    const first = await worker.fetch(
      new Request('https://mail.internal/v1/messages', {
        method: 'POST',
        headers: new Headers({ ...firstHeaders, 'Idempotency-Key': 'nonce-replay-first' }),
        body: encoded as BodyInit,
      }),
      env,
      executionContext,
    );
    expect(first.status).toBe(201);

    const secondHeaders = await signRequest({
      method: 'POST',
      path: '/v1/messages',
      body: encoded,
      secret: SECRET_ACCOUNT,
      timestamp: ts,
      nonce,
    });
    const second = await worker.fetch(
      new Request('https://mail.internal/v1/messages', {
        method: 'POST',
        headers: new Headers({ ...secondHeaders, 'Idempotency-Key': 'nonce-replay-second' }),
        body: encoded as BodyInit,
      }),
      env,
      executionContext,
    );
    expect(second.status).toBe(401);
    const body = (await second.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('unauthorized');

    const rows = await rawRows<{ n: number }>(
      env,
      "SELECT COUNT(*) AS n FROM mail_messages WHERE idempotency_key = 'nonce-replay-second'",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('rejects a request with a query string before any use-case work, with the unified 401', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const encoded = new TextEncoder().encode(TEMPLATE_BODY);
    const headers = await signRequest({
      method: 'POST',
      path: '/v1/messages',
      body: encoded,
      secret: SECRET_ACCOUNT,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const request = new Request('https://mail.internal/v1/messages?debug=1', {
      method: 'POST',
      headers: new Headers({ ...headers, 'Idempotency-Key': 'query-key' }),
      body: encoded as BodyInit,
    });
    const response = await worker.fetch(request, env, executionContext);
    expect(response.status).toBe(401);
    // `invalid_field` không được hoá ra 401 oracle — mã public vẫn là `unauthorized`.
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 400 for a missing Idempotency-Key only after successful authentication', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const encoded = new TextEncoder().encode(TEMPLATE_BODY);
    const headers = await signRequest({
      method: 'POST',
      path: '/v1/messages',
      body: encoded,
      secret: SECRET_ACCOUNT,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const request = new Request('https://mail.internal/v1/messages', {
      method: 'POST',
      headers: new Headers(headers),
      body: encoded as BodyInit,
    });
    const response = await worker.fetch(request, env, executionContext);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  it('returns 403 when the authenticated principal lacks message.create', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    // `svc.transactional-mailer-job` chỉ có delivery-read + delivery-outcome, không message-create.
    const encoded = new TextEncoder().encode(TEMPLATE_BODY);
    const headers = await signRequest({
      method: 'POST',
      path: '/v1/messages',
      body: encoded,
      secret: SECRET_MAILER_JOB,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const request = new Request('https://mail.internal/v1/messages', {
      method: 'POST',
      headers: new Headers({ ...headers, 'Idempotency-Key': 'wrong-permission-key' }),
      body: encoded as BodyInit,
    });
    const response = await worker.fetch(request, env, executionContext);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  it('returns 404 template_not_found only after authorization admits the template', async () => {
    // Route order SR-001: bước 3b chặn template chưa approve bằng `403` TRƯỚC use case,
    // nên `404 template_not_found` chỉ xảy ra khi template đã ở trong allowlist mà catalog
    // không còn row active nào khớp `(name, locale)` (locale lạ fallback default một lần
    // rồi vẫn 404). Disable row duy nhất của `account.login-otp` rồi khôi phục trong
    // finally — D1 dùng chung, suite chạy tuần tự nhưng một test fail không được kéo theo.
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const db = proxy?.env['mail'] as {
      prepare(sql: string): { run(): Promise<unknown> };
    };
    await db
      .prepare("UPDATE mail_templates SET status = 'disabled' WHERE name = 'account.login-otp'")
      .run();
    try {
      const response = await accountPost(
        env,
        JSON.stringify({
          template: 'account.login-otp',
          recipient: 'u@example.test',
          locale: 'vi',
          variables: { code: '12345678' },
        }),
        'template-missing-key',
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as { readonly error: { readonly code: string } };
      expect(body.error.code).toBe('template_not_found');
    } finally {
      await db
        .prepare("UPDATE mail_templates SET status = 'active' WHERE name = 'account.login-otp'")
        .run();
    }
  });

  it('creates a message for the seeded account.login-otp template (issue #132)', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const body = JSON.stringify({
      template: 'account.login-otp',
      recipient: 'user@example.test',
      locale: 'en',
      variables: { code: '12345678' },
    });
    const response = await accountPost(env, body, 'seeded-otp-key');
    expect(response.status).toBe(201);
    const json = (await response.json()) as {
      readonly template: string;
      readonly template_version: number;
      readonly app: string;
    };
    expect(json.template).toBe('account.login-otp');
    expect(json.template_version).toBe(1);
    expect(json.app).toBe('account');
  });

  it('rejects a payload beyond the declared render bound as payload_too_large', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    // 64 KiB là trần render (`MAIL_RENDER_MAX_BYTES`); body 70 KiB vượt trước khi chạm use case.
    const huge = JSON.stringify({
      template: 'account.login-otp',
      recipient: 'user@example.test',
      variables: { code: '1'.repeat(70_000) },
    });
    const response = await accountPost(env, huge, 'payload-too-large-key');
    expect(response.status).toBe(413);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('payload_too_large');
  });
});

describe('template authorization (SR-001, route step 3b)', () => {
  it('returns 403 before persistence when the template exists in the catalog but is not approved for the caller', async () => {
    // `welcome` có row active trong catalog nhưng KHÔNG nằm trong allowlist của principal
    // nào: authorization phải chặn bằng `403` trước khi chạm template lookup (404) hay
    // persistence. Mã lỗi dùng chung một message hằng — không phân biệt "template của
    // principal khác" với "chưa approve" để tránh oracle liệt kê catalog.
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const response = await accountPost(
      env,
      JSON.stringify({
        template: 'welcome',
        recipient: 'user@example.test',
        variables: { otp: '123456' },
      }),
      'template-not-allowed-key',
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('forbidden');
    const rows = await rawRows<{ n: number }>(
      env,
      "SELECT COUNT(*) AS n FROM mail_messages WHERE idempotency_key = 'template-not-allowed-key'",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('returns 403 for a template approved only for another principal when the caller has an empty allowlist', async () => {
    // `svc.payment` có `message.create` nhưng `allowedTemplates` rỗng — mọi template đều 403.
    // Dùng `account.login-otp` (đã approve cho `svc.account` VÀ có row active trong catalog)
    // để chứng minh 403 đến từ bước 3b theo danh tính caller chứ không phải theo catalog:
    // nếu lookup chạy trước thì kết quả sẽ là 201 chứ không phải 403.
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const response = await accountPost(
      env,
      JSON.stringify({
        template: 'account.login-otp',
        recipient: 'user@example.test',
        variables: { code: '12345678' },
      }),
      'empty-allowlist-key',
      SECRET_PAYMENT,
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('forbidden');
    const rows = await rawRows<{ n: number }>(
      env,
      "SELECT COUNT(*) AS n FROM mail_messages WHERE idempotency_key = 'empty-allowlist-key'",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('returns the same 403 for an unknown template and never creates a row', async () => {
    // Template không tồn tại: nếu route dừng ở bước 3b thì verdict phải là 403 (authorization
    // trước use case); 404 chỉ dành cho template ĐÃ được approve nhưng không còn row active.
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const response = await accountPost(
      env,
      JSON.stringify({
        template: 'missing-template',
        recipient: 'u@example.test',
        variables: {},
      }),
      'unknown-template-key',
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('forbidden');
    const rows = await rawRows<{ n: number }>(
      env,
      "SELECT COUNT(*) AS n FROM mail_messages WHERE idempotency_key = 'unknown-template-key'",
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it('cannot be self-granted via the payload — unknown body fields are 400, `app` is ignored', async () => {
    // Payload không có đường nào nạp grant: field lạ (`allowed_templates`) bị contract
    // validator từ chối 400 ở bước 3; `app` (được validator bỏ qua) cũng không đổi verdict —
    // allowlist chỉ đọc từ config boot-time, không merge từ request.
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const grantAttempt = await accountPost(
      env,
      JSON.stringify({
        template: 'welcome',
        recipient: 'user@example.test',
        variables: { otp: '123456' },
        allowed_templates: ['welcome'],
      }),
      'self-grant-unknown-field-key',
    );
    expect(grantAttempt.status).toBe(400);
    const grantBody = (await grantAttempt.json()) as {
      readonly error: { readonly code: string };
    };
    expect(grantBody.error.code).toBe('invalid_request');

    const appSpoof = await accountPost(
      env,
      JSON.stringify({
        app: 'svc.account',
        template: 'welcome',
        recipient: 'user@example.test',
        variables: { otp: '123456' },
      }),
      'self-grant-app-field-key',
    );
    expect(appSpoof.status).toBe(403);
    const appBody = (await appSpoof.json()) as { readonly error: { readonly code: string } };
    expect(appBody.error.code).toBe('forbidden');
  });

  it('keeps authorization per-request — a revoked template no longer replays a prior accepted request', async () => {
    // Authorization là điều kiện của TỪNG request, không chỉ của lần tạo đầu: cùng key +
    // cùng payload nhưng request thứ hai ký bằng principal KHÁC (allowlist rỗng) thì phải
    // 403 chứ không 200-replay verdict của request cũ. Bước 3b nằm trước idempotency
    // lookup nên principal mất grant không được tiếp tục nhận kết quả cũ.
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const body = JSON.stringify({
      template: 'account.login-otp',
      recipient: 'user@example.test',
      variables: { code: '12345678' },
    });
    const first = await accountPost(env, body, 'per-request-authz-key');
    expect(first.status).toBe(201);

    const replayAsPayment = await accountPost(env, body, 'per-request-authz-key', SECRET_PAYMENT);
    expect(replayAsPayment.status).toBe(403);
  });
});

describe('internal delivery routes on real D1 (§7.2, §6.2.2)', () => {
  it('GET envelope carries exactly the eight message fields plus dispatch_generation', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const deliveryId = await seedDelivery(env, 'routes-envelope-key');

    const response = await mjFetch(env, {
      method: 'GET',
      path: `/internal/deliveries/${deliveryId}`,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      readonly message: Record<string, string>;
      readonly dispatch_generation: number;
    };
    expect(Object.keys(body.message).toSorted()).toEqual(
      [
        'app',
        'body',
        'content_type',
        'delivery_id',
        'message_id',
        'recipient',
        'status',
        'subject',
      ].toSorted(),
    );
    expect(body.message.content_type).toBe('text/html');
    expect(body.message.recipient).toBe('user@example.test');
    expect(body.message.subject).toBe('Your login code 12345678');
    expect(body.message.status).toBe('accepted');
    expect(body.dispatch_generation).toBe(1);
  });

  it('GET returns 404 for an unknown delivery without echoing the id in the message', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const response = await mjFetch(env, {
      method: 'GET',
      path: '/internal/deliveries/dlv_does-not-exist',
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { readonly error: { readonly message: string } };
    expect(body.error.message).not.toContain('dlv_does-not-exist');
  });

  it('outcome applies once, replays as duplicate, and stale on a lower generation', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const deliveryId = await seedDelivery(env, 'routes-outcome-key');

    const first = await mjFetch(env, {
      method: 'POST',
      path: `/internal/deliveries/${deliveryId}/outcome`,
      body: new TextEncoder().encode(JSON.stringify({ outcome: 'sent', dispatch_generation: 1 })),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ result: 'applied', status: 'sent' });

    const duplicate = await mjFetch(env, {
      method: 'POST',
      path: `/internal/deliveries/${deliveryId}/outcome`,
      body: new TextEncoder().encode(JSON.stringify({ outcome: 'sent', dispatch_generation: 1 })),
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ result: 'duplicate', status: 'sent' });

    const stale = await mjFetch(env, {
      method: 'POST',
      path: `/internal/deliveries/${deliveryId}/outcome`,
      body: new TextEncoder().encode(
        JSON.stringify({ outcome: 'failed', dispatch_generation: 1, error_class: 'permanent' }),
      ),
    });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({
      result: 'stale',
      status: 'sent',
      current_dispatch_generation: 1,
    });

    // Outcome sau `sent` không lùi trạng thái — lớp outcome không bị ghi đè.
    const rows = await rawRows<{ status: string; failure_reason: string | null }>(
      env,
      'SELECT status, failure_reason FROM mail_messages WHERE delivery_id = ?',
      deliveryId,
    );
    expect(rows).toEqual([{ status: 'sent', failure_reason: null }]);
  });

  it('outcome for an unknown delivery is 404', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    const response = await mjFetch(env, {
      method: 'POST',
      path: '/internal/deliveries/dlv_unknown/outcome',
      body: new TextEncoder().encode(JSON.stringify({ outcome: 'sent', dispatch_generation: 1 })),
    });
    expect(response.status).toBe(404);
  });

  it('outcome with a malformed body is 400 after authentication', async () => {
    const env = makeEnv(proxy?.env['mail'], proxy?.env['QUEUE']);
    // Row thật (tự seed) + body malformed: 400 chứng minh validate body đứng TRƯỚC lookup
    // delivery — row tồn tại mà route vẫn từ chối body trước khi chạm persistence.
    const deliveryId = await seedDelivery(env, 'routes-malformed-key');
    const response = await mjFetch(env, {
      method: 'POST',
      path: `/internal/deliveries/${deliveryId}/outcome`,
      body: new TextEncoder().encode(JSON.stringify({ outcome: 'exploded' })),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { readonly error: { readonly code: string } };
    expect(body.error.code).toBe('invalid_request');
  });
});

describe('scheduled handler (publish loop + redispatch budget A)', () => {
  // Invariant 12 (`docs/architecture/01-architecture.md`): không correctness write nào qua
  // `ctx.waitUntil()`. Scheduled của control plane mail khai `ctx` nhưng chỉ `void ctx` —
  // publish (QUEUE.send + markPublished) là correctness write và phải nằm trong promise trả
  // về. ExecutionContext bẫy ném thay vì ghi nhận: một lời gọi `waitUntil` duy nhất là đỏ.
  it('completes the publish phase inside its returned promise, never touching a throwing waitUntil', async () => {
    const queue = captureQueue();
    const env = makeEnv(proxy?.env['mail'], queue.binding);

    const response = await accountPost(env, TEMPLATE_BODY, 'invariant12-seed-key');
    expect(response.status).toBe(201);
    const { delivery_id: deliveryId } = (await response.json()) as { readonly delivery_id: string };

    const trapCtx = {
      waitUntil: (_promise: Promise<unknown>): void => {
        throw new Error('waitUntil called on the scheduled path - invariant 12 violation');
      },
    };
    await worker.scheduled({ cron: '*/5 * * * *' }, env, trapCtx);

    // Sau khi promise trả về, correctness writes đã thấy: command đã ra Queue binding và
    // outbox row đã `published` trên D1 — không phải việc nào đó đang treo ở ctx.
    expect(sentCountFor(queue.sent, deliveryId)).toBe(1);
    const outbox = await rawRows<{ status: string }>(
      env,
      'SELECT status FROM mail_outbox WHERE delivery_id = ?',
      deliveryId,
    );
    expect(outbox).toEqual([{ status: 'published' }]);
  });

  it('publish loop drains a pending outbox row through the queue binding and marks it queued', async () => {
    const queue = captureQueue();
    const env = makeEnv(proxy?.env['mail'], queue.binding);

    const response = await accountPost(env, TEMPLATE_BODY, 'scheduled-seed-key');
    expect(response.status).toBe(201);
    const { delivery_id: deliveryId } = (await response.json()) as { readonly delivery_id: string };

    await worker.scheduled({ cron: '*/5 * * * *' }, env, executionContext);

    // Command canonical đúng hình §5 — chỉ `version` + `delivery_id` (D1 dùng chung nên
    // publish batch có thể drain cả pending row của test khác; đếm theo delivery này).
    const ownSends = queue.sent.filter((entry) => {
      try {
        return (JSON.parse(entry) as { delivery_id?: string }).delivery_id === deliveryId;
      } catch {
        return false;
      }
    });
    expect(ownSends).toEqual([JSON.stringify({ version: 1, delivery_id: deliveryId })]);

    const outbox = await rawRows<{ status: string }>(
      env,
      'SELECT status FROM mail_outbox WHERE delivery_id = ?',
      deliveryId,
    );
    expect(outbox).toEqual([{ status: 'published' }]);
    const message = await rawRows<{ status: string }>(
      env,
      'SELECT status FROM mail_messages WHERE delivery_id = ?',
      deliveryId,
    );
    expect(message).toEqual([{ status: 'queued' }]);
  });

  it('redispatch cycles consume budget A without a generation bump and stop at the cap', async () => {
    const queue = captureQueue();
    const env = makeEnv(proxy?.env['mail'], queue.binding);

    const response = await accountPost(env, TEMPLATE_BODY, 'redispatch-seed-key');
    expect(response.status).toBe(201);
    const { delivery_id: deliveryId } = (await response.json()) as { readonly delivery_id: string };

    // Cron 1: publish pha claim row pending → QUEUE.send; message queued, outbox published.
    await worker.scheduled({ cron: '*/5 * * * *' }, env, executionContext);
    expect(sentCountFor(queue.sent, deliveryId)).toBe(1);

    const age = async (): Promise<void> => {
      // `updated_at` của message lùi về quá khứ xa — vượt `MAIL_RECONCILER_MAX_AGE_MS`.
      const db = proxy?.env['mail'] as {
        prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } };
      };
      await db
        .prepare('UPDATE mail_messages SET updated_at = ? WHERE delivery_id = ?')
        .bind(NOW_MS - 10_000_000, deliveryId)
        .run();
    };
    const counters = async (): Promise<{
      readonly recovery_cycle_count: number;
      readonly dispatch_generation: number;
    }> => {
      const rows = await rawRows<{
        recovery_cycle_count: number;
        dispatch_generation: number;
      }>(
        env,
        'SELECT recovery_cycle_count, dispatch_generation FROM mail_messages WHERE delivery_id = ?',
        deliveryId,
      );
      const first = rows[0];
      if (first === undefined) {
        throw new Error(`expected a mail_messages row for the delivery under test`);
      }
      return {
        recovery_cycle_count: first.recovery_cycle_count,
        dispatch_generation: first.dispatch_generation,
      };
    };

    // Chu kỳ redispatch 1: age → cron (reconciler thấy queued + quá tuổi + outbox published
    // → redispatch: A=1, generation giữ nguyên, outbox về pending → publish pha của cron
    // KẾ TIẾP claim row pending đó → QUEUE.send lần 2).
    await age();
    await worker.scheduled({ cron: '*/5 * * * *' }, env, executionContext);
    expect(await counters()).toEqual({ recovery_cycle_count: 1, dispatch_generation: 1 });
    await worker.scheduled({ cron: '*/5 * * * *' }, env, executionContext);
    expect(sentCountFor(queue.sent, deliveryId)).toBe(2);

    // Chu kỳ redispatch 2: tiêu slot A cuối (A=2), generation vẫn không đổi.
    await age();
    await worker.scheduled({ cron: '*/5 * * * *' }, env, executionContext);
    expect(await counters()).toEqual({ recovery_cycle_count: 2, dispatch_generation: 1 });
    await worker.scheduled({ cron: '*/5 * * * *' }, env, executionContext);
    expect(sentCountFor(queue.sent, deliveryId)).toBe(3);

    // Chu kỳ 3: ngân sách A cạn (max = 2). Reconciler dừng hẳn: không redispatch, outbox
    // KHÔNG bị reset về pending — statement (2) không chạy khi statement (1) trả 0 hàng.
    await age();
    await worker.scheduled({ cron: '*/5 * * * *' }, env, executionContext);
    expect(await counters()).toEqual({ recovery_cycle_count: 2, dispatch_generation: 1 });
    expect(sentCountFor(queue.sent, deliveryId)).toBe(3);

    const outboxStatuses = await rawRows<{ status: string }>(
      env,
      'SELECT status FROM mail_outbox WHERE delivery_id = ?',
      deliveryId,
    );
    expect(outboxStatuses).toEqual([{ status: 'published' }]);
  });
});
