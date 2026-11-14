/**
 * Route phát lời mời end-to-end — envelope HMAC thật, middleware thật,
 * client staff-access thật, DB thật.
 *
 * ## Verdict được giả ở **transport**, không mock module
 *
 * `createApp` + middleware `internal-auth` trước + route `/internal/account/
 * invitations` sau, `toWebHandler`; request ký bằng `signRequest` thật của
 * `@ecoma-io/internal-auth-contracts`. Phép kiểm quyền chạy qua **đúng** client
 * production (`server/lib/staff-access-client.ts`): nó ký envelope thật, gửi
 * tới `STAFF_ACCESS_SERVICE`, và validate response. Chỉ `fetch` của Service
 * Binding là giả, và nó **verify envelope** trước khi trả lời — nên test này
 * chứng minh cả chữ ký, `actorSub` trong chuỗi ký, và nội dung request
 * (`permission` + `correlation_id`), không chỉ shape response.
 *
 * E2E qua mạng thật tới một `staff-access` đang chạy thuộc #26/#27 — không
 * phải của slice này.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import invitationsRoute from '../../server/routes/internal/account/invitations.post';
import internalAuthMiddleware from '../../server/middleware/internal-auth';
import { writeLog } from '../../server/utils/logger';
import { signRequest, verifyRequest } from '@ecoma-io/internal-auth-contracts';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));

/**
 * Trạng thái của transport giả và bản ghi request cuối — mutable cell để test
 * đổi verdict/khả năng kết nối giữa các case mà không phải dựng lại app.
 */
const staffAccessState = vi.hoisted(() => ({
  mode: 'verdict' as 'verdict' | 'unreachable' | 'unconfigured',
  verdict: 'denied' as 'allowed' | 'denied',
  lastRequest: null as null | {
    readonly actorSub: string | null;
    readonly permission: string;
    readonly correlationId: string;
  },
}));

const mockedWriteLog = vi.mocked(writeLog);

const SECRET = 'test-internal-hmac-secret-0123456789abcdef';
/** Secret của path Account↔Staff-Access — **khác** `SECRET`, như ở deployment thật. */
const STAFF_ACCESS_SECRET = 'test-staff-access-internal-secret-0123456789';
const STAFF_ACTOR_STAFF_ID = 'eeb3abcb-31ef-479f-9dd1-198a9d520b1b';
const SUB_OPERATOR = `sub_${'o'.repeat(32)}`;
const PATH = '/internal/account/invitations';
const EMAIL_INVITED = 'route.invited@example.com';

