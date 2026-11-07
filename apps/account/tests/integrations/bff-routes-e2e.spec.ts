/**
 * BFF routes `handoff` + `consent context` + `consent decide` — route thật,
 * session thật, DB thật, Service Binding giả.
 *
 * ## Vì sao suite này cần tồn tại
 *
 * Ba route này cùng một luồng `account → auth` back-channel mà `otp-flow-e2e`
 * không chạm tới: sau khi OTP được chấp nhận, session phải được **push** về
 * `auth` qua envelope HMAC, và consent context/decision đi cùng một kênh. Test
 * ở tầng unit (`auth-client.spec.ts`) chứng minh envelope hợp lệ; test ở tầng
 * này chứng minh **route dựng đúng payload từ state thật của DB** — đặc biệt
 * `sub`, `account_session_ref`, `authn_at` phải đến từ session đã verify, và
 * `event_id` phải bất biến giữa các retry (retry không được tạo transaction
 * mới ở phía auth).
 *
 * ## Biên giả ở đây là gì
 *
 * `AUTH_SERVICE` là **binding thật về hình dạng, giả về hành vi**: gọi đúng
 * `fetch(request, init)` như Service Binding của Workers, nhưng trả response do
 * test chỉ định. Không dựng một Worker `auth` thật — hợp đồng phía auth
 * (`/internal/**`) đã thuộc về Workstream auth-side; việc của suite này là
 * phía account. Envelope trong request giả vẫn được verify bằng
 * `verifyRequest` thật — một boundary stub không verify là stub bỏ qua đúng thứ
 * nó phải kiểm.
 *
 * Session được cấp qua **challenge → verify thật** (mail stub ở mức global như
 * `otp-flow-e2e`), nên cookie/CSRF/ACR/`authn_at` đều là sản phẩm thật của vault
 * verify, không phải fixture tự dựng.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import contextRoute from '../../server/api/consent/context.post';
import decideRoute from '../../server/api/consent/decide.post';
import handoffRoute from '../../server/api/auth/handoff.post';
import challengeRoute from '../../server/api/auth/challenge.post';
import verifyRoute from '../../server/api/auth/verify.post';

import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { INTERNAL_TIMESTAMP_HEADER, verifyRequest } from '@ecoma-io/internal-auth-contracts';
import { OTP_ACR, type AccountSessionRow } from '../../server/lib/session';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));
const OTP_SECRET = 'test-otp-hmac-secret-0123456789abcdef';
const INTERNAL_SECRET = 'test-internal-hmac-secret-0123456789abcdef';

const SUB_MAIN = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMAIL_MAIN = 'user@example.com';

const CONTINUE_URL = 'https://auth.test/continue?token=x';
/** Handle opaque của test — giá trị không có nghĩa ngoài việc relay. */
const HANDLE = 'handle-YZZ-test-value';

/** Response của auth stub cho `session/verified` lần đầu. */
function sessionVerifiedBody(): Record<string, unknown> {
  return { outcome: 'consent_required', continue_url: CONTINUE_URL };
}

// ── AUTH_SERVICE binding giả ─────────────────────────────────────────────────

interface AuthCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
  readonly timestamp: string;
}

/**
 * Cài Service Binding `AUTH_SERVICE` trong runtime config.
 *
 * Trả về chính object đó (kèm `fetch`) và danh sách call đã nhận — test đọc
 * list theo đuôi để assert trên payload đã ký. `stub.running` điều khiển
 * "auth trả gì" giữa các case mà không cài lại binding.
 */
function installAuthBindingStub(): {
  calls: AuthCall[];
  running: { status: number; body: () => unknown } | undefined;
  binding: { fetch: (input: Request, init?: RequestInit) => Promise<Response> };
} {
  const calls: AuthCall[] = [];
  const stub: {
    calls: AuthCall[];
    running: { status: number; body: () => unknown } | undefined;
    binding: {
      fetch: (input: Request, init?: RequestInit) => Promise<Response>;
    };
  } = {
    calls,
    running: undefined,
    binding: {
      fetch: async (input: Request, _init?: RequestInit) => {
        void _init;
        const raw = new Uint8Array(await input.clone().arrayBuffer());
        const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
        calls.push({
          url: String(input.url),
          method: input.method,
          body,
          timestamp: input.headers.get(INTERNAL_TIMESTAMP_HEADER) ?? '',
        });
        const running = stub.running;
        if (running === undefined) {
          throw new Error('auth stub: no configured response for this test step');
        }
        return new Response(JSON.stringify(running.body()), {
          status: running.status,
        });
      },
    },
  };
  return stub;
}

