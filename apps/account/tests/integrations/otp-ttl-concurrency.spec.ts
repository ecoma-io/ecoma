/**
 * Regression OTP — TTL hết hạn và verify đồng thời (single-use).
 *
 * Phần single-use trùng chủ đề với `otp-invariants.spec.ts` (PR #47) nhưng suite
 * này giữ một vector khác biệt: TTL hết hạn TỰ NHIÊN của một mã ĐÚNG —
 * không seed lỗi, không khoá tay, chỉ đẩy thời gian — rồi verify qua ROUTE.
 * Phần TTL là vector mà cả `otp-flow-e2e` lẫn `otp-invariants` chưa phủ ở mức đầy
 * đủ của route: mã ĐÚNG nhưng hàng đã quá TTL (hết hạn tự nhiên), rồi được verify
 * NHẬN RA là hết hạn (nhánh `challenge_expired` — khoá logic 400 chung chung).
 *
 * Route thật, DB thật, h3 app thật — cùng luật với các suite OTP còn lại.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import challengeRoute from '../../server/api/auth/challenge.post';
import verifyRoute from '../../server/api/auth/verify.post';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));
const OTP_SECRET = 'test-otp-hmac-secret-0123456789abcdef';
const SUB_MAIN = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EMAIL_MAIN = 'user@example.com';

function fullRuntimeConfig(connectionString: string): AccountTestRuntimeConfig {
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

function installMailStub(): {
  sent: Array<{ body: Record<string, unknown> }>;
  restore: () => void;
} {
  const sent: Array<{ body: Record<string, unknown> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
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
    const payload = {
      id: 'msg-1',
      delivery_id: 'dlv-1',
      app: 'account',
      template: body['template'],
      template_version: 1,
      status: 'queued',
      created: true,
      created_at: new Date().toISOString(),
    };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe('OTP TTL expiry and concurrent verify', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let connectionString: string;

  async function post(path: string, body: unknown): Promise<Response> {
    return handler(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  async function seedVerifiedEmail(email: string, sub: string): Promise<void> {
    const client = await db.connect();
    try {
      await client.query(`INSERT INTO account.users (sub) VALUES ($1) ON CONFLICT DO NOTHING`, [
        sub,
      ]);
      const normalized = email.trim().toLowerCase();
      await client.query(
        `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
         VALUES ($1, $2, $3, 'verified', true, now())`,
        [
          sub,
          normalized,
          (await import('node:crypto')).createHash('sha256').update(normalized).digest('hex'),
        ],
      );
    } finally {
      await client.end();
    }
  }

  async function challenge(email: string): Promise<string> {
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
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig(connectionString));

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
    setRuntimeConfig(fullRuntimeConfig(connectionString));
    await db.truncateData();
    await seedVerifiedEmail(EMAIL_MAIN, SUB_MAIN);
  });

  it('rejects a correct code once the challenge has expired (TTL boundary, locks the row)', async () => {
    const code = await challenge(EMAIL_MAIN);

    // Đẩy challenge ra ngoài TTL mà vẫn thoả CHECK expires_at > created_at.
    const client = await db.connect();
    try {
      await client.query(
        `UPDATE account.otp_challenges
            SET created_at = now() - interval '2 seconds',
                expires_at = now() - interval '1 second'
          WHERE consumed_at IS NULL`,
      );
    } finally {
      await client.end();
    }

    const response = await post('/api/auth/verify', { email: EMAIL_MAIN, code });
    expect(response.status).toBe(400);

    // Challenge bị KHOÁ bởi nhánh hết hạn (expireChallengeIfExpired — hygiene vòng
    // đời theo PR #47): hàng hết hạn phải rời trạng thái "active theo ràng buộc",
    // không còn đường nào hồi sinh — mã (kể cả đúng) không thể tái sử dụng nữa.
    const check = await db.connect();
    try {
      const { rows } = await check.query<{ consumed: string }>(
        `SELECT count(consumed_at) AS consumed FROM account.otp_challenges`,
      );
      expect(Number(rows[0]?.consumed)).toBe(1);

      // Session không thể phát hành từ mã hết hạn: không session nào tồn tại.
      const sessions = await check.query<{ count: string }>(
        `SELECT count(*) AS count FROM account.account_sessions`,
      );
      expect(Number(sessions.rows[0]?.count)).toBe(0);
    } finally {
      await check.end();
    }
  });

  it('issues exactly one session when two verifies race on the same code', async () => {
    const code = await challenge(EMAIL_MAIN);

    const [first, second] = await Promise.all([
      post('/api/auth/verify', { email: EMAIL_MAIN, code }),
      post('/api/auth/verify', { email: EMAIL_MAIN, code }),
    ]);

    const statuses = [first.status, second.status].toSorted();
    expect(statuses).toEqual([200, 400]);

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM account.account_sessions`,
      );
      expect(Number(rows[0]?.count)).toBe(1);
    } finally {
      await client.end();
    }
  });
});
