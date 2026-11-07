import { expect, test } from '@playwright/test';

import { resolveAccountOrigin, stackRequest, type StackResponse } from './support/local-origin';
import {
  cleanupFixtureData,
  clearMailSink,
  pollOtpFromSink,
  resolveStackNamespace,
  seedFixtureUser,
  type FixtureIdentity,
} from './support/local-stack';

/**
 * Luồng đăng nhập email-OTP end-to-end trên ACCOUNT service — happy path
 * thật của issue #185: seed user qua DB (không signup API) → challenge →
 * OTP từ mail sink (D1 của transactional-mail) → verify → session.
 *
 * Hợp đồng route (đã đối chiếu từng file nguồn):
 * - `POST /api/auth/challenge` `{email}` → `204`, KHÔNG body, cho mọi nhánh
 *   (anti-enumeration — `challenge.post.ts`).
 * - `POST /api/auth/verify` `{email, code}` đúng mã → `200` `{"ok":true}`
 *   + `Set-Cookie` session (`verify.post.ts`).
 * - `GET /api/auth/session` với cookie hợp lệ → `200` `{sub, acr, authnAt,
 *   expiresAt}` (`session.get.ts`).
 *
 * ⚠️ Rate-limit của route: 3 challenge / 15 phút mỗi địa chỉ, cooldown resend
 * 60s — cả hai im lặng (vẫn 204). Mỗi file spec dùng MỘT danh tính fixture
 * RIÊNG (`FixtureIdentity`) nên hai worker song song không bao giờ chia sẻ
 * cửa sổ rate-limit hay mã OTP; cleanup sau suite xóa hàng challenge của
 * chính danh tính đó nên chạy lại liên tục không dồn trần.
 *
 * Serial trong file: các test của LUỒNG này có trạng thái chia sẻ (mã OTP
 * cấp một lần, verify một lần) — `test.describe.configure({ mode: 'serial' })`
 * đúng nghĩa chuỗi bước của một journey.
 */

/** Danh tính fixture RIÊNG của file này — không file nào khác dùng chung. */
const FIXTURE: FixtureIdentity = {
  sub: 'identity-login-e2e-flow-user',
  email: 'identity-login-e2e-flow@local.test',
};

test.describe.configure({ mode: 'serial' });

const VERIFY_PATH = '/api/auth/verify';
const SESSION_PATH = '/api/auth/session';

/** Cookie header dạng `name=value` từ một header Set-Cookie nguyên văn. */
function cookiePair(setCookie: string): string {
  const pair = setCookie.split(';')[0] ?? '';
  if (pair.length === 0) {
    throw new Error(`no cookie pair in Set-Cookie header: ${setCookie.slice(0, 120)}`);
  }
  return pair;
}

/**
 * Session cookie từ response verify — phần tử Set-Cookie nào mang tên
 * `__Host-account-session`. Ném khi không có (test phải đỏ với lý do rõ).
 */
function sessionCookieFrom(response: StackResponse): string {
  const header = response.rawSetCookie.find((cookie) =>
    cookie.startsWith('__Host-account-session='),
  );
  if (header === undefined) {
    throw new Error(
      `verify response carried no __Host-account-session cookie — set-cookie count: ` +
        `${response.rawSetCookie.length}`,
    );
  }
  return cookiePair(header);
}

test.describe('account login OTP flow', () => {
  let origin: string;
  let namespace: string;

  test.beforeAll(() => {
    origin = resolveAccountOrigin();
    namespace = resolveStackNamespace();
    seedFixtureUser(namespace, FIXTURE);
    // Sink sạch trước khi challenge — nếu còn message cũ của lần chạy trước,
    // poll có thể nhặt mã đã tiêu (challenge cũ đã bị xóa/consume).
    clearMailSink(namespace, [FIXTURE.email]);
  });

  test.afterAll(() => {
    cleanupFixtureData(namespace, FIXTURE);
  });

  let otpCode: string;
  let sessionCookie: string;
  let csrfCookie: string;

  test('challenge issues a silent 204 and the OTP lands in the mail sink', async () => {
    const challenge = await stackRequest(`${origin}/api/auth/challenge`, {
      method: 'POST',
      bodyText: JSON.stringify({ email: FIXTURE.email }),
    });

    // Anti-enumeration bề mặt: 204, không body, không oracle nào khác.
    expect(challenge.status).toBe(204);
    expect(challenge.body).toBe('');
    expect(challenge.rawSetCookie).toEqual([]);

    // OTP đến sink qua chuỗi async thật: account → mail (HMAC ký) → outbox
    // → queue → consumer → fake provider → D1 render. Poll + trigger cron.
    otpCode = await pollOtpFromSink(namespace, FIXTURE.email);
    expect(otpCode).toMatch(/^\d{8}$/u);
  });

  test('verify with the mailed code issues the session cookie pair', async () => {
    const response = await stackRequest(`${origin}${VERIFY_PATH}`, {
      method: 'POST',
      bodyText: JSON.stringify({ email: FIXTURE.email, code: otpCode }),
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });

    sessionCookie = sessionCookieFrom(response);
    // Hai cookie của verify.post.ts: session (HttpOnly) + CSRF (không HttpOnly).
    const csrf = response.rawSetCookie.find((cookie) => cookie.startsWith('__Host-account-csrf='));
    expect(csrf).toBeDefined();
    csrfCookie = cookiePair(csrf ?? '');
  });

  test('session read with the issued cookie returns the OTP session payload', async () => {
    const response = await stackRequest(`${origin}${SESSION_PATH}`, {
      extraHeaders: { cookie: sessionCookie },
    });

    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      sub: unknown;
      acr: unknown;
      authnAt: unknown;
      expiresAt: unknown;
    };
    // Đúng shape của session.get.ts: sub của user đã seed, ACR của luồng OTP
    // (ACR.EmailOtp = 'urn:ecoma:acr:email-otp', libs/account-domain/src/acr.ts),
    // hai mốc epoch-ms.
    expect(payload.sub).toBe(FIXTURE.sub);
    expect(payload.acr).toBe('urn:ecoma:acr:email-otp');
    expect(typeof payload.authnAt).toBe('number');
    expect(typeof payload.expiresAt).toBe('number');
    expect(payload.expiresAt).toBeGreaterThan(payload.authnAt as number);
  });

  test('logout with the CSRF double-submit revokes the session server-side', async () => {
    // logout.post.ts: CSRF cookie phải echo vào header `x-ecoma-csrf`.
    const logout = await stackRequest(`${origin}/api/auth/logout`, {
      method: 'POST',
      extraHeaders: {
        cookie: `${sessionCookie}; ${csrfCookie}`,
        'x-ecoma-csrf': csrfCookie.split('=')[1] ?? '',
      },
    });
    expect(logout.status).toBe(204);
    expect(logout.body).toBe('');
    // Set-Cookie xóa cả hai cookie (Max-Age=0).
    const cleared = logout.rawSetCookie.filter((cookie) => /Max-Age=0/u.test(cookie));
    expect(cleared.length).toBeGreaterThanOrEqual(2);

    // Thu hồi là DB-side: cùng cookie đó không còn session sống.
    const after = await stackRequest(`${origin}${SESSION_PATH}`, {
      extraHeaders: { cookie: sessionCookie },
    });
    expect(after.status).toBe(401);
  });
});
