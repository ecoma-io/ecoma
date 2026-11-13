/**
 * Route phát lời mời end-to-end — envelope HMAC thật, middleware thật, DB thật.
 *
 * ## Cấu hình giống `internal-auth-e2e.spec.ts`
 *
 * `createApp` + middleware `internal-auth` trước + route `/internal/account/
 * invitations` sau, `toWebHandler`; request ký bằng `signRequest` thật của
 * `@ecoma-io/internal-auth-contracts` (kèm `actorSub` trong header nội bộ —
 * nằm trong chuỗi ký). `db-account` thật qua credential runtime.
 *
 * ## Verdict permission được stub ở biên module
 *
 * Hợp đồng verdict của staff-access chưa tồn tại (ADR-0009) — cổng production
 * trả `unavailable`. Test mock **module** `server/lib/authorization` (biên giữa
 * route và việc hỏi staff-access), chuyển verdict giữa `allowed`/`denied` để
 * đo shape response của ba nhánh route. Stub này là hợp đồng-faithful: cổng
 * trả đúng union `IssuanceAuthorization`. E2E thật qua mạng với staff-access
 * thuộc #26/#27 — không phải của slice này.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import invitationsRoute from '../../server/routes/internal/account/invitations.post';
import internalAuthMiddleware from '../../server/middleware/internal-auth';
import { writeLog } from '../../server/utils/logger';
import { signRequest } from '@ecoma-io/internal-auth-contracts';
import type { IssuanceAuthorization } from '../../server/lib/authorization';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));

/**
 * Trạng thái verdict của cổng cho từng test — mock module giữ hình hợp đồng
 * `IssuanceAuthorization` thật, chỉ đổi verdict qua biến này.
 */
const authorizationState = vi.hoisted(() => ({
  verdict: 'unavailable' as 'allowed' | 'denied' | 'unavailable',
}));

vi.mock('../../server/lib/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/authorization')>();
  return {
    ...actual,
    authorizeInvitationIssuance: vi.fn<() => Promise<IssuanceAuthorization>>(async () => {
      if (authorizationState.verdict === 'allowed') {
        return { verdict: 'allowed', actorStaffId: 'stf_00000000-0000-0000-0000-000000000001' };
      }
      if (authorizationState.verdict === 'denied') {
        return { verdict: 'denied' };
      }
      return {
        verdict: 'unavailable',
        reason: 'authorization_contract_not_established',
      };
    }),
  };
});

const mockedWriteLog = vi.mocked(writeLog);

const SECRET = 'test-internal-hmac-secret-0123456789abcdef';
const SUB_OPERATOR = `sub_${'o'.repeat(32)}`;
const PATH = '/internal/account/invitations';
const EMAIL_INVITED = 'route.invited@example.com';

describe('POST /internal/account/invitations end-to-end', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let connectionString: string;

  function fullRuntimeConfig(): AccountTestRuntimeConfig {
    return {
      internalHmacSecret: SECRET,
      otpHmacSecret: 'test-otp-hmac-secret-0123456789abcdef',
      mailServiceUrl: 'https://mail.test',
      mailInternalAuthSecret: 'test-mail-internal-auth-secret-placeholder-0001',
      cloudflare: {
        env: { DB_ACCOUNT: { connectionString } },
      },
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
    setRuntimeConfig(fullRuntimeConfig());
    mockedWriteLog.mockClear();
    authorizationState.verdict = 'unavailable';
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

  it('fails closed with 503 while no staff-access verdict contract exists', async () => {
    // Production hiện tại: cổng trả `unavailable` (ADR-0009) → 503, không có
    // hàng lời mời nào được ghi — không đường nào phát lời mời mà không có
    // verdict của staff-access.
    const response = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(response.status).toBe(503);
    const client = await db.connect();
    try {
      const { rows } = await client.query(`SELECT id FROM account.invitations`);
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('issues an invitation with 201 and records attribution when allowed', async () => {
    authorizationState.verdict = 'allowed';
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
        actor_staff_id: 'stf_00000000-0000-0000-0000-000000000001',
        status: 'open',
      });
    } finally {
      await client.end();
    }
  });

  it('returns 403 without writing a row when the verdict is denied', async () => {
    authorizationState.verdict = 'denied';
    const response = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(response.status).toBe(403);
    expect(mockedWriteLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'account_invitations.denied', sub: SUB_OPERATOR }),
    );
    const client = await db.connect();
    try {
      const { rows } = await client.query(`SELECT id FROM account.invitations`);
      expect(rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });

  it('returns 409 with the canonical reason for the bootstrap address', async () => {
    authorizationState.verdict = 'allowed';
    const response = await signedPost(
      { address: 'superadmin@ecoma.io' },
      { actorSub: SUB_OPERATOR },
    );
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { reason?: string };
    expect(payload.reason).toBe('canonical_address_reserved');
  });

  it('returns 409 invitation_already_open for a second open invitation of the same address', async () => {
    authorizationState.verdict = 'allowed';
    const first = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(first.status).toBe(201);

    const second = await signedPost({ address: EMAIL_INVITED }, { actorSub: SUB_OPERATOR });
    expect(second.status).toBe(409);
    const payload = (await second.json()) as { reason?: string };
    expect(payload.reason).toBe('invitation_already_open');
  });

  it('returns 400 for a body without an address', async () => {
    authorizationState.verdict = 'allowed';
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
