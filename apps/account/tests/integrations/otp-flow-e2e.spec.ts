/**
 * Luồng email-OTP end-to-end — route thật, DB thật, h3 app thật.
 *
 * ## Vì sao suite này dựng đúng đường production đi qua
 *
 * Giống `status-route-e2e.spec.ts`: `createApp` + `createRouter` + `toWebHandler`,
 * handler import trực tiếp từ `server/api/auth/**`, `db-account` thật qua
 * credential runtime thật. Khác biệt: ba route này **không** nằm sau middleware
 * internal-auth (chúng là đường public BFF của browser), nhưng đọc cùng
 * `useRuntimeConfig` — stub qua `installRuntimeConfigStub`.
 *
 * ## Mail không phải là biến của suite này
 *
 * Route `challenge` gọi `sendMail` — HTTP fetch thật tới origin từ
 * `mailServiceUrl`. Test không dựng server mail nào: fetch được stub ở mức
 * **global** với một hander giả lập hợp đồng (`POST` + `2xx` + shape response).
 * Mức stub này là trung thực về biên: adapter chỉ dùng `fetch` chuẩn; hợp đồng
 * `POST /v1/messages` thuộc về service `transactional-mail`, và shape request mà
 * adapter dựng đã được `mail.spec.ts` neo qua validator thật của lib contract.
 */

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import challengeRoute from '../../server/api/auth/challenge.post';
import logoutRoute from '../../server/api/auth/logout.post';
import sessionRoute from '../../server/api/auth/session.get';
import verifyRoute from '../../server/api/auth/verify.post';
import { writeLog } from '../../server/utils/logger';
import { OTP_ACR } from '../../server/lib/session';
import {
  OTP_RATE_LIMIT_SHORT_MAX,
  OTP_RATE_LIMIT_SHORT_WINDOW_SECONDS,
  countChallengesSince,
  insertChallenge,
} from '../../server/lib/otp';
import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));
/** Secret OTP của test — đủ dài theo validation, không phải secret thật. */
const OTP_SECRET = 'test-otp-hmac-secret-0123456789abcdef';

/** `sub` hợp lệ theo `isSubject` — prefix `sub_` + 32 base32 thường. */
const SUB_MAIN = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SUB_SUSPENDED = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const EMAIL_MAIN = 'user@example.com';
const EMAIL_SUSPENDED = 'suspended@example.com';
const EMAIL_UNKNOWN = 'ghost@example.com';

const mockedWriteLog = vi.mocked(writeLog);

/** Runtime config đầy đủ — secret + binding tới container của test. */
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

/**
 * Fetch stub giả lập transactional-mail: mọi POST `/v1/messages` nhận 2xx hợp lệ.
 *
 * Trả về handler **và** danh sách payload đã nhận để test assert "mail đúng đi
 * ra cho địa chỉ verified, và KHÔNG đi ra cho địa chỉ lạ".
 */
function installMailStub(options: { status?: number; shape?: unknown } = {}): {
  sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }>;
  restore: () => void;
} {
  const sent: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
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
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers[key] = value;
    }
    sent.push({ url: String(input), headers, body });
    const payload = options.shape ?? {
      id: 'msg-1',
      delivery_id: 'dlv-1',
      app: 'account',
      template: body['template'],
      template_version: 1,
      status: 'queued',
      created: true,
      created_at: new Date().toISOString(),
    };
    return new Response(JSON.stringify(payload), { status: options.status ?? 200 });
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Đọc cookie từ header Set-Cookie của response. */
function setCookies(response: Response): string[] {
  const raw = response.headers.getSetCookie();
  return raw;
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (found === undefined) {
    return undefined;
  }
  return found.slice(name.length + 1).split(';')[0];
}

