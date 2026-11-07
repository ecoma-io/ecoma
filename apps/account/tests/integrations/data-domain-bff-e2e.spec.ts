/**
 * Data domain v1 BFF routes — route thật, session thật, DB thật, mail giả.
 *
 * ## Phạm vi của suite này
 *
 * Năm nhóm route mới của PR2 (#274): `GET/PATCH /api/profile`,
 * `GET/PATCH /api/preferences`, `GET/POST /api/emails`,
 * `POST /api/emails/:id/verify|resend`, `DELETE /api/emails/:id`,
 * `GET /api/sessions`, `DELETE /api/sessions/:id`. Session được cấp qua
 * **challenge → verify thật** (mail stub ở mức global) — cookie/CSRF là sản
 * phẩm thật của vault verify, không phải fixture tự dựng.
 *
 * Những gì unit test không thấy được và chỉ suite này chứng minh:
 *
 * - persistence thật của các hàm `data-domain`/`email-verification` trên
 *   PostgreSQL (UPsert, partial update COALESCE, CHECK của 0008/0009,
 *   transaction tuần tự hoá của challenge),
 * - guard đúng trên từng route (401 không cookie, 403 CSRF mismatch, 404
 *   not-owned),
 * - anti-enumeration qua response: add/verify/resend trả 200 cho mọi nhánh
 *   nghiệp vụ, DELETE email chặn thu hồi verified cuối cùng bằng 400,
 * - audit: mọi state change thành công để lại đúng một hàng `security_events`,
 * - SR-006: `session_ref` không bao giờ xuất hiện trong body của
 *   `/api/sessions` và DELETE session hoạt động qua digest công khai.
 */

import { createHash } from 'node:crypto';

import { createApp, createRouter, toWebHandler, type WebHandler } from 'h3';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import challengeRoute from '../../server/api/auth/challenge.post';
import verifyRoute from '../../server/api/auth/verify.post';
import profileGetRoute from '../../server/api/profile.get';
import profilePatchRoute from '../../server/api/profile.patch';
import preferencesGetRoute from '../../server/api/preferences.get';
import preferencesPatchRoute from '../../server/api/preferences.patch';
import emailsGetRoute from '../../server/api/emails/index.get';
import emailsPostRoute from '../../server/api/emails/index.post';
import emailVerifyRoute from '../../server/api/emails/[id]/verify.post';
import emailResendRoute from '../../server/api/emails/[id]/resend.post';
import emailDeleteRoute from '../../server/api/emails/[id]/index.delete';
import sessionsGetRoute from '../../server/api/sessions/index.get';
import sessionDeleteRoute from '../../server/api/sessions/[id].delete';

import { ACCOUNT_DATABASE, type AccountDatabase, startAccountDatabase } from './harness.ts';
import { installRuntimeConfigStub, type AccountTestRuntimeConfig } from './nuxt-globals.ts';

vi.mock('../../server/utils/logger', () => ({
  writeLog: vi.fn<(entry: Record<string, unknown>) => void>(),
}));

const OTP_SECRET = 'test-otp-hmac-secret-0123456789abcdef';
const MAIL_SECRET = 'test-mail-internal-auth-secret-placeholder-0001';

const SUB_MAIN = 'sub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SUB_OTHER = 'sub_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const EMAIL_MAIN = 'user@example.com';
const EMAIL_OTHER = 'someoneelse@example.com';

/** SHA-256 hex của địa chỉ đã normalize — khớp cách app hash địa chỉ. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fullRuntimeConfig(connectionString: string): AccountTestRuntimeConfig {
  return {
    internalHmacSecret: 'test-internal-hmac-secret-0123456789abcdef',
    otpHmacSecret: OTP_SECRET,
    mailServiceUrl: 'https://mail.test',
    mailInternalAuthSecret: MAIL_SECRET,
    cloudflare: {
      env: {
        DB_ACCOUNT: { connectionString },
      },
    },
  };
}

/** Mail stub toàn cục — bắt mọi `fetch` đi tới transactional-mail. */
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

function cookieValue(cookies: string[], name: string): string | undefined {
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (found === undefined) {
    return undefined;
  }
  return found.slice(name.length + 1).split(';')[0];
}

function authCookieHeader(cookies: { sessionCookie: string; csrfCookie: string }): string {
  return `__Host-account-session=${cookies.sessionCookie}; __Host-account-csrf=${cookies.csrfCookie}`;
}