/** `fetch` của binding giả: verify envelope thật, ghi lại request, trả verdict đã chọn. */
async function staffAccessFetch(request: Request): Promise<Response> {
  if (staffAccessState.mode === 'unreachable') {
    throw new Error('connect ECONNREFUSED');
  }
  const text = await request.text();
  const verified = await verifyRequest({
    method: request.method,
    path: new URL(request.url).pathname,
    body: new TextEncoder().encode(text),
    headers: request.headers,
    secret: STAFF_ACCESS_SECRET,
    now: String(Math.floor(Date.now() / 1000)),
    // Kho nonce của fake: mỗi request một nonce mới (`createNonce`) nên luôn
    // "chưa bị chiếm". Chống replay của envelope là hợp đồng của
    // `@ecoma-io/internal-auth-contracts`, có test riêng; ở đây cần chữ ký và
    // `actorSub` trong chuỗi ký.
    claimNonce: async () => false,
  });
  if (!verified.ok) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  const parsed = JSON.parse(text) as { permission?: string; correlation_id?: string };
  staffAccessState.lastRequest = {
    actorSub: verified.actorSub,
    permission: parsed.permission ?? '',
    correlationId: parsed.correlation_id ?? '',
  };
  return new Response(
    JSON.stringify({
      verdict: staffAccessState.verdict,
      actor_staff_id: STAFF_ACTOR_STAFF_ID,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('POST /internal/account/invitations end-to-end', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let connectionString: string;

  function fullRuntimeConfig(): AccountTestRuntimeConfig {
    const env: Record<string, unknown> = { DB_ACCOUNT: { connectionString } };
    if (staffAccessState.mode !== 'unconfigured') {
      env['STAFF_ACCESS_SERVICE'] = { fetch: staffAccessFetch };
    }
    return {
      internalHmacSecret: SECRET,
      otpHmacSecret: 'test-otp-hmac-secret-0123456789abcdef',
      mailServiceUrl: 'https://mail.test',
      mailInternalAuthSecret: 'test-mail-internal-auth-secret-placeholder-0001',
      staffAccessInternalAuthSecret: STAFF_ACCESS_SECRET,
      cloudflare: { env },
    };
  }

  /** Ký envelope cho POST body — `actorSub` nằm trong chuỗi ký. */
  async function signedPost(
    body: unknown,
    options: { actorSub?: string; secret?: string } = {},
  ): Promise<Response> {
    const bodyText = JSON.stringify(body);
    const headers = await signRequest({
      method: 'POST',
      path: PATH,
      body: new TextEncoder().encode(bodyText),
      actorSub: options.actorSub === undefined ? undefined : options.actorSub,
      secret: options.secret ?? SECRET,
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    return handler(
      new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: bodyText,
      }),
    );
  }

  beforeAll(async () => {
    db = await startAccountDatabase();
    connectionString = `postgres://ecoma_account_runtime:${db.rolePassword}@${db.host}:${db.port}/${ACCOUNT_DATABASE}`;
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig());

    const app = createApp();
    app.use(internalAuthMiddleware);
    const router = createRouter();
    router.post(PATH, invitationsRoute);
    app.use(router.handler);
    handler = toWebHandler(app);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    staffAccessState.mode = 'verdict';
    staffAccessState.verdict = 'denied';
    staffAccessState.lastRequest = null;
    setRuntimeConfig(fullRuntimeConfig());
    mockedWriteLog.mockClear();
    await db.truncateData();
  });

  it('rejects an unsigned request with 401', async () => {
    const response = await handler(
      new Request(`http://localhost${PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: EMAIL_INVITED }),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects an envelope without an actor identity with 401', async () => {
    // Envelope hợp lệ nhưng không khai `actorSub`: endpoint đòi principal
    // operator cho attribution (ADR-0030 Quyết định 3) — fail closed.
    const response = await signedPost({ address: EMAIL_INVITED }, { actorSub: undefined });
    expect(response.status).toBe(401);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'no_actor_principal' }),
    );
  });

  it('fails closed with 503 when the staff-access binding is not configured', async () => {
    staffAccessState.mode = 'unconfigured';
    setRuntimeConfig(fullRuntimeConfig());
    const response = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(response.status).toBe(503);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'account_invitations.failed',
        reason: 'authorization_surface_not_configured',
      }),
    );
    const client = await db.connect();
    try {
      const { rows } = await client.query(`SELECT id FROM account.invitations`);
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('fails closed with 503 when staff-access is unreachable', async () => {
    staffAccessState.mode = 'unreachable';
    setRuntimeConfig(fullRuntimeConfig());
    const response = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(response.status).toBe(503);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'authorization_surface_unreachable' }),
    );
    const client = await db.connect();
    try {
      const { rows } = await client.query(`SELECT id FROM account.invitations`);
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('issues an invitation with 201 and records attribution when allowed', async () => {
    staffAccessState.verdict = 'allowed';
    const before = Date.now();
    const response = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      id: string;
      status: string;
      issued_at: string;
      expires_at: string;
      correlation_id: string;
    };
    expect(payload.status).toBe('open');
    expect(payload.id).toBeDefined();
    expect(payload.correlation_id).toBeDefined();
    // Cùng **một** correlation_id đi xuống staff-access (hàng audit của verdict)
    // và vào hàng lời mời của account — không phải hai giá trị song song.
    expect(staffAccessState.lastRequest).toEqual({
      actorSub: SUB_OPERATOR,
      permission: 'invitation.create',
      correlationId: payload.correlation_id,
    });
    const issuedAt = Date.parse(payload.issued_at);
    const expiresAt = Date.parse(payload.expires_at);
    expect(issuedAt).toBeGreaterThanOrEqual(before - 5000);
    // TTL 7 ngày (±5s hai đồng hồ).
    expect(Math.abs(expiresAt - issuedAt - 7 * 24 * 3600 * 1000)).toBeLessThan(5000);

    const client = await db.connect();
    try {
      const { rows } = await client.query<{
        actor_sub: string;
        actor_staff_id: string | null;
        status: string;
      }>(`SELECT actor_sub, actor_staff_id, status FROM account.invitations`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_sub: SUB_OPERATOR,
        actor_staff_id: STAFF_ACTOR_STAFF_ID,
        status: 'open',
      });
    } finally {
      await client.end();
    }
  });

  it('returns 403 without writing a row when the verdict is denied', async () => {
    staffAccessState.verdict = 'denied';
    const response = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(response.status).toBe(403);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'account_invitations.denied', sub: SUB_OPERATOR }),
    );
    // Phép kiểm đã thật sự chạy: request tới staff-access mang đúng permission
    // và đúng operator trong chuỗi ký (đây mới là thứ `staff-access` dùng để
    // quyết verdict và ghi hàng audit `denied`).
    expect(staffAccessState.lastRequest).toMatchObject({
      actorSub: SUB_OPERATOR,
      permission: 'invitation.create',
    });
    const client = await db.connect();
    try {
      const { rows } = await client.query(`SELECT id FROM account.invitations`);
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('returns 409 with the canonical reason for the bootstrap address', async () => {
    staffAccessState.verdict = 'allowed';
    const response = await signedPost(
      { address: 'superadmin@ecoma.io' },
      { actorSub: SUB_OPERATOR },
    );
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { reason?: string };
    expect(payload.reason).toBe('canonical_address_reserved');
  });

  it('returns 409 invitation_already_open for a second open invitation of the same address', async () => {
    staffAccessState.verdict = 'allowed';
    const first = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(first.status).toBe(201);

    const second = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(second.status).toBe(409);
    const payload = (await second.json()) as { reason?: string };
    expect(payload.reason).toBe('invitation_already_open');
  });

  it('returns 400 for a body without an address', async () => {
    staffAccessState.verdict = 'allowed';
    const response = await signedPost({ email: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(response.status).toBe(400);
  });

  it('rejects a forged signature with 401', async () => {
    const response = await signedPost(
      { address: EMAIL_INVITED },
      { actorSub: SUB_OPERATOR, secret: 'wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxx' },
    );
    expect(response.status).toBe(401);
  });
});