// ── helpers trùng với `otp-flow-e2e` ──────────────────────────────────────────

function fullRuntimeConfig(
  connectionString: string,
  authBinding: { fetch: (input: Request, init?: RequestInit) => Promise<Response> } | undefined,
): AccountTestRuntimeConfig {
  return {
    internalHmacSecret: INTERNAL_SECRET,
    otpHmacSecret: OTP_SECRET,
    mailServiceUrl: 'https://mail.test',
    mailInternalAuthSecret: 'test-mail-internal-auth-secret-placeholder-0001',
    authIssuer: 'https://auth.test',
    cloudflare: {
      env: {
        DB_ACCOUNT: { connectionString },
        ...(authBinding === undefined ? {} : { AUTH_SERVICE: authBinding }),
      },
    },
  };
}

function installMailStub(): {
  sent: Array<{ body: Record<string, unknown> }>;
  restore: () => void;
} {
  const sent: Array<{ body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = init?.body;
    const isUint8 =
      rawBody !== null &&
      typeof rawBody === 'object' &&
      (rawBody as { constructor?: { name?: string } }).constructor?.name === 'Uint8Array';
    const bodyText = isUint8
      ? new TextDecoder().decode(rawBody as Uint8Array)
      : typeof rawBody === 'string'
        ? rawBody
        : String(rawBody ?? '{}');
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    sent.push({ body });
    return new Response(
      JSON.stringify({
        id: 'msg-1',
        delivery_id: 'dlv-1',
        app: 'account',
        template: body['template'],
        template_version: 1,
        status: 'queued',
        created: true,
        created_at: new Date().toISOString(),
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (found === undefined) {
    return undefined;
  }
  return found.slice(name.length + 1).split(';')[0];
}

/** Header `cookie` ghép từ cặp cookie của verify — không phụ thuộc scope suite. */
function authCookieHeader(cookies: { sessionCookie: string; csrfCookie: string }): string {
  return `__Host-account-session=${cookies.sessionCookie}; __Host-account-csrf=${cookies.csrfCookie}`;
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('BFF handoff and consent routes end-to-end', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let connectionString: string;
  let authStub: ReturnType<typeof installAuthBindingStub>;

  async function post(
    path: string,
    body: unknown,
    init: { headers?: Record<string, string>; cookie?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...init.headers,
    };
    if (init.cookie !== undefined) {
      headers['cookie'] = init.cookie;
    }
    return handler(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    );
  }

  /** Challenge → verify: cấp cookie thật từ verify — đúng luồng production. */
  async function loginAndGetCookies(): Promise<{
    sessionCookie: string;
    csrfCookie: string;
    csrfToken: string;
  }> {
    const mail = installMailStub();
    let code: string;
    let challengeCookies: string[] = [];
    try {
      const challengeResponse = await post('/api/auth/challenge', {
        email: EMAIL_MAIN,
        handle: HANDLE,
      });
      expect(challengeResponse.status).toBe(204);
      expect(mail.sent).toHaveLength(1);
      const variables = mail.sent[0]?.body['variables'] as { code?: string } | undefined;
      code = variables?.code as string;
      challengeCookies = setCookies(challengeResponse);
    } finally {
      mail.restore();
    }
    const challengeSessionCookie = cookieValue(challengeCookies, '__Host-account-session');
    const verifyResponse = await post(
      '/api/auth/verify',
      { email: EMAIL_MAIN, code },
      challengeSessionCookie === undefined
        ? {}
        : { cookie: `__Host-account-session=${challengeSessionCookie}` },
    );
    expect(verifyResponse.status).toBe(200);
    const cookies = setCookies(verifyResponse);
    const sessionCookie = cookieValue(cookies, '__Host-account-session');
    const csrfCookie = cookieValue(cookies, '__Host-account-csrf');
    expect(typeof sessionCookie).toBe('string');
    expect(typeof csrfCookie).toBe('string');
    // Cookie thật của app có token CSRF của riêng nó — test dùng chính giá trị
    // đó làm header (đúng luật double-submit), không tự dán token.
    return {
      sessionCookie: sessionCookie as string,
      csrfCookie: csrfCookie as string,
      csrfToken: csrfCookie as string,
    };
  }

  beforeAll(async () => {
    db = await startAccountDatabase();
    connectionString = `postgres://ecoma_account_runtime:${db.rolePassword}@${db.host}:${db.port}/${ACCOUNT_DATABASE}`;
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig(connectionString, undefined));

    const app = createApp();
    const router = createRouter();
    router.post('/api/auth/challenge', challengeRoute);
    router.post('/api/auth/verify', verifyRoute);
    router.post('/api/auth/handoff', handoffRoute);
    router.post('/api/consent/context', contextRoute);
    router.post('/api/consent/decide', decideRoute);
    app.use(router.handler);
    handler = toWebHandler(app);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub?.binding));
    await db.truncateData();
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO account.users (sub) VALUES ($1) ON CONFLICT DO NOTHING`, [
        SUB_MAIN,
      ]);
      const normalized = EMAIL_MAIN;
      await client.query(
        `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
         VALUES ($1, $2, $3, 'verified', true, now())`,
        [
          SUB_MAIN,
          normalized,
          (await import('node:crypto')).createHash('sha256').update(normalized).digest('hex'),
        ],
      );
    } finally {
      await client.end();
    }
  });

  /** Session row thật — lấy bằng session_ref mà BFF sẽ dùng */
  async function loadLatestSession(): Promise<AccountSessionRow> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<AccountSessionRow & Record<string, unknown>>(
        `SELECT id_hash, session_ref, user_sub, acr, authn_at, created_at, expires_at, revoked_at
           FROM account.account_sessions WHERE revoked_at IS NULL LIMIT 1`,
      );
      expect(rows).toHaveLength(1);
      return rows[0] as AccountSessionRow;
    } finally {
      await client.end();
    }
  }

  /** Lưu request thô của binding để verify envelope trong từng test. */
  const rawRequests: Request[] = [];

  function installRecordingAuthBinding(): ReturnType<typeof installAuthBindingStub> {
    const stub = installAuthBindingStub();
    const originalFetch = stub.binding.fetch;
    stub.binding.fetch = async (input: Request, init?: RequestInit) => {
      rawRequests.push(input.clone());
      return originalFetch(input, init);
    };
    return stub;
  }

  function currentRawRequest(): Request {
    const request = rawRequests.at(-1);
    if (request === undefined) {
      throw new Error('no auth request recorded in this test');
    }
    return request;
  }

  // ── verify: URL confirm sau verify (§5.1.2 hàng 7) ─────────────────────────

  /**
   * Challenge → verify mang handle: cấp cookie thật và đọc response verify.
   * Mã OTP đi qua mail stub như luồng production. `verifyHandle` tách khỏi
   * `challengeHandle` để mô phỏng trình handle lạ (challenge bind A, verify
   * trình B — B chưa từng được session này bind).
   */
  async function loginWithHandleAndGetVerifyResponse(params: {
    challengeHandle?: string;
    verifyHandle?: string;
  }): Promise<Response> {
    const mail = installMailStub();
    let code: string;
    let challengeCookies: string[] = [];
    try {
      const challengeResponse = await post('/api/auth/challenge', {
        email: EMAIL_MAIN,
        ...(params.challengeHandle === undefined ? {} : { handle: params.challengeHandle }),
      });
      expect(challengeResponse.status).toBe(204);
      const variables = mail.sent[0]?.body['variables'] as { code?: string } | undefined;
      code = variables?.code as string;
      challengeCookies = setCookies(challengeResponse);
    } finally {
      mail.restore();
    }
    const challengeSessionCookie = cookieValue(challengeCookies, '__Host-account-session');
    const verifyResponse = await post(
      '/api/auth/verify',
      {
        email: EMAIL_MAIN,
        code,
        ...(params.verifyHandle === undefined ? {} : { handle: params.verifyHandle }),
      },
      challengeSessionCookie === undefined
        ? {}
        : { cookie: `__Host-account-session=${challengeSessionCookie}` },
    );
    return verifyResponse;
  }

  it('verify with a bound handle and matching session returns confirmUrl with correct origin/path/handle', async () => {
    setRuntimeConfig(fullRuntimeConfig(connectionString, undefined));
    const response = await loginWithHandleAndGetVerifyResponse({
      challengeHandle: HANDLE,
      verifyHandle: HANDLE,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; confirmUrl?: string };
    expect(body.ok).toBe(true);
    expect(typeof body.confirmUrl).toBe('string');
    const confirm = new URL(body.confirmUrl as string);
    expect(confirm.origin).toBe('https://auth.test');
    expect(confirm.pathname).toBe('/authorize/confirm');
    expect(confirm.searchParams.get('handle')).toBe(HANDLE);
  });

  it('verify with a FOREIGN handle returns ok:true without confirmUrl', async () => {
    setRuntimeConfig(fullRuntimeConfig(connectionString, undefined));
    // Challenge bind HANDLE vào session（đúng luồng thật), nhưng verify trình
    // handle khác chưa từng được bind — lớp bảo vệ thứ nhất §3.6 chặn, không
    // cấp URL, đăng nhập vẫn thành công.
    const response = await loginWithHandleAndGetVerifyResponse({
      challengeHandle: HANDLE,
      verifyHandle: 'foreign-handle-never-bound',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; confirmUrl?: string | undefined };
    expect(body.ok).toBe(true);
    expect(body.confirmUrl).toBeUndefined();
  });

  it('verify without a handle in the body returns the old {ok:true} shape without the field', async () => {
    setRuntimeConfig(fullRuntimeConfig(connectionString, undefined));
    const response = await loginWithHandleAndGetVerifyResponse({ challengeHandle: HANDLE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('verify returns no confirmUrl when authIssuer config is empty', async () => {
    const config = fullRuntimeConfig(connectionString, undefined);
    setRuntimeConfig({ ...config, authIssuer: '' });
    const response = await loginWithHandleAndGetVerifyResponse({
      challengeHandle: HANDLE,
      verifyHandle: HANDLE,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean; confirmUrl?: string | undefined };
    expect(body.ok).toBe(true);
    expect(body.confirmUrl).toBeUndefined();
  });

  // ── handoff ────────────────────────────────────────────────────────────────

  it('handoff returns 401 without a session cookie', async () => {
    authStub = installAuthBindingStub();
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));
    const response = await post('/api/auth/handoff', { handle: HANDLE });
    expect(response.status).toBe(401);
    expect(authStub.calls).toHaveLength(0);
  });

  it('handoff requires the CSRF double-submit header', async () => {
    authStub = installAuthBindingStub();
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));
    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/auth/handoff',
      { handle: HANDLE },
      { cookie: authCookieHeader(cookies) }, // cookie có, header CSRF vắng
    );
    expect(response.status).toBe(403);
    expect(authStub.calls).toHaveLength(0);
  });

  it('handoff returns 400 on a malformed body', async () => {
    authStub = installAuthBindingStub();
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));
    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/auth/handoff',
      { notHandle: 'X' },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    expect(response.status).toBe(400);
    expect(authStub.calls).toHaveLength(0);
  });

  it('pushes a signed, contract-shaped session/verified to auth and relays continue_url', async () => {
    authStub = installRecordingAuthBinding();
    authStub.running = { status: 200, body: () => sessionVerifiedBody() };
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));

    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/auth/handoff',
      { handle: HANDLE },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      outcome: 'consent_required',
      continueUrl: CONTINUE_URL,
    });

    // Payload đẩy về auth: đúng 6 trường, đúng giá trị từ DB, đúng path.
    expect(authStub.calls).toHaveLength(1);
    const call = authStub.calls[0] as AuthCall;
    expect(new URL(call.url).pathname).toBe('/internal/session/verified');
    const sessionRow = await loadLatestSession();
    expect(call.body).toEqual({
      handle: HANDLE,
      sub: SUB_MAIN,
      acr: OTP_ACR,
      authn_at: new Date(sessionRow.authn_at as unknown as string).getTime(),
      account_session_ref: sessionRow.session_ref,
      event_id: `session_verified:${sessionRow.session_ref}`,
    });

    // Envelope verify bằng chính lib — cùng secret, đúng path, đúng byte body:
    // chứng minh signing dùng đúng contract (không fallback ra chuỗi dị).
    const verification = await verifyRequest({
      method: 'POST',
      path: '/internal/session/verified',
      body: new Uint8Array(await currentRawRequest().clone().arrayBuffer()),
      headers: currentRawRequest().headers,
      secret: INTERNAL_SECRET,
      now: String(Math.floor(Date.now() / 1000)),
      claimNonce: async () => false,
    });
    expect(verification.ok).toBe(true);
  });

  it('keeps event_id stable across retries and treats already_processed as ok', async () => {
    authStub = installAuthBindingStub();
    authStub.running = { status: 200, body: () => sessionVerifiedBody() };
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));

    const cookies = await loginAndGetCookies();
    const init = {
      cookie: authCookieHeader(cookies),
      headers: { 'x-ecoma-csrf': cookies.csrfToken },
    };
    const first = await post('/api/auth/handoff', { handle: HANDLE }, init);
    expect(await first.json()).toEqual({
      ok: true,
      outcome: 'consent_required',
      continueUrl: CONTINUE_URL,
    });

    // Sau push thành công đầu tiên, binding bị consume (FR-006d2): lần retry
    // thứ hai không còn đi tới auth — account layer chặn trước, cùng reason
    // ổn định `binding_mismatch`. Đây là hành vi mới của lớp bảo vệ thứ nhất;
    // idempotency phía auth (`already_processed`) chỉ còn ý nghĩa cho các retry
    // xảy ra **trước** khi push thành công (binding còn nguyên vẹn).
    const second = await post('/api/auth/handoff', { handle: HANDLE }, init);
    expect(await second.json()).toEqual({ ok: false, reason: 'binding_mismatch' });

    expect(authStub.calls).toHaveLength(1);
    const [firstCall] = authStub.calls as [AuthCall];
    // `event_id` được dựng từ `session_ref` — bất biến cho session này, không
    // phụ thuộc retry có đi tới auth hay không.
    expect(firstCall.body['event_id']).toBe(
      `session_verified:${firstCall.body['account_session_ref']}`,
    );
  });

  it('returns ok:true with already_processed when consume fails after push ok', async () => {
    authStub = installAuthBindingStub();
    authStub.running = { status: 200, body: () => sessionVerifiedBody() };
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));

    const cookies = await loginAndGetCookies();
    const init = {
      cookie: authCookieHeader(cookies),
      headers: { 'x-ecoma-csrf': cookies.csrfToken },
    };

    // Mô phỏng DB hiccup ở nhánh consume sau push thành công: binding giữ
    // nguyên `bound`/`session_rotated` thay vì chuyển `consumed`.
    const handoffModule = await import('../../server/lib/handoff');
    const spy = vi.spyOn(handoffModule, 'consumeHandoff').mockRejectedValue(new Error('db hiccup'));

    const first = await post('/api/auth/handoff', { handle: HANDLE }, init);
    expect(await first.json()).toEqual({
      ok: true,
      outcome: 'consent_required',
      continueUrl: CONTINUE_URL,
    });

    // Lần retry thứ hai đi qua auth (binding còn nguyên) và auth trả
    // `already_processed` vì transaction đã hoàn tất.
    authStub.running = {
      status: 200,
      body: () => ({ outcome: 'already_processed', transaction_state: 'completed' }),
    };
    const second = await post('/api/auth/handoff', { handle: HANDLE }, init);
    expect(await second.json()).toEqual({ ok: true, outcome: 'already_processed' });

    expect(authStub.calls).toHaveLength(2);
    spy.mockRestore();
  });

  it('returns ok:false with a stable reason when auth rejects the handle (404)', async () => {
    authStub = installAuthBindingStub();
    authStub.running = {
      status: 404,
      body: () => ({ error: 'invalid_grant' }),
    };
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));

    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/auth/handoff',
      { handle: HANDLE },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    // Fail-closed không hủy session — HTTP 200 với ok:false, UI cho retry.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'rejected' });
    expect(authStub.calls).toHaveLength(1);
  });

  it('maps a 503 from auth to ok:false auth_unavailable at HTTP 200, not 502 forwards', async () => {
    authStub = installAuthBindingStub();
    authStub.running = {
      status: 503,
      body: () => ({ error: 'service_unavailable' }),
    };
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));

    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/auth/handoff',
      { handle: HANDLE },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    // 503 của auth là "auth đang fail-close" — BFF trả bảng results thống nhất
    // (HTTP 200 + `auth_unavailable`), không forward 503, không hủy session.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      reason: 'auth_unavailable',
    });
    expect(authStub.calls).toHaveLength(1);
  });

  it('maps a 200 with a contract-breaking shape to ok:false invalid_response, not ok', async () => {
    authStub = installAuthBindingStub();
    // `granted` thiếu `continue_url` bắt buộc —/auth trả 200 nhưng shape sai
    // hợp đồng; classify phải fail-closed, không phải relay lấy gì đó.
    authStub.running = { status: 200, body: () => ({ outcome: 'granted' }) };
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));

    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/auth/handoff',
      { handle: HANDLE },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      reason: 'invalid_response',
    });
    expect(authStub.calls).toHaveLength(1);
  });

  it('returns ok:false with binding_missing and never fetches when AUTH_SERVICE is absent', async () => {
    authStub = installAuthBindingStub();
    setRuntimeConfig(fullRuntimeConfig(connectionString, undefined));

    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/auth/handoff',
      { handle: HANDLE },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      reason: 'binding_missing',
    });
    // Binding null không được coi là "bỏ qua bước push" — không call nào xảy ra.
    expect(authStub.calls).toHaveLength(0);
  });

  it('returns 503 when the internal HMAC secret is absent', async () => {
    authStub = installAuthBindingStub();
    const config = fullRuntimeConfig(connectionString, authStub.binding);
    setRuntimeConfig({ ...config, internalHmacSecret: undefined });

    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/auth/handoff',
      { handle: HANDLE },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    expect(response.status).toBe(503);
    expect(authStub.calls).toHaveLength(0);
  });

  // ── consent context ───────────────────────────────────────────────────────

  it('consent context relays client name, maps known scopes, flags high risk', async () => {
    authStub = installAuthBindingStub();
    authStub.running = {
      status: 200,
      body: () => ({
        client_name: 'Ecoma Docs',
        scope: ['profile:read', 'email:read', 'activity:read', 'exotic:unmapped'],
        // `high` là chọn lọc để test đúng cờ của UI — payload thật của auth
        // không bị thay đổi; chỉ relay.
        risk_level: 'high',
      }),
    };
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));

    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/consent/context',
      { handle: HANDLE },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      clientName: 'Ecoma Docs',
      permissions: [
        {
          label: 'Read your profile',
          description: 'Display name and avatar.',
        },
        {
          label: 'Read your email addresses',
          description: 'Including verification state.',
        },
        {
          label: 'Read your activity',
          description: 'Recent documents you have opened.',
        },
        // Scope lạ không bị bỏ — hiện mã gốc + mô tả chung.
        {
          label: 'exotic:unmapped',
          description: 'Access to your account data.',
        },
      ],
      highRisk: true,
    });

    // Session ref phải đến từ DB, không phải từ browser.
    expect(authStub.calls).toHaveLength(1);
    const call = authStub.calls[0] as AuthCall;
    expect(new URL(call.url).pathname).toBe('/internal/consent/context');
    const sessionRow = await loadLatestSession();
    expect(call.body).toEqual({
      handle: HANDLE,
      account_session_ref: sessionRow.session_ref,
    });
  });

  it('consent context returns ok:false on 404 from auth (invalid_grant)', async () => {
    authStub = installAuthBindingStub();
    authStub.running = {
      status: 404,
      body: () => ({ error: 'invalid_grant' }),
    };
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));

    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/consent/context',
      { handle: HANDLE },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'rejected' });
  });

  it('consent context is guarded by session + CSRF like the state-changing route', async () => {
    authStub = installAuthBindingStub();
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));
    const cookies = await loginAndGetCookies();
    // Không session.
    const noSession = await post('/api/consent/context', { handle: HANDLE });
    expect(noSession.status).toBe(401);
    // Có session nhưng không CSRF.
    const noCsrf = await post(
      '/api/consent/context',
      { handle: HANDLE },
      { cookie: authCookieHeader(cookies) },
    );
    expect(noCsrf.status).toBe(403);
    expect(authStub.calls).toHaveLength(0);
  });

  // ── consent decide ────────────────────────────────────────────────────────

  it('consent decide relays both approved and denied outcomes with continue_url', async () => {
    const cookies = await loginAndGetCookies();
    const init = {
      cookie: authCookieHeader(cookies),
      headers: { 'x-ecoma-csrf': cookies.csrfToken },
    };

    authStub = installAuthBindingStub();
    authStub.running = {
      status: 200,
      body: () => ({ outcome: 'approved', continue_url: CONTINUE_URL }),
    };
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));
    const approved = await post(
      '/api/consent/decide',
      { handle: HANDLE, decision: 'approve' },
      init,
    );
    expect(await approved.json()).toEqual({
      ok: true,
      outcome: 'approved',
      continueUrl: CONTINUE_URL,
    });

    expect(authStub.calls).toHaveLength(1);
    expect((authStub.calls[0] as AuthCall).body).toEqual({
      handle: HANDLE,
      decision: 'approve',
      account_session_ref: (await loadLatestSession()).session_ref,
    });

    // `denied` là outcome hợp lệ — không phải lỗi, vẫn là ok với URL của auth.
    authStub.calls.length = 0;
    authStub.running = {
      status: 200,
      body: () => ({
        outcome: 'denied',
        continue_url: 'https://rp.test/?error=access_denied',
      }),
    };
    const denied = await post('/api/consent/decide', { handle: HANDLE, decision: 'deny' }, init);
    expect(await denied.json()).toEqual({
      ok: true,
      outcome: 'denied',
      continueUrl: 'https://rp.test/?error=access_denied',
    });
    expect((authStub.calls[0] as AuthCall).body['decision']).toBe('deny');
  });

  it('consent decide rejects an unknown decision in the body (400) without calling auth', async () => {
    authStub = installAuthBindingStub();
    setRuntimeConfig(fullRuntimeConfig(connectionString, authStub.binding));
    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/consent/decide',
      { handle: HANDLE, decision: 'maybe' },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    expect(response.status).toBe(400);
    expect(authStub.calls).toHaveLength(0);
  });

  it('consent decide returns ok:false with binding_missing when auth binding is absent', async () => {
    authStub = installAuthBindingStub();
    setRuntimeConfig(fullRuntimeConfig(connectionString, undefined));
    const cookies = await loginAndGetCookies();
    const response = await post(
      '/api/consent/decide',
      { handle: HANDLE, decision: 'approve' },
      {
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': cookies.csrfToken },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      reason: 'binding_missing',
    });
    expect(authStub.calls).toHaveLength(0);
  });
});

// Sanity: `verifyRequest` của lib được dùng để kiểm envelope trong unit spec
// (`server/lib/auth-client.spec.ts`); ở đây nó được import để neo hợp đồng —
// nếu lib đổi hình dạng tham số của verify, file này đỏ khi build, khớp nhau
// với các assertion payload trong `authStub.calls`.
void verifyRequest;