/** Đọc địa chỉ email thật từ mail stub (dạng trần, normalize sẵn phía route). */
function mailRecipient(entry: { body: Record<string, unknown> }): string {
  return String(entry.body['recipient'] ?? '');
}

/** Body tối thiểu cho từng method — route đọc body trước guard 401/403. */
function bodyFor(method: 'GET' | 'POST' | 'PATCH' | 'DELETE'): unknown {
  if (method === 'PATCH') {
    return { displayName: 'X' };
  }
  if (method === 'POST') {
    return { email: 'probe@example.com' };
  }
  return undefined;
}

describe('data domain v1 BFF routes end-to-end', () => {
  let db: AccountDatabase;
  let handler: WebHandler;
  let setRuntimeConfig: ReturnType<typeof installRuntimeConfigStub>;
  let connectionString: string;

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    init: { body?: unknown; headers?: Record<string, string>; cookie?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (init.cookie !== undefined) {
      headers['cookie'] = init.cookie;
    }
    // GET không được mang body (unicorn/no-invalid-fetch-options), nên request
    // option được dựng có điều kiện thay vì truyền `body: undefined` cố định.
    const options: { method: string; headers: Record<string, string>; body?: string } = {
      method,
      headers,
    };
    if (init.body !== undefined) {
      options.body = JSON.stringify(init.body);
    }
    return handler(new Request(`http://localhost${path}`, options));
  }

  async function authed(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    cookies: { sessionCookie: string; csrfCookie: string },
    body?: unknown,
  ): Promise<Response> {
    return request(method, path, {
      body,
      cookie: authCookieHeader(cookies),
      headers: { 'x-ecoma-csrf': cookies.csrfCookie },
    });
  }

  /** Challenge → verify: cấp cookie thật từ verify — đúng luồng production. */
  async function loginAndGetCookies(): Promise<{
    sessionCookie: string;
    csrfCookie: string;
  }> {
    const mail = installMailStub();
    let code: string;
    let challengeCookies: string[] = [];
    try {
      const challengeResponse = await request('POST', '/api/auth/challenge', {
        body: { email: EMAIL_MAIN, handle: 'handle-data-domain-test' },
      });
      expect(challengeResponse.status).toBe(204);
      expect(mail.sent).toHaveLength(1);
      const variables = mail.sent[0]?.body['variables'] as { code?: string } | undefined;
      code = variables?.code as string;
      challengeCookies = challengeResponse.headers.getSetCookie();
    } finally {
      mail.restore();
    }
    const challengeSessionCookie = cookieValue(challengeCookies, '__Host-account-session');
    const verifyResponse = await request('POST', '/api/auth/verify', {
      body: { email: EMAIL_MAIN, code },
      cookie:
        challengeSessionCookie === undefined
          ? undefined
          : `__Host-account-session=${challengeSessionCookie}`,
    });
    expect(verifyResponse.status).toBe(200);
    const cookies = verifyResponse.headers.getSetCookie();
    const sessionCookie = cookieValue(cookies, '__Host-account-session');
    const csrfCookie = cookieValue(cookies, '__Host-account-csrf');
    expect(typeof sessionCookie).toBe('string');
    expect(typeof csrfCookie).toBe('string');
    return { sessionCookie: sessionCookie as string, csrfCookie: csrfCookie as string };
  }

  /** Đếm hàng audit của một (sub, type) — helper của các test audit. */
  async function countAuditEvents(sub: string, type: string): Promise<number> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM account.security_events WHERE subject_sub = $1 AND type = $2`,
        [sub, type],
      );
      return Number(rows[0]?.n ?? '0');
    } finally {
      await client.end();
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
    router.get('/api/profile', profileGetRoute);
    router.patch('/api/profile', profilePatchRoute);
    router.get('/api/preferences', preferencesGetRoute);
    router.patch('/api/preferences', preferencesPatchRoute);
    router.get('/api/emails', emailsGetRoute);
    router.post('/api/emails', emailsPostRoute);
    router.post('/api/emails/:id/verify', emailVerifyRoute);
    router.post('/api/emails/:id/resend', emailResendRoute);
    router.delete('/api/emails/:id', emailDeleteRoute);
    router.get('/api/sessions', sessionsGetRoute);
    router.delete('/api/sessions/:id', sessionDeleteRoute);
    app.use(router.handler);
    handler = toWebHandler(app);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    setRuntimeConfig(fullRuntimeConfig(connectionString));
    await db.truncateData();
    const client = await db.connect();
    try {
      await client.query(
        `INSERT INTO account.users (sub) VALUES ($1), ($2) ON CONFLICT DO NOTHING`,
        [SUB_MAIN, SUB_OTHER],
      );
      // Hai verified: MAIN dùng để đăng nhập; OTHER dùng cho nhánh not-owned.
      await client.query(
        `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status, is_sign_in, verified_at)
         VALUES ($1, $2, $3, 'verified', true, now()),
                ($4, $5, $6, 'verified', true, now())`,
        [SUB_MAIN, EMAIL_MAIN, sha256(EMAIL_MAIN), SUB_OTHER, EMAIL_OTHER, sha256(EMAIL_OTHER)],
      );
    } finally {
      await client.end();
    }
  });

  // ── guard chung ─────────────────────────────────────────────────────────────

  it('rejects every new route without a session (401) and with a CSRF mismatch (403)', async () => {
    const cookies = await loginAndGetCookies();

    for (const [method, path] of [
      ['GET', '/api/profile'],
      ['PATCH', '/api/profile'],
      ['GET', '/api/preferences'],
      ['PATCH', '/api/preferences'],
      ['GET', '/api/emails'],
      ['POST', '/api/emails'],
      ['GET', '/api/sessions'],
    ] as const) {
      // vitest(valid-expect) cấm đối số message thứ hai — assert qua boolean
      // để method + path vẫn hiện trong thông báo lỗi của assertion.
      const anonymous = await request(method, path, { body: bodyFor(method) });
      expect(anonymous.status === 401, `${method} ${path} without cookie`).toBe(true);

      const mismatch = await request(method, path, {
        body: bodyFor(method),
        cookie: authCookieHeader(cookies),
        headers: { 'x-ecoma-csrf': 'wrong-token' },
      });
      expect(mismatch.status === 403, `${method} ${path} with wrong CSRF`).toBe(true);
    }
  });

  it('never trusts a client-supplied sub (SR-009) on profile and preferences PATCH', async () => {
    const cookies = await loginAndGetCookies();

    const profileResponse = await authed('PATCH', '/api/profile', cookies, {
      sub: SUB_OTHER,
      displayName: 'Impostor',
    });
    expect(profileResponse.status).toBe(200);

    const preferencesResponse = await authed('PATCH', '/api/preferences', cookies, {
      sub: SUB_OTHER,
      locale: 'vi',
    });
    expect(preferencesResponse.status).toBe(200);

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ user_sub: string }>(
        `SELECT user_sub FROM account.user_profiles`,
      );
      expect(rows.map((row) => row.user_sub)).toEqual([SUB_MAIN]);
      const prefs = await client.query<{ user_sub: string }>(
        `SELECT user_sub FROM account.user_preferences`,
      );
      expect(prefs.rows.map((row) => row.user_sub)).toEqual([SUB_MAIN]);
    } finally {
      await client.end();
    }
  });

  // ── profile ─────────────────────────────────────────────────────────────────

  it('profile GET returns null before the first PATCH and the stored row after it', async () => {
    const cookies = await loginAndGetCookies();

    const empty = await authed('GET', '/api/profile', cookies);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ profile: null });

    const patch = await authed('PATCH', '/api/profile', cookies, {
      displayName: '  John Bear  ',
      avatarUrl: 'https://cdn.example.com/a.png',
    });
    expect(patch.status).toBe(200);

    const after = await authed('GET', '/api/profile', cookies);
    const body = (await after.json()) as {
      profile: { displayName: string; avatarUrl: string } | null;
    };
    // PATCH trim display name trước khi lưu.
    expect(body.profile).toEqual({
      displayName: 'John Bear',
      avatarUrl: 'https://cdn.example.com/a.png',
    });
    expect(await countAuditEvents(SUB_MAIN, 'data_profile_updated')).toBe(1);
  });

  it('profile PATCH rejects a non-https avatar URL and an over-long display name (400)', async () => {
    const cookies = await loginAndGetCookies();

    const httpAvatar = await authed('PATCH', '/api/profile', cookies, {
      avatarUrl: 'http://cdn.example.com/a.png',
    });
    expect(httpAvatar.status).toBe(400);

    const longName = await authed('PATCH', '/api/profile', cookies, {
      displayName: 'x'.repeat(201),
    });
    expect(longName.status).toBe(400);

    expect(await countAuditEvents(SUB_MAIN, 'data_profile_updated')).toBe(0);
  });

  it('profile PATCH keeps the stored value when a field is absent (partial upsert)', async () => {
    const cookies = await loginAndGetCookies();

    await authed('PATCH', '/api/profile', cookies, {
      displayName: 'First',
      avatarUrl: 'https://cdn.example.com/1.png',
    });
    await authed('PATCH', '/api/profile', cookies, { displayName: 'Second' });

    const after = await authed('GET', '/api/profile', cookies);
    const body = (await after.json()) as {
      profile: { displayName: string; avatarUrl: string | null };
    };
    expect(body.profile?.displayName).toBe('Second');
    expect(body.profile?.avatarUrl).toBe('https://cdn.example.com/1.png');
  });

  // ── preferences ─────────────────────────────────────────────────────────────

  it('preferences GET returns null for a fresh user, first PATCH requires locale, later PATCH updates partially', async () => {
    const cookies = await loginAndGetCookies();

    // Trạng thái "chưa cấu hình": preferences null — không default hoá im lặng
    // (FR-008a); default chỉ áp trên đường ghi.
    const empty = await authed('GET', '/api/preferences', cookies);
    const initial = (await empty.json()) as {
      preferences: { locale: string; timezone: string; colorMode: string } | null;
    };
    expect(initial.preferences).toBeNull();

    // PATCH đầu thiếu locale → 400 locale_required (quyết định v1).
    const noLocale = await authed('PATCH', '/api/preferences', cookies, { colorMode: 'dark' });
    expect(noLocale.status).toBe(400);

    const patch = await authed('PATCH', '/api/preferences', cookies, {
      locale: 'vi',
      colorMode: 'dark',
    });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as {
      preferences: { locale: string; timezone: string; colorMode: string };
    };
    // FR-008e: các trường không gửi lấy DB default lúc tạo (timezone); locale
    // là giá trị caller chọn, không phải fallback.
    expect(patchBody.preferences).toEqual({
      locale: 'vi',
      timezone: 'Asia/Ho_Chi_Minh',
      colorMode: 'dark',
    });
    expect(await countAuditEvents(SUB_MAIN, 'data_preferences_updated')).toBe(1);

    // PATCH sau: thiếu locale giữ giá trị cũ (partial update thật).
    const second = await authed('PATCH', '/api/preferences', cookies, { colorMode: 'light' });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      preferences: { locale: string; colorMode: string };
    };
    expect(secondBody.preferences.locale).toBe('vi');
    expect(secondBody.preferences.colorMode).toBe('light');
    expect(await countAuditEvents(SUB_MAIN, 'data_preferences_updated')).toBe(2);
  });

  it('preferences PATCH rejects a non-allowlisted locale, a fake timezone and a bad color mode with 400 (FR-008a)', async () => {
    const cookies = await loginAndGetCookies();

    for (const body of [
      { locale: 'fr' },
      { locale: 'VI' },
      { timezone: 'Mars/Phobos' },
      { colorMode: 'blue' },
      { sub: SUB_OTHER, locale: 'fr' },
    ]) {
      const response = await authed('PATCH', '/api/preferences', cookies, body);
      // vitest(valid-expect) cấm đối số message thứ hai của expect — khi case
      // nào đỏ, stack trace trỏ thẳng vào phần tử của mảng trên.
      expect(response.status).toBe(400);
    }
    expect(await countAuditEvents(SUB_MAIN, 'data_preferences_updated')).toBe(0);
  });

  it('preferences PATCH accepts an IANA alias timezone and any allowlisted combination', async () => {
    const cookies = await loginAndGetCookies();

    const response = await authed('PATCH', '/api/preferences', cookies, {
      locale: 'en',
      timezone: 'Europe/Berlin',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { preferences: { timezone: string } };
    expect(body.preferences.timezone).toBe('Europe/Berlin');
  });

  // ── emails: list + add ──────────────────────────────────────────────────────

  it('emails GET lists the caller addresses masked, other accounts excluded', async () => {
    const cookies = await loginAndGetCookies();

    const response = await authed('GET', '/api/emails', cookies);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      emails: Array<{ address: string; status: string; isSignIn: boolean }>;
    };
    expect(body.emails).toHaveLength(1);
    expect(body.emails[0]?.address).toBe('u***@example.com');
    expect(body.emails[0]?.status).toBe('verified');
    expect(body.emails[0]?.isSignIn).toBe(true);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(EMAIL_MAIN);
  });

  it('email add creates a pending row, sends one code, and audits exactly once', async () => {
    const cookies = await loginAndGetCookies();
    const mail = installMailStub();
    const added = 'new.address@example.com';
    let response: Response;
    try {
      response = await authed('POST', '/api/emails', cookies, { email: added });
    } finally {
      mail.restore();
    }
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; email: { status: string } | null };
    expect(body.ok).toBe(true);
    expect(body.email?.status).toBe('pending');
    expect(mail.sent).toHaveLength(1);
    expect(mailRecipient(mail.sent[0] as { body: Record<string, unknown> })).toBe(added);

    const list = await authed('GET', '/api/emails', cookies);
    const listBody = (await list.json()) as { emails: Array<{ status: string }> };
    // created_at DESC: hàng mới nhất (pending vừa thêm) đứng trước.
    expect(listBody.emails.map((row) => row.status)).toEqual(['pending', 'verified']);
    expect(await countAuditEvents(SUB_MAIN, 'data_email_added')).toBe(1);
  });

  it('email add for an already-owned address is idempotent: no second row, no mail', async () => {
    const cookies = await loginAndGetCookies();
    const mail = installMailStub();
    let response: Response;
    try {
      response = await authed('POST', '/api/emails', cookies, { email: EMAIL_MAIN });
    } finally {
      mail.restore();
    }
    expect(response.status).toBe(200);
    expect(mail.sent).toHaveLength(0);
    const list = await authed('GET', '/api/emails', cookies);
    const listBody = (await list.json()) as { emails: unknown[] };
    expect(listBody.emails).toHaveLength(1);
    expect(await countAuditEvents(SUB_MAIN, 'data_email_added')).toBe(0);
  });

  it('email add for an address verified by ANOTHER account stays silent: 200, no row, no mail (anti-enumeration)', async () => {
    const cookies = await loginAndGetCookies();
    const mail = installMailStub();
    let response: Response;
    try {
      response = await authed('POST', '/api/emails', cookies, { email: EMAIL_OTHER });
    } finally {
      mail.restore();
    }
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; email: unknown };
    expect(body.ok).toBe(true);
    expect(body.email).toBeNull();
    expect(mail.sent).toHaveLength(0);

    const list = await authed('GET', '/api/emails', cookies);
    const listBody = (await list.json()) as { emails: unknown[] };
    expect(listBody.emails).toHaveLength(1);

    const client = await db.connect();
    try {
      const { rows } = await client.query<{ user_sub: string }>(
        `SELECT user_sub FROM account.email_addresses WHERE address_hash = $1`,
        [sha256(EMAIL_OTHER)],
      );
      expect(rows.map((row) => row.user_sub)).toEqual([SUB_OTHER]);
    } finally {
      await client.end();
    }
  });

  it('email add rejects a malformed address with 400 and sends nothing', async () => {
    const cookies = await loginAndGetCookies();
    const mail = installMailStub();
    let response: Response;
    try {
      response = await authed('POST', '/api/emails', cookies, { email: 'not-an-email' });
    } finally {
      mail.restore();
    }
    expect(response.status).toBe(400);
    expect(mail.sent).toHaveLength(0);
  });

  // ── emails: verify + resend ─────────────────────────────────────────────────

  /** Thêm một email pending qua route thật, trả về (mail stub vẫn mở). */
  async function addPendingEmail(
    cookies: { sessionCookie: string; csrfCookie: string },
    address: string,
  ): Promise<string> {
    const mail = installMailStub();
    let code: string;
    try {
      const response = await authed('POST', '/api/emails', cookies, { email: address });
      expect(response.status).toBe(200);
      expect(mail.sent).toHaveLength(1);
      const variables = mail.sent[0]?.body['variables'] as { code?: string } | undefined;
      code = variables?.code as string;
    } finally {
      mail.restore();
    }
    expect(typeof code).toBe('string');
    return code;
  }

  async function findEmailIdByHash(hash: string): Promise<string> {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM account.email_addresses WHERE address_hash = $1`,
        [hash],
      );
      expect(rows).toHaveLength(1);
      return rows[0] !== undefined ? rows[0].id : '';
    } finally {
      await client.end();
    }
  }

  it('email verify marks the address verified with the right code and audits once', async () => {
    const cookies = await loginAndGetCookies();
    const added = 'verify.me@example.com';
    const code = await addPendingEmail(cookies, added);
    const emailId = await findEmailIdByHash(sha256(added));

    const response = await authed('POST', `/api/emails/${emailId}/verify`, cookies, { code });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; email: { status: string } };
    expect(body.email.status).toBe('verified');
    expect(await countAuditEvents(SUB_MAIN, 'data_email_verified')).toBe(1);

    const list = await authed('GET', '/api/emails', cookies);
    const listBody = (await list.json()) as { emails: Array<{ address: string; status: string }> };
    // maskEmail: ký tự đầu + một `*` cho mỗi ký tự còn lại của local-part.
    expect(listBody.emails.find((row) => row.address === 'v********@example.com')?.status).toBe(
      'verified',
    );
  });

  it('email verify with a wrong code is a generic 400 and locks at the 5th failure', async () => {
    const cookies = await loginAndGetCookies();
    const added = 'lockout@example.com';
    const rightCode = await addPendingEmail(cookies, added);
    const emailId = await findEmailIdByHash(sha256(added));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await authed('POST', `/api/emails/${emailId}/verify`, cookies, {
        code: '00000000',
      });
      expect(response.status === 400, `attempt ${attempt}`).toBe(true);
    }
    // Trần 5 lần thử đã khoá challenge: kể cả mã đúng cũng không verify được —
    // challenge bị consume nguyên tử ở lần thử thứ 5 (attempts + 1 >= 5).
    const locked = await authed('POST', `/api/emails/${emailId}/verify`, cookies, {
      code: rightCode,
    });
    expect(locked.status).toBe(400);
    expect(await countAuditEvents(SUB_MAIN, 'data_email_verified')).toBe(0);
  });

  it('email verify rejects a code from the login flow (digest domain separation)', async () => {
    const cookies = await loginAndGetCookies();
    // Code của luồng login cho cùng địa chỉ KHÔNG verify được email.
    const mail = installMailStub();
    let loginCode: string;
    try {
      const challengeResponse = await request('POST', '/api/auth/challenge', {
        body: { email: 'cross.purpose@example.com', handle: 'handle-cross-purpose' },
      });
      expect(challengeResponse.status).toBe(204);
      const variables = mail.sent[0]?.body['variables'] as { code?: string } | undefined;
      loginCode = variables?.code as string;
    } finally {
      mail.restore();
    }

    const mailAdd = installMailStub();
    let added = '';
    try {
      const response = await authed('POST', '/api/emails', cookies, {
        email: 'cross.purpose@example.com',
      });
      expect(response.status).toBe(200);
      const variables = mailAdd.sent[0]?.body['variables'] as { code?: string } | undefined;
      added = variables?.code as string;
    } finally {
      mailAdd.restore();
    }
    void added;

    const emailId = await findEmailIdByHash(sha256('cross.purpose@example.com'));
    const wrongPurpose = await authed('POST', `/api/emails/${emailId}/verify`, cookies, {
      code: loginCode,
    });
    expect(wrongPurpose.status).toBe(400);
  });

  it('email verify on a not-owned id is 404 and reveals nothing', async () => {
    const cookies = await loginAndGetCookies();
    const otherEmailId = await findEmailIdByHash(sha256(EMAIL_OTHER));
    const response = await authed('POST', `/api/emails/${otherEmailId}/verify`, cookies, {
      code: '12345678',
    });
    expect(response.status).toBe(404);
  });

  it('email resend sends a fresh code after the cooldown and audits data_email_resend_sent', async () => {
    const cookies = await loginAndGetCookies();
    const added = 'resend.me@example.com';
    await addPendingEmail(cookies, added);
    const emailId = await findEmailIdByHash(sha256(added));

    // Ngay sau khi cấp mã, resend nằm trong cooldown 60s — im lặng, không mail.
    const immediateMail = installMailStub();
    try {
      const immediate = await authed('POST', `/api/emails/${emailId}/resend`, cookies);
      expect(immediate.status).toBe(200);
      expect(immediateMail.sent).toHaveLength(0);
    } finally {
      immediateMail.restore();
    }

    // Trôi cooldown: challenge mới được cấp, mail thứ hai đi ra.
    const client = await db.connect();
    try {
      await client.query(
        `UPDATE account.otp_challenges
            SET created_at = created_at - interval '61 seconds'
          WHERE purpose = 'verify_email'`,
      );
    } finally {
      await client.end();
    }
    const laterMail = installMailStub();
    try {
      const later = await authed('POST', `/api/emails/${emailId}/resend`, cookies);
      expect(later.status).toBe(200);
      expect(laterMail.sent).toHaveLength(1);
      expect(mailRecipient(laterMail.sent[0] as { body: Record<string, unknown> })).toBe(added);
    } finally {
      laterMail.restore();
    }
    expect(await countAuditEvents(SUB_MAIN, 'data_email_resend_sent')).toBe(1);
  });

  it('email resend on a not-owned id is 404 with no mail', async () => {
    const cookies = await loginAndGetCookies();
    const otherEmailId = await findEmailIdByHash(sha256(EMAIL_OTHER));
    const mail = installMailStub();
    let response: Response;
    try {
      response = await authed('POST', `/api/emails/${otherEmailId}/resend`, cookies);
    } finally {
      mail.restore();
    }
    expect(response.status).toBe(404);
    expect(mail.sent).toHaveLength(0);
  });

  // ── emails: delete ──────────────────────────────────────────────────────────

  it('email delete refuses to revoke the last verified address with 400 and no audit', async () => {
    const cookies = await loginAndGetCookies();
    const mainEmailId = await findEmailIdByHash(sha256(EMAIL_MAIN));

    const response = await authed('DELETE', `/api/emails/${mainEmailId}`, cookies);
    expect(response.status).toBe(400);
    // Lý do nằm trong error payload của h3 (statusMessage), không phải JSON body
    // tự dựng — khớp quy ước createError của các route còn lại.
    const bodyText = await response.text();
    expect(bodyText).toContain('last_verified_email');
    expect(await countAuditEvents(SUB_MAIN, 'data_email_revoked')).toBe(0);
  });

  it('concurrent deletes of two verified addresses leave exactly one verified (FR-002 race)', async () => {
    const cookies = await loginAndGetCookies();
    // Thêm + verify một địa chỉ thứ hai: caller có ĐÚNG HAI verified.
    const added = 'race@example.com';
    const code = await addPendingEmail(cookies, added);
    const secondId = await findEmailIdByHash(sha256(added));
    const verifiedResponse = await authed('POST', `/api/emails/${secondId}/verify`, cookies, {
      code,
    });
    expect(verifiedResponse.status).toBe(200);

    const mainEmailId = await findEmailIdByHash(sha256(EMAIL_MAIN));
    // Hai DELETE song song trên hai địa chỉ verified khác nhau: guard FR-002
    // nguyên tử (FOR UPDATE trong transaction của revokeEmailGuarded) bắt buộc
    // đúng một request thắng — count-then-act cho cả hai vượt guard và hạ
    // caller xuống 0 verified.
    const [first, second] = await Promise.all([
      authed('DELETE', `/api/emails/${mainEmailId}`, cookies),
      authed('DELETE', `/api/emails/${secondId}`, cookies),
    ]);
    const statuses = [first.status, second.status].toSorted();
    expect(statuses).toEqual([204, 400]);

    const list = await authed('GET', '/api/emails', cookies);
    const listBody = (await list.json()) as { emails: Array<{ status: string }> };
    expect(listBody.emails.filter((row) => row.status === 'verified')).toHaveLength(1);
    expect(await countAuditEvents(SUB_MAIN, 'data_email_revoked')).toBe(1);
  });

  it('email delete revokes a pending address, keeps cookies working, and audits once', async () => {
    const cookies = await loginAndGetCookies();
    const added = 'delete.me@example.com';
    await addPendingEmail(cookies, added);
    const emailId = await findEmailIdByHash(sha256(added));

    const response = await authed('DELETE', `/api/emails/${emailId}`, cookies);
    expect(response.status).toBe(204);

    const list = await authed('GET', '/api/emails', cookies);
    const listBody = (await list.json()) as { emails: Array<{ status: string }> };
    // created_at DESC: hàng pending vừa bị revoke đứng trước hàng verified.
    expect(listBody.emails.map((row) => row.status)).toEqual(['revoked', 'verified']);
    expect(await countAuditEvents(SUB_MAIN, 'data_email_revoked')).toBe(1);

    // DELETE lại lần nữa — idempotent 204, không audit thứ hai.
    const again = await authed('DELETE', `/api/emails/${emailId}`, cookies);
    expect(again.status).toBe(204);
    expect(await countAuditEvents(SUB_MAIN, 'data_email_revoked')).toBe(1);
  });

  it('email delete on a not-owned id is 404', async () => {
    const cookies = await loginAndGetCookies();
    const otherEmailId = await findEmailIdByHash(sha256(EMAIL_OTHER));
    const response = await authed('DELETE', `/api/emails/${otherEmailId}`, cookies);
    expect(response.status).toBe(404);
  });

  // ── sessions ────────────────────────────────────────────────────────────────

  it('sessions GET lists only live sessions with a public id and never the session_ref', async () => {
    const first = await loginAndGetCookies();
    const second = await loginAndGetCookies();

    const response = await authed('GET', '/api/sessions', second);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<{
        id: string;
        createdAt: string;
        lastSeenAt: string;
        expiresAt: string;
        isCurrent: boolean;
      }>;
    };
    expect(body.sessions).toHaveLength(2);
    const current = body.sessions.filter((row) => row.isCurrent);
    expect(current).toHaveLength(1);
    for (const row of body.sessions) {
      expect(row.id).toMatch(/^[0-9a-f]{64}$/u);
    }
    const serialized = JSON.stringify(body);
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ session_ref: string }>(
        `SELECT session_ref FROM account.account_sessions WHERE revoked_at IS NULL`,
      );
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(serialized).not.toContain(row.session_ref);
      }
    } finally {
      await client.end();
    }
    void first;
  });

  it('session DELETE revokes another session; both cookies survive on the current one', async () => {
    const first = await loginAndGetCookies();
    const second = await loginAndGetCookies();

    const listResponse = await authed('GET', '/api/sessions', first);
    const listBody = (await listResponse.json()) as {
      sessions: Array<{ id: string; isCurrent: boolean }>;
    };
    const other = listBody.sessions.find((row) => !row.isCurrent);
    expect(other).toBeDefined();

    const response = await authed('DELETE', `/api/sessions/${(other as { id: string }).id}`, first);
    expect(response.status).toBe(204);
    // Thu hồi phiên khác: cookie của caller không bị xoá.
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(await countAuditEvents(SUB_MAIN, 'data_session_revoked')).toBe(1);

    // Phiên bị thu hồi không còn trong danh sách.
    const afterList = await authed('GET', '/api/sessions', first);
    const afterBody = (await afterList.json()) as { sessions: unknown[] };
    expect(afterBody.sessions).toHaveLength(1);
    void second;
  });

  it('session DELETE of the current session revokes it, clears both cookies, and audits the current-session event', async () => {
    const cookies = await loginAndGetCookies();

    const listResponse = await authed('GET', '/api/sessions', cookies);
    const listBody = (await listResponse.json()) as {
      sessions: Array<{ id: string; isCurrent: boolean }>;
    };
    const current = listBody.sessions.find((row) => row.isCurrent);
    expect(current).toBeDefined();

    const response = await authed(
      'DELETE',
      `/api/sessions/${(current as { id: string }).id}`,
      cookies,
    );
    expect(response.status).toBe(204);
    const cleared = response.headers.getSetCookie();
    expect(cleared.some((cookie) => cookie.startsWith('__Host-account-session='))).toBe(true);
    expect(cleared.some((cookie) => cookie.startsWith('__Host-account-csrf='))).toBe(true);
    expect(await countAuditEvents(SUB_MAIN, 'data_current_session_revoked')).toBe(1);

    // Phiên đã chết: request kế tiếp với cookie cũ là 401.
    const gone = await authed('GET', '/api/sessions', cookies);
    expect(gone.status).toBe(401);
  });

  it('session DELETE with an unknown id is 404 and audits nothing', async () => {
    const cookies = await loginAndGetCookies();
    const response = await authed('DELETE', `/api/sessions/${'ab'.repeat(32)}`, cookies);
    expect(response.status).toBe(404);
    expect(await countAuditEvents(SUB_MAIN, 'data_session_revoked')).toBe(0);
    expect(await countAuditEvents(SUB_MAIN, 'data_current_session_revoked')).toBe(0);
  });
});
