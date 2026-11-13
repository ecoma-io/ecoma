/**
 * Chấp nhận lời mời end-to-end — challenge → mail → verify → Account sinh ra,
 * đi qua đúng luồng email-OTP đăng nhập (ADR-0030 Quyết định 2).
 *
 * ## Cấu hình giống `otp-flow-e2e.spec.ts`
 *
 * Route thật (`challenge.post` / `verify.post`), h3 app thật, `db-account` thật
 * qua credential runtime, mail stub ở mức fetch global. Lời mời được seed trực
 * tiếp vào DB bằng superuser — đường phát qua route `/internal/account/
 * invitations` được đo riêng ở `invitations-route-e2e.spec.ts`; suite này đo
 * **đường người được mời**, không phụ thuộc enforcement của đường phát.
 *
 * ## Những hành vi được đo ở đây mà tầng database không đo được
 *
 * - Mail **thật đi ra** cho địa chỉ có lời mời mở (và không đi ra cho địa chỉ
 *   lạ — anti-enumeration giữ nguyên hình 204).
 * - Verify thành công cấp cookie session cho `sub` vừa sinh ra — `sub` mới
 *   không biết trước, test đọc từ DB.
 * - Sau chấp nhận, cùng địa chỉ trở thành địa chỉ verified bình thường: challenge
 *   kế tiếp gửi mail theo luồng đăng nhập thường.
 * - Replay: mã đã dùng không chấp nhận lại, không phát hành session thứ hai.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import challengeRoute from '../../server/api/auth/challenge.post';
import verifyRoute from '../../server/api/auth/verify.post';
import { writeLog } from '../../server/utils/logger';
import { INVITATION_AUDIT_TYPE } from '../../server/lib/invitation';
import {
  CSRF_COOKIE_NAME,
  hashSessionIdentifier,
  SESSION_COOKIE_NAME,
} from '../../server/lib/session';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));

const mockedWriteLog = vi.mocked(writeLog);

const OTP_SECRET = 'test-otp-hmac-secret-0123456789abcdef';
const EMAIL_INVITED = 'invited.person@example.com';
const EMAIL_UNKNOWN = 'ghost@example.com';
const ACTOR_SUB = `sub_${'c'.repeat(32)}`;
const ACTOR_STAFF_ID = 'stf_00000000-0000-0000-0000-000000000001';

/** Fetch stub mail — cùng hình với `otp-flow-e2e.spec.ts`, trả về payload nhận được. */
function installMailStub(): {
  sent: Array<{ url: string; body: Record<string, unknown> }>;
  restore: () => void;
} {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = init?.body;
    const bodyText =
      typeof rawBody === 'string'
        ? rawBody
        : rawBody instanceof Uint8Array
          ? new TextDecoder().decode(rawBody)
          : String(rawBody ?? '{}');
    sent.push({ url: String(input), body: JSON.parse(bodyText) as Record<string, unknown> });
    return new Response(
      JSON.stringify({
        id: 'msg-1',
        delivery_id: 'dlv-1',
        app: 'account',
        template: 'otp-login',
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
  return found === undefined ? undefined : found.slice(name.length + 1).split(';')[0];
}

describe('invitation acceptance end-to-end', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let connectionString: string;

  function fullRuntimeConfig(): AccountTestRuntimeConfig {
    return {
      internalHmacSecret: 'test-internal-hmac-secret-0123456789abcdef',
      otpHmacSecret: OTP_SECRET,
      mailServiceUrl: 'https://mail.test',
      mailInternalAuthSecret: 'test-mail-internal-auth-secret-placeholder-0001',
      cloudflare: {
        env: { DB_ACCOUNT: { connectionString } },
      },
    };
  }

  /** Seed một lời mời mở cho địa chỉ — bằng superuser, đường phát là suite khác. */
  async function seedOpenInvitation(email: string): Promise<string> {
    const client = await db.connect();
    try {
      const normalized = email.trim().toLowerCase();
      const hash = (await import('node:crypto'))
        .createHash('sha256')
        .update(normalized)
        .digest('hex');
      await client.query(
        `INSERT INTO account.invitations
           (address_hash, address_normalized, actor_sub, actor_staff_id, correlation_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
         RETURNING id`,
        [hash, normalized, ACTOR_SUB, ACTOR_STAFF_ID, 'corr-e2e-' + hash.slice(0, 8)],
      );
      return hash;
    } finally {
      await client.end();
    }
  }

  async function post(
    path: string,
    body: unknown,
    init: { cookie?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
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

  /** Challenge cho địa chỉ có lời mời — trả mã từ mail stub. */
  async function challengeForInvited(email: string): Promise<string> {
    const mail = installMailStub();
    try {
      const response = await post('/api/auth/challenge', { email });
      expect(response.status).toBe(204);
      expect(mail.sent).toHaveLength(1);
      const code = mail.sent[0]?.body['variables'] as { code?: string } | undefined;
      expect(typeof code?.code).toBe('string');
      return code?.code as string;
    } finally {
      mail.restore();
    }
  }

  beforeAll(async () => {
    db = await startAccountDatabase();
    connectionString = `postgres://ecoma_account_runtime:${db.rolePassword}@${db.host}:${db.port}/${ACCOUNT_DATABASE}`;
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig());

    const app = createApp();
    const router = createRouter();
    router.post('/api/auth/challenge', challengeRoute);
    router.post('/api/auth/verify', verifyRoute);
    app.use(router.handler);
    handler = toWebHandler(app);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    setRuntimeConfig(fullRuntimeConfig());
    mockedWriteLog.mockClear();
    await db.truncateData();
  });

  it('sends real mail for an open invitation and rejects a wrong code uniformly', async () => {
    await seedOpenInvitation(EMAIL_INVITED);
    await challengeForInvited(EMAIL_INVITED);

    const mail = installMailStub();
    try {
      const response = await post('/api/auth/verify', { email: EMAIL_INVITED, code: '00000000' });
      // 400 chung như mọi nhánh từ chối — anti-guessing không đổi cho lời mời.
      expect(response.status).toBe(400);
      expect(mockedWriteLog).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'otp_verify.rejected', reason: 'code_mismatch' }),
      );
    } finally {
      mail.restore();
    }
    expect(mail.sent).toHaveLength(0);

    // Lời mời vẫn mở sau một lần thử sai.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM account.invitations`,
      );
      expect(rows[0]?.status).toBe('open');
    } finally {
      await client.end();
    }
  });

  it('accepts: creates the account, verified email, provenance and a session cookie', async () => {
    await seedOpenInvitation(EMAIL_INVITED);
    const code = await challengeForInvited(EMAIL_INVITED);

    const mail = installMailStub();
    try {
      const response = await post('/api/auth/verify', { email: EMAIL_INVITED, code });
      expect(response.status).toBe(200);
    } finally {
      mail.restore();
    }
    expect(mail.sent).toHaveLength(0);

    const client = await db.connect();
    try {
      // Lời mời accepted, cặp accepted trỏ đúng `sub` vừa sinh.
      const invitation = await client.query<{
        status: string;
        accepted_sub: string | null;
      }>(`SELECT status, accepted_sub FROM account.invitations`);
      expect(invitation.rows[0]).toMatchObject({ status: 'accepted' });
      const acceptedSub = invitation.rows[0]?.accepted_sub;
      expect(acceptedSub).toMatch(/^sub_[a-z2-7]{32}$/u);

      // Account active + email verified is_sign_in.
      const user = await client.query<{ status: string }>(
        `SELECT status FROM account.users WHERE sub = $1`,
        [acceptedSub],
      );
      expect(user.rows[0]?.status).toBe('active');
      const email = await client.query<{ status: string; is_sign_in: boolean }>(
        `SELECT status, is_sign_in FROM account.email_addresses
          WHERE user_sub = $1`,
        [acceptedSub],
      );
      expect(email.rows[0]).toMatchObject({ status: 'verified', is_sign_in: true });

      // Provenance với attribution đầy đủ.
      const event = await client.query<{ outcome: string; metadata: Record<string, unknown> }>(
        `SELECT outcome, metadata FROM account.security_events
          WHERE type = $1 ORDER BY occurred_at DESC LIMIT 1`,
        [INVITATION_AUDIT_TYPE],
      );
      expect(event.rows[0]?.outcome).toBe('success');
      expect(event.rows[0]?.metadata.correlation_id).toMatch(/^corr-e2e-/u);

      // Session thuộc sub mới, cookie session + CSRF đã cấp.
      const session = await client.query<{ user_sub: string | null; revoked_at: Date | null }>(
        `SELECT user_sub, revoked_at FROM account.account_sessions
          WHERE user_sub = $1`,
        [acceptedSub],
      );
      expect(session.rows).toHaveLength(1);
      expect(session.rows[0]?.revoked_at).toBeNull();
    } finally {
      await client.end();
    }
  });

  it('issues session cookies bound to the new sub', async () => {
    await seedOpenInvitation(EMAIL_INVITED);
    const code = await challengeForInvited(EMAIL_INVITED);

    const response = await post('/api/auth/verify', { email: EMAIL_INVITED, code });
    expect(response.status).toBe(200);
    const cookies = setCookies(response);
    const sessionCookie = cookieValue(cookies, SESSION_COOKIE_NAME);
    expect(sessionCookie).toBeDefined();
    expect(cookieValue(cookies, CSRF_COOKIE_NAME)).toBeDefined();
    if (sessionCookie === undefined) {
      throw new Error('session cookie missing from Set-Cookie');
    }

    // Binding thật giữa cookie và `sub` vừa sinh: hash SHA-256 của giá trị
    // cookie phải trỏ đúng hàng session sống trong DB, và hàng đó thuộc đúng
    // `sub` mà cặp accepted của lời mời ghi — không chỉ "có cookie".
    const identifierHash = await hashSessionIdentifier(sessionCookie);
    const client = await db.connect();
    try {
      const session = await client.query<{ user_sub: string | null; revoked_at: Date | null }>(
        `SELECT user_sub, revoked_at FROM account.account_sessions WHERE id_hash = $1`,
        [identifierHash],
      );
      expect(session.rows).toHaveLength(1);
      expect(session.rows[0]?.revoked_at).toBeNull();
      const invitation = await client.query<{ accepted_sub: string | null }>(
        `SELECT accepted_sub FROM account.invitations WHERE status = 'accepted'`,
      );
      expect(session.rows[0]?.user_sub).toBe(invitation.rows[0]?.accepted_sub);
    } finally {
      await client.end();
    }
  });

  it('does not accept a replayed code and issues no second session', async () => {
    await seedOpenInvitation(EMAIL_INVITED);
    const code = await challengeForInvited(EMAIL_INVITED);
    const first = await post('/api/auth/verify', { email: EMAIL_INVITED, code });
    expect(first.status).toBe(200);

    const second = await post('/api/auth/verify', { email: EMAIL_INVITED, code });
    expect(second.status).toBe(400);
    // Không Set-Cookie nào trên nhánh từ chối.
    expect(setCookies(second)).toHaveLength(0);

    const client = await db.connect();
    try {
      const { rows } = await client.query(`SELECT user_sub FROM account.account_sessions`);
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it('keeps the challenge route silent for an address without any invitation', async () => {
    const mail = installMailStub();
    try {
      const response = await post('/api/auth/challenge', { email: EMAIL_UNKNOWN });
      expect(response.status).toBe(204);
      expect(mail.sent).toHaveLength(0);
    } finally {
      mail.restore();
    }
  });

  it('serves the address through the normal login flow after acceptance', async () => {
    await seedOpenInvitation(EMAIL_INVITED);
    const code = await challengeForInvited(EMAIL_INVITED);
    const accepted = await post('/api/auth/verify', { email: EMAIL_INVITED, code });
    expect(accepted.status).toBe(200);

    // Sau chấp nhận, địa chỉ đã verified: challenge kế tiếp gửi mail theo luồng
    // đăng nhập thường — kênh lời mời đã "xong việc" cho địa chỉ này.
    const mail = installMailStub();
    try {
      const response = await post('/api/auth/challenge', { email: EMAIL_INVITED });
      expect(response.status).toBe(204);
      expect(mail.sent).toHaveLength(1);
    } finally {
      mail.restore();
    }
  });
});