describe('email OTP flow end-to-end', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let connectionString: string;

  /** POST JSON tới route trong app h3 của test. */
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

  async function get(path: string, cookie?: string): Promise<Response> {
    return handler(
      new Request(`http://localhost${path}`, {
        headers: cookie === undefined ? {} : { cookie },
      }),
    );
  }

  /**
   * Chuẩn bị account verified cho một địa chỉ: user + email_addresses verified.
   *
   * Trả về session_ref của session verify tạo ra — lấy từ DB bằng hash cookie.
   */
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

  /** Challenge cho một địa chỉ, trả mã từ fetch stub (địa chỉ verified). */
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

  /** Verify với mã, trả response — caller tự assert status. */
  function verify(email: string, code: string, cookie?: string): Promise<Response> {
    return post('/api/auth/verify', { email, code }, { cookie });
  }

  beforeAll(async () => {
    db = await startAccountDatabase();
    connectionString = `postgres://ecoma_account_runtime:${db.rolePassword}@${db.host}:${db.port}/${ACCOUNT_DATABASE}`;
    setRuntimeConfig = installRuntimeConfigStub(fullRuntimeConfig(connectionString));

    const app = createApp();
    const router = createRouter();
    router.post('/api/auth/challenge', challengeRoute);
    router.post('/api/auth/verify', verifyRoute);
    router.post('/api/auth/logout', logoutRoute);
    router.get('/api/auth/session', sessionRoute);
    app.use(router.handler);
    handler = toWebHandler(app);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    setRuntimeConfig(fullRuntimeConfig(connectionString));
    mockedWriteLog.mockClear();
    await db.truncateData();
    await seedVerifiedEmail(EMAIL_MAIN, SUB_MAIN);
    await seedVerifiedEmail(EMAIL_SUSPENDED, SUB_SUSPENDED);
    // Account của EMAIL_SUSPENDED bị suspended — fail-closed phải chặn verify.
    const client = await db.connect();
    try {
      await client.query(`UPDATE account.users SET status = 'suspended' WHERE sub = $1`, [
        SUB_SUSPENDED,
      ]);
    } finally {
      await client.end();
    }
  });

  it('issues a session from challenge to verify with the OTP ACR', async () => {
    const code = await challenge(EMAIL_MAIN);
    const response = await verify(EMAIL_MAIN, code);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok?: boolean };
    expect(body).toEqual({ ok: true });

    // Session trong DB: acr đúng URN OTP, có authn_at, chưa revoked.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{
        acr: string | null;
        authn_at: Date | null;
        revoked_at: Date | null;
        user_sub: string | null;
      }>(
        `SELECT acr, authn_at, revoked_at, user_sub FROM account.account_sessions
          WHERE revoked_at IS NULL`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.acr).toBe(OTP_ACR);
      expect(rows[0]?.authn_at).not.toBeNull();
      expect(rows[0]?.user_sub).toBe(SUB_MAIN);
    } finally {
      await client.end();
    }
  });

  it('sets both cookies with the required security attributes', async () => {
    const code = await challenge(EMAIL_MAIN);
    const response = await verify(EMAIL_MAIN, code);
    expect(response.status).toBe(200);

    const cookies = setCookies(response);
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('__Host-account-session='));
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('__Host-account-csrf='));

    expect(sessionCookie).toBeDefined();
    expect(csrfCookie).toBeDefined();

    // Cookie session: Secure + HttpOnly + SameSite=Lax + Path=/ + không Domain.
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Path=/');
    expect(sessionCookie).not.toContain('Domain=');
    // Cookie CSRF: KHÔNG HttpOnly — client JS phải đọc được để echo vào header.
    expect(csrfCookie).toContain('Secure');
    expect(csrfCookie).not.toContain('HttpOnly');
    expect(csrfCookie).toContain('SameSite=Lax');
    expect(csrfCookie).toContain('Path=/');
  });

  it('stores only the hash of the cookie value, never the value itself', async () => {
    const code = await challenge(EMAIL_MAIN);
    const response = await verify(EMAIL_MAIN, code);
    const cookie = cookieValue(setCookies(response), '__Host-account-session');
    expect(typeof cookie).toBe('string');

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ id_hash: string }>(
        `SELECT id_hash FROM account.account_sessions`,
      );
      expect(rows).toHaveLength(1);
      // Hash hex 64 của SHA-256 — và KHÔNG chứa giá trị cookie trần.
      expect(rows[0]?.id_hash).toMatch(/^[0-9a-f]{64}$/u);
      expect(rows[0]?.id_hash).not.toBe(cookie);
      expect(JSON.stringify(rows.map((row) => row.id_hash))).not.toContain(cookie as string);
    } finally {
      await client.end();
    }
  });

  it('reads the session back with GET /api/auth/session', async () => {
    const code = await challenge(EMAIL_MAIN);
    const verifyResponse = await verify(EMAIL_MAIN, code);
    const cookiePair = setCookies(verifyResponse)
      .filter((cookie) => cookie.startsWith('__Host-'))
      .map((cookie) => cookie.split(';')[0])
      .join('; ');

    const response = await get('/api/auth/session', cookiePair);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sub?: string;
      acr?: string;
      authnAt?: number | null;
      expiresAt?: number;
    };
    expect(body.sub).toBe(SUB_MAIN);
    expect(body.acr).toBe(OTP_ACR);
    expect(typeof body.authnAt).toBe('number');
    expect(typeof body.expiresAt).toBe('number');
  });

  it('returns 401 from GET /api/auth/session without a cookie', async () => {
    const response = await get('/api/auth/session');
    expect(response.status).toBe(401);
  });

  it('sends mail only to verified addresses and writes ghost challenges for the rest', async () => {
    const mail = installMailStub();
    try {
      await post('/api/auth/challenge', { email: EMAIL_MAIN });
      await post('/api/auth/challenge', { email: EMAIL_UNKNOWN });
      await post('/api/auth/challenge', { email: 'bad-shape' });

      // Đúng một mail đi ra — cho địa chỉ verified. Địa chỉ lạ và body sai: không mail.
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]?.url).toBe('https://mail.test/v1/messages');
      // Idempotency-Key bắt buộc của contract TM: phải có, ≤ 128 ký tự.
      const idem =
        mail.sent[0]?.headers['idempotency-key'] ?? mail.sent[0]?.headers['Idempotency-Key'];
      expect(typeof idem).toBe('string');
      expect((idem as string).length).toBeGreaterThan(0);
      expect((idem as string).length).toBeLessThanOrEqual(128);
    } finally {
      mail.restore();
    }

    // Nhưng bảng challenge có hàng cho CẢ địa chỉ lạ: rate-limit địa chỉ lạ như
    // địa chỉ thật — cơ chế chống dò địa chỉ.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ address_hash: string }>(
        `SELECT address_hash FROM account.otp_challenges`,
      );
      expect(rows).toHaveLength(2);
    } finally {
      await client.end();
    }
  });

  it('answers 204 identically for verified, unknown and rate-limited addresses', async () => {
    // Cùng response byte-for-byte: status, body rỗng, cache-control.
    const responses: Response[] = [];
    responses.push(await post('/api/auth/challenge', { email: EMAIL_MAIN }));

    const mail = installMailStub();
    try {
      // Lần 2 cho EMAIL_MAIN rơi vào resend cooldown — vẫn phải 204.
      responses.push(await post('/api/auth/challenge', { email: EMAIL_MAIN }));
      // Địa chỉ lạ — 204.
      responses.push(await post('/api/auth/challenge', { email: EMAIL_UNKNOWN }));
    } finally {
      mail.restore();
    }

    for (const response of responses) {
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('silently blocks a resend inside the 60s cooldown', async () => {
    await challenge(EMAIL_MAIN);
    // Lần resend: 204 nhưng không mail, và challenge active KHÔNG bị thay.
    const mail = installMailStub();
    try {
      const response = await post('/api/auth/challenge', { email: EMAIL_MAIN });
      expect(response.status).toBe(204);
      expect(mail.sent).toHaveLength(0);
    } finally {
      mail.restore();
    }

    // Vẫn đúng một challenge active, không có hàng mới.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ active_count: string; total: string }>(
        `SELECT count(*) FILTER (WHERE consumed_at IS NULL) AS active_count,
                count(*) AS total
           FROM account.otp_challenges`,
      );
      expect(Number(rows[0]?.active_count)).toBe(1);
      expect(Number(rows[0]?.total)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('rejects a wrong code, counts the attempt, and locks at the 5th failure', async () => {
    const code = await challenge(EMAIL_MAIN);
    const wrong = code === '00000000' ? '00000001' : '00000000';

    for (let attempt = 1; attempt <= 4; attempt++) {
      const response = await verify(EMAIL_MAIN, wrong);
      expect(response.status).toBe(400);
    }
    // 4 lần sai: attempts = 4, challenge còn active.
    const afterFour = await db.connect();
    try {
      const { rows } = await afterFour.query<{ attempts: number; active: string }>(
        `SELECT attempts,
                count(*) FILTER (WHERE consumed_at IS NULL) AS active
           FROM account.otp_challenges
          GROUP BY attempts`,
      );
      expect(rows[0]?.attempts).toBe(4);
      expect(Number(rows[0]?.active)).toBe(1);
    } finally {
      await afterFour.end();
    }

    // Lần thứ 5: sai nữa → khoá (consumed_at != NULL). Mã ĐÚNG cũng không còn.
    const fifthWrong = await verify(EMAIL_MAIN, wrong);
    expect(fifthWrong.status).toBe(400);
    const correctAfterLock = await verify(EMAIL_MAIN, code);
    expect(correctAfterLock.status).toBe(400);

    const afterLock = await db.connect();
    try {
      const { rows } = await afterLock.query<{ attempts: number; consumed: string }>(
        `SELECT attempts, count(consumed_at) AS consumed
           FROM account.otp_challenges
          GROUP BY attempts`,
      );
      expect(rows[0]?.attempts).toBe(5);
      expect(Number(rows[0]?.consumed)).toBe(1);
    } finally {
      await afterLock.end();
    }

    // Không session nào được phát hành trong toàn bộ chuỗi.
    const sessions = await db.connect();
    try {
      const { rows } = await sessions.query<{ count: string }>(
        `SELECT count(*) AS count FROM account.account_sessions`,
      );
      expect(Number(rows[0]?.count)).toBe(0);
    } finally {
      await sessions.end();
    }
  });

  it('rejects verify without a challenge (no_active_challenge)', async () => {
    const response = await verify(EMAIL_MAIN, '12345678');
    expect(response.status).toBe(400);
    // Body chung chung — không phân biệt lý do.
    await expect(response.text()).resolves.not.toContain('no_active');
  });

  it('fails closed when the account is suspended between challenge and verify', async () => {
    // Kịch bản: challenge cấp khi account còn active (mail gửi thật), rồi account
    // bị suspended TRƯỚC khi verify. Verify tra cứu lại trạng thái tại thời điểm
    // đó — mã đúng vẫn bị từ chối (FR-012).
    const client = await db.connect();
    try {
      await client.query(`UPDATE account.users SET status = 'active' WHERE sub = $1`, [
        SUB_SUSPENDED,
      ]);
    } finally {
      await client.end();
    }
    const activeCode = await challenge(EMAIL_SUSPENDED);

    // Suspend giữa challenge và verify.
    const suspend = await db.connect();
    try {
      await suspend.query(`UPDATE account.users SET status = 'suspended' WHERE sub = $1`, [
        SUB_SUSPENDED,
      ]);
    } finally {
      await suspend.end();
    }

    const response = await verify(EMAIL_SUSPENDED, activeCode);
    expect(response.status).toBe(400);

    // Challenge KHÔNG bị consume bởi lần verify bị chặn — nhưng điểm cần khẳng
    // định là không session nào được phát hành.
    const sessions = await db.connect();
    try {
      const { rows } = await sessions.query<{ count: string }>(
        `SELECT count(*) AS count FROM account.account_sessions`,
      );
      expect(Number(rows[0]?.count)).toBe(0);
    } finally {
      await sessions.end();
    }
  });

  it('does not send mail for a verified address whose account is suspended', async () => {
    // beforeEach seed EMAIL_SUSPENDED với account suspended: challenge trả 204
    // nhưng mail KHÔNG đi ra (resolveOtpTarget loại trước khi gửi).
    const mail = installMailStub();
    try {
      const response = await post('/api/auth/challenge', { email: EMAIL_SUSPENDED });
      expect(response.status).toBe(204);
      expect(mail.sent).toHaveLength(0);
    } finally {
      mail.restore();
    }
    // Challenge ma vẫn được ghi.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM account.otp_challenges`,
      );
      expect(Number(rows[0]?.count)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('consumes the challenge on success: the same code cannot mint two sessions', async () => {
    const code = await challenge(EMAIL_MAIN);

    const first = await verify(EMAIL_MAIN, code);
    expect(first.status).toBe(200);
    const second = await verify(EMAIL_MAIN, code);
    expect(second.status).toBe(400);

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

  it('rotates the session: re-auth revokes the previous session in the same write', async () => {
    // Session "cũ" của browser: verify lần 1.
    const firstCode = await challenge(EMAIL_MAIN);
    const first = await verify(EMAIL_MAIN, firstCode);
    expect(first.status).toBe(200);
    const firstCookie = cookieValue(setCookies(first), '__Host-account-session');
    expect(typeof firstCookie).toBe('string');

    // Resend bị cooldown — xoá cooldown bằng cách consume thủ công rồi challenge lại.
    const client = await db.connect();
    try {
      await client.query(
        `UPDATE account.otp_challenges SET consumed_at = now() WHERE consumed_at IS NULL`,
      );
    } finally {
      await client.end();
    }
    const secondCode = await challenge(EMAIL_MAIN);

    // Verify lần 2 MANG cookie cũ: rotation phải thu hồi session cũ.
    const second = await verify(EMAIL_MAIN, secondCode, `__Host-account-session=${firstCookie}`);
    expect(second.status).toBe(200);

    const check = await db.connect();
    try {
      const { rows } = await check.query<{ revoked_count: string; live_count: string }>(
        `SELECT count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked_count,
                count(*) FILTER (WHERE revoked_at IS NULL) AS live_count
           FROM account.account_sessions`,
      );
      expect(Number(rows[0]?.revoked_count)).toBe(1);
      expect(Number(rows[0]?.live_count)).toBe(1);
    } finally {
      await check.end();
    }

    // Cookie cũ không đọc được session nữa.
    const oldSession = await get('/api/auth/session', `__Host-account-session=${firstCookie}`);
    expect(oldSession.status).toBe(401);
  });

  it('revokes the session and clears cookies on logout', async () => {
    const code = await challenge(EMAIL_MAIN);
    const verifyResponse = await verify(EMAIL_MAIN, code);
    const cookies = setCookies(verifyResponse);
    const cookiePair = cookies
      .filter((cookie) => cookie.startsWith('__Host-'))
      .map((cookie) => cookie.split(';')[0])
      .join('; ');

    const logout = await post(
      '/api/auth/logout',
      {},
      {
        cookie: cookiePair,
        headers: {
          'x-ecoma-csrf': cookieValue(cookies, '__Host-account-csrf') as string,
        },
      },
    );
    expect(logout.status).toBe(204);

    // Cả hai cookie bị xoá (Max-Age=0).
    const cleared = setCookies(logout);
    const sessionClear = cleared.find((cookie) => cookie.startsWith('__Host-account-session=;'));
    const csrfClear = cleared.find((cookie) => cookie.startsWith('__Host-account-csrf=;'));
    expect(sessionClear).toContain('Max-Age=0');
    expect(csrfClear).toContain('Max-Age=0');

    // DB: session đã revoked.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ live: string }>(
        `SELECT count(*) FILTER (WHERE revoked_at IS NULL) AS live FROM account.account_sessions`,
      );
      expect(Number(rows[0]?.live)).toBe(0);
    } finally {
      await client.end();
    }

    // GET session sau logout → 401.
    const after = await get('/api/auth/session', cookiePair);
    expect(after.status).toBe(401);
  });

  it('rejects logout with a CSRF mismatch before touching the DB', async () => {
    const code = await challenge(EMAIL_MAIN);
    const verifyResponse = await verify(EMAIL_MAIN, code);
    const cookies = setCookies(verifyResponse);
    const cookiePair = cookies
      .filter((cookie) => cookie.startsWith('__Host-'))
      .map((cookie) => cookie.split(';')[0])
      .join('; ');

    const logout = await post(
      '/api/auth/logout',
      {},
      { cookie: cookiePair, headers: { 'x-ecoma-csrf': 'wrong-token-length-43-aaaaaaaaaaaaaaa' } },
    );
    expect(logout.status).toBe(403);

    // Session vẫn sống.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ live: string }>(
        `SELECT count(*) FILTER (WHERE revoked_at IS NULL) AS live FROM account.account_sessions`,
      );
      expect(Number(rows[0]?.live)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('logout without cookies is idempotent 204 with cleared cookies', async () => {
    const response = await post('/api/auth/logout', {});
    expect(response.status).toBe(204);
    const cleared = setCookies(response);
    expect(cleared.some((cookie) => cookie.startsWith('__Host-account-session=;'))).toBe(true);
    expect(cleared.some((cookie) => cookie.startsWith('__Host-account-csrf=;'))).toBe(true);
  });

  it('enforces the rate limit: the 4th challenge inside 15 minutes is silently suppressed', async () => {
    // 3 challenge đầu được cấp (limit ngắn = 3/15 phút). Xoá cooldown giữa các lần
    // bằng consume trực tiếp — rate limit ĐẾM TỪ bảng nên consume không xoá dấu vết.
    for (let i = 0; i < 3; i++) {
      const client = await db.connect();
      try {
        await client.query(
          `UPDATE account.otp_challenges SET consumed_at = now() WHERE consumed_at IS NULL`,
        );
      } finally {
        await client.end();
      }
      const mail = installMailStub();
      try {
        const response = await post('/api/auth/challenge', { email: EMAIL_MAIN });
        expect(response.status).toBe(204);
        expect(mail.sent).toHaveLength(1);
      } finally {
        mail.restore();
      }
    }

    // Lần thứ 4 trong cửa sổ: 204 im lặng — KHÔNG mail, KHÔNG hàng mới.
    const mail = installMailStub();
    try {
      const response = await post('/api/auth/challenge', { email: EMAIL_MAIN });
      expect(response.status).toBe(204);
      expect(mail.sent).toHaveLength(0);
    } finally {
      mail.restore();
    }

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM account.otp_challenges`,
      );
      expect(Number(rows[0]?.count)).toBe(3);
    } finally {
      await client.end();
    }
  });

  it('keeps the rate limit per address: another address is unaffected', async () => {
    // Địa chỉ lạ đốt hết limit ngắn của CHÍNH NÓ.
    for (let i = 0; i < 3; i++) {
      const client = await db.connect();
      try {
        await client.query(
          `UPDATE account.otp_challenges SET consumed_at = now() WHERE consumed_at IS NULL`,
        );
      } finally {
        await client.end();
      }
      await post('/api/auth/challenge', { email: EMAIL_UNKNOWN });
    }
    // EMAIL_MAIN vẫn cấp bình thường.
    const code = await challenge(EMAIL_MAIN);
    expect(code).toMatch(/^\d{8}$/u);
  });

  it('rejects a malformed body with 400 for both routes', async () => {
    const badChallenge = await post('/api/auth/challenge', { email: '' });
    expect(badChallenge.status).toBe(400);
    const badVerify = await post('/api/auth/verify', { email: EMAIL_MAIN, code: '12345' });
    expect(badVerify.status).toBe(400);
    const badVerifyCode = await post('/api/auth/verify', { email: EMAIL_MAIN, code: '1234567a' });
    expect(badVerifyCode.status).toBe(400);
  });

  it('fails closed with 503 when the OTP secret is missing from config', async () => {
    setRuntimeConfig({
      internalHmacSecret: 'test-internal-hmac-secret-0123456789abcdef',
      otpHmacSecret: '',
      cloudflare: { env: { DB_ACCOUNT: { connectionString } } },
    });
    const response = await post('/api/auth/challenge', { email: EMAIL_MAIN });
    expect(response.status).toBe(503);
    const verifyResponse = await post('/api/auth/verify', { email: EMAIL_MAIN, code: '12345678' });
    expect(verifyResponse.status).toBe(503);
  });

  it('still answers 204 when the mail service is unreachable (no enumeration signal)', async () => {
    // Mail chết không được đổi response: người dùng không nhận mail, kẻ dò không
    // học được gì. Route log `mail_failed` — check qua mocked writeLog.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    try {
      const response = await post('/api/auth/challenge', { email: EMAIL_MAIN });
      expect(response.status).toBe(204);
      expect(mockedWriteLog).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'otp_challenge.mail_failed' }),
      );
    } finally {
      globalThis.fetch = original;
    }

    // Challenge đã được ghi — mã verify được nếu mail được gửi lại (tình huống
    // thực tế: user yêu cầu resend sau 60s). Điểm quan trọng: 204 + log, không 5xx.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ active: string }>(
        `SELECT count(*) FILTER (WHERE consumed_at IS NULL) AS active FROM account.otp_challenges`,
      );
      expect(Number(rows[0]?.active)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('answers 204 for concurrent challenges racing the one-active constraint', async () => {
    // Hai request song song cùng tới insertChallenge: pre-check cooldown của route
    // nằm ngoài transaction nên không tuần tự hoá được gì — guard trong
    // transaction (`SELECT … FOR UPDATE` + isResendBlocked) mới là thứ đóng kẽ hở.
    // Cả hai kết cục bị chặn đều phải 204: người thắng nhận mail (0 hoặc 1 mail tuỳ
    // hai request có cùng thấy cooldown không bị chặn không), người thua im lặng;
    // không bao giờ 503 unique violation, và không bao giờ hai mail.
    const mail = installMailStub();
    try {
      const responses = await Promise.all([
        post('/api/auth/challenge', { email: EMAIL_MAIN }),
        post('/api/auth/challenge', { email: EMAIL_MAIN }),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
      }
      expect(mail.sent.length).toBeLessThanOrEqual(1);
    } finally {
      mail.restore();
    }
  });

  it('caps concurrent challenges for one address at the rolling-window limit', async () => {
    // OCR-3 (run 39571892639): phép đo rolling-window chỉ nằm ở pre-check route
    // (ngoài transaction) thì N request đồng thời cùng thấy còn dư allowance rồi
    // cùng ghi — trần 3/15 phút không giữ được. Test này neo điều ngược lại: N
    // request CÙNG LÚC cho một địa chỉ phải kết thúc với đúng `OTP_RATE_LIMIT_SHORT_MAX`
    // hàng trong cửa sổ ngắn (các request dư bị chặn bên trong transaction của
    // `insertChallenge`), mọi response vẫn 204 (anti-enumeration — nhánh bị chặn
    // không được phân biệt), và mail chỉ đi ra tối đa bằng số challenge thật.
    const mail = installMailStub();
    try {
      const CONCURRENCY = 8;
      const responses = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          post('/api/auth/challenge', { email: EMAIL_MAIN }),
        ),
      );

      for (const response of responses) {
        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');
      }
      expect(mail.sent.length).toBeLessThanOrEqual(OTP_RATE_LIMIT_SHORT_MAX);

      const pool = await db.createRuntimePool();
      try {
        const hash = (await import('node:crypto'))
          .createHash('sha256')
          .update(EMAIL_MAIN.trim().toLowerCase())
          .digest('hex');
        const shortCount = await countChallengesSince(
          pool,
          hash,
          OTP_RATE_LIMIT_SHORT_WINDOW_SECONDS,
        );
        // Trần cửa sổ ngắn được giữ nguyên dưới tải đồng thời — đây là điều OCR
        // chỉ ra đã để trượt trước khi fix. Kì vọng chỉ cận trên (≤ 3), không
        // equality (== 3): 8 request xuất phát qua `Promise.all` được tuần tự
        // hoá theo scheduling của Node — bao nhiêu trong chúng kịp tới
        // `insertChallenge` trước khi request thứ 4 thấy cửa sổ tràn là thứ
        // không kiểm soát được. Test này neo bất biến "không lọt qua trần";
        // equality sẽ là assert tuỳ nó độ trôi của scheduler. Test race cooldown
        // phía dưới cùng mẫu: sự kiện bất định thì assert bất biến, không assert
        // progress cụ thể.
        expect(shortCount).toBeLessThanOrEqual(OTP_RATE_LIMIT_SHORT_MAX);
      } finally {
        await pool.end();
      }
    } finally {
      mail.restore();
    }
  });

  it('rejects the second challenge in a cooldown race deterministically via the in-transaction guard', async () => {
    // Hồi quy cho kẽ hở race đo được trên CI (mail.sent == 2): pre-check cooldown
    // của route đọc ngoài transaction, nên T2 có thể vượt pre-check khi bảng còn
    // trống rồi consume chính hàng T1 vừa commit trong kẽ trước khi T2 tới
    // insertChallenge. Kịch bản T1-đã-commit-rồi chỉ tái hiện được nửa sau của race
    // qua route (T2 dừng ở pre-check cooldown trước khi chạm insert), nên nửa đó
    // được pin trực tiếp trên contract của insertChallenge: khi còn hàng active
    // trong cooldown, nó phải trả `null` (không consume hàng cũ — seen bằng
    // `consumed_at IS NULL` không đổi), KHÔNG insert hàng mới, KHÔNG ném 23505.
    // Kết hợp test song song phía trên (sự kiện không kiểm soát được) và test unit
    // khác, contract này đóng kín cả hai nửa của race.
    const mail = installMailStub();
    try {
      // T1 đi trọn luồng: commit + gửi đúng một mail.
      await post('/api/auth/challenge', { email: EMAIL_MAIN });
      expect(mail.sent).toHaveLength(1);

      const client = await db.connect();
      let activeId: string;
      try {
        const { rows } = await client.query<{ id: string; code_digest: string }>(
          `SELECT id, code_digest FROM account.otp_challenges WHERE consumed_at IS NULL`,
        );
        expect(rows).toHaveLength(1);
        const row = rows[0];
        if (row === undefined) {
          throw new Error('expected exactly one active challenge row');
        }
        activeId = row.id;
      } finally {
        await client.end();
      }

      // T2 gọi đúng đoạn code production gọi: insertChallenge trên hàng active còn
      // trong cooldown ⇒ `null`, hàng T1 nguyên vẹn, tổng số hàng không đổi.
      const pool = await db.createRuntimePool();
      try {
        const outcome = await insertChallenge(pool, {
          addressHash: await (
            await import('node:crypto')
          )
            .createHash('sha256')
            .update(EMAIL_MAIN.trim().toLowerCase())
            .digest('hex'),
          digest: 'a'.repeat(64),
          purpose: 'login',
          expiresAt: new Date(Date.now() + 600_000),
          resendCooldownSeconds: 60,
          // 1 hàng active (T1) < trần 3 — cả hai cửa sổ đều còn dư allowance, nên
          // guard rate-limit không kích hoạt: `null` của outcome này là của guard
          // cooldown, đúng contract cũ mà test neo.
          rateLimitShortWindowSeconds: 900,
          rateLimitHourWindowSeconds: 3600,
        });
        expect(outcome).toBeUndefined();
      } finally {
        await pool.end();
      }

      const after = await db.connect().then(async (c2) => {
        try {
          const { rows } = await c2.query<{ id: string }>(`SELECT id FROM account.otp_challenges`);
          return rows;
        } finally {
          await c2.end();
        }
      });
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(activeId);
    } finally {
      mail.restore();
    }
  });

  it('re-measures the rolling window after the row lock, so a waiter behind a consuming transaction gets null', async () => {
    // OCR-3 path (b) consume-slot-freed: T2 block trong `SELECT … FOR UPDATE`
    // khi T1 commit (consume X + INSERT Y) — phép đếm của T2 PHẢI chạy SAU khi
    // thoát block để thấy Y; nếu đếm chạy trước khoá (snapshot lấy trước khi T1
    // commit) T2 chỉ thấy cửa sổ còn dư allowance và insert thành công, tràn
    // trần. Kịch bản không đo được qua route (mỗi web handler call là tuần tự);
    // contract được neo trực tiếp: transaction "T1" trên một PoolClient giữ
    // khoá hàng active, còn `insertChallenge` của T2 chạy song song trên
    // connection khác.
    const pool = await db.createRuntimePool();
    const hash = (await import('node:crypto'))
      .createHash('sha256')
      .update(EMAIL_MAIN.trim().toLowerCase())
      .digest('hex');
    // Trạng thái trước race: R1 active, created 61s trước (CÒN trong cửa sổ
    // 15 phút, NGOÀI cooldown 60s) và R2 vừa consume (vẫn được đếm — rate limit
    // đếm tần suất cấp mã, kể cả hàng đã consume). Cửa sổ đang thấy 2/3 — còn
    // đúng 1 allowance.
    const holder = await pool.connect();
    try {
      await holder.query(
        `INSERT INTO account.otp_challenges (address_hash, code_digest, purpose, expires_at, created_at)
         VALUES ($1, $2, 'login', $3, now() - interval '61 seconds')`,
        [hash, 'b'.repeat(64), new Date(Date.now() + 600_000)],
      );
      await holder.query(
        `INSERT INTO account.otp_challenges (address_hash, code_digest, purpose, expires_at, consumed_at)
         VALUES ($1, $2, 'login', $3, now())`,
        [hash, 'b'.repeat(64), new Date(Date.now() + 600_000 - 61_000)],
      );

      // T1 giữ khoá hàng active của R1 (SELECT … FOR UPDATE, chưa commit) —
      // T2 sẽ block đúng tại statement đó của transaction.
      await holder.query('BEGIN');
      await holder.query(
        `SELECT id FROM account.otp_challenges
          WHERE address_hash = $1 AND purpose = 'login' AND consumed_at IS NULL
          FOR UPDATE`,
        [hash],
      );

      // T2 phát động — sẽ chờ khoá. Không await: nó chưa thể kết thúc.
      const waiter = insertChallenge(pool, {
        addressHash: hash,
        digest: 'd'.repeat(64),
        purpose: 'login',
        expiresAt: new Date(Date.now() + 600_000),
        resendCooldownSeconds: 60,
        rateLimitShortWindowSeconds: 900,
        rateLimitHourWindowSeconds: 3600,
      });
      // Barrier theo mẫu pg_sleep của repo: cho T2 thời gian vào block trước
      // khi T1 commit (nếu T2 chưa kịp vào block cũng không sao — mọi phối cảnh
      // đều phải qua cùng các assertion phía dưới).
      await holder.query(`SELECT pg_sleep(1)`);

      // T1 "commit": consume R1 (ngoài cooldown, 61s) + INSERT Y consume-ngay
      // (không lấy slot active — hợp lệ nhờ partial UNIQUE chỉ tính
      // consumed_at IS NULL; vẫn được đếm trong cửa sổ). Sau commit, cửa sổ có
      // R1 + R2 + Y = 3 = trần.
      await holder.query(
        `UPDATE account.otp_challenges
            SET consumed_at = now()
          WHERE address_hash = $1 AND purpose = 'login' AND consumed_at IS NULL`,
        [hash],
      );
      await holder.query(
        `INSERT INTO account.otp_challenges (address_hash, code_digest, purpose, expires_at, consumed_at)
         VALUES ($1, $2, 'login', $3, now())`,
        [hash, 'e'.repeat(64), new Date(Date.now() + 600_000)],
      );
      await holder.query('COMMIT');

      // T2 thoát block. Cooldown check trượt qua (không còn hàng active), rồi
      // đếm — chạy SAU khoá nên thấy đủ 3 hàng ⇒ trần ⇒ `null`. Với thứ tự ĐẢO
      // (đếm trước khoá), T2 thấy 2 hàng (≤3) và INSERT thành công ⇒ tổng 4
      // hàng — sai OCR-3. Hai assert dưới phân biệt hai thứ tự:
      expect(await waiter).toBeUndefined();
      const after = await db.connect().then(async (c2) => {
        try {
          const { rows } = await c2.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM account.otp_challenges`,
          );
          return rows;
        } finally {
          await c2.end();
        }
      });
      expect(Number(after[0]?.count)).toBe(3);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await pool.end();
    }
  });

  it('never logs the email address or the code', async () => {
    // SR-001: log không chứa địa chỉ email lẫn mã OTP. Mọi dòng log của cả luồng
    // được quét: không email trần, không mã 8 chữ số.
    const code = await challenge(EMAIL_MAIN);
    await verify(EMAIL_MAIN, code === '12345678' ? '00000000' : '12345678');
    await post('/api/auth/logout', {});

    const logged = JSON.stringify(mockedWriteLog.mock.calls.map(([entry]) => entry));
    expect(logged).not.toContain(EMAIL_MAIN);
    expect(logged).not.toContain(EMAIL_UNKNOWN);
    expect(logged).not.toContain(code);
  });
});
