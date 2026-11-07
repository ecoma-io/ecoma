import { expect, test } from '@playwright/test';

import { resolveAccountOrigin, stackRequest } from './support/local-origin';
import {
  pollOtpFromSink,
  resolveStackNamespace,
  seedFixtureUser,
  cleanupFixtureData,
  clearMailSink,
  type FixtureIdentity,
} from './support/local-stack';

/**
 * Hợp đồng cookie + logout-idempotency của session OTP.
 *
 * - Cookie của `verify` mang prefix `__Host-` (session.ts: `__Host-` buộc
 *   Secure + Path=/ + không Domain) + `HttpOnly` + `SameSite=Lax` + `Max-Age`
 *   = `SESSION_ABSOLUTE_SECONDS` (7 ngày = 604800s). Server ghi thuộc tính
 *   TƯỜNG MINH — không dựa vào browser tự ép prefix. Suite assert từng thuộc
 *   tính trên header Set-Cookie THÔ.
 * - Session payload trả `sub` của user đã seed — mốc sub là fixture hằng.
 * - `POST /api/auth/logout` luôn 204 kể cả KHÔNG có session (idempotent —
 *   header comment logout.post.ts §Logout luôn 204): không cookie, hoặc
 *   cookie không khớp hàng nào, đều 204 và xóa cookie.
 *
 * File này tự cấp MỘT OTP (challenge → sink → verify) vì assert flag cookie
 * cần MỘT response verify thật. Danh tính fixture RIÊNG của file (xem
 * `FixtureIdentity`) — không chia sẻ rate-limit hay sink với worker song song.
 */

/** Danh tính fixture RIÊNG của file này — không file nào khác dùng chung. */
const FIXTURE: FixtureIdentity = {
  sub: 'identity-login-e2e-cookie-user',
  email: 'identity-login-e2e-cookie@local.test',
};

test.describe.configure({ mode: 'serial' });

const VERIFY_PATH = '/api/auth/verify';

test.describe('session cookie contract and logout idempotency', () => {
  let origin: string;
  let namespace: string;

  test.beforeAll(() => {
    origin = resolveAccountOrigin();
    namespace = resolveStackNamespace();
    seedFixtureUser(namespace, FIXTURE);
    clearMailSink(namespace, [FIXTURE.email]);
  });

  test.afterAll(() => {
    cleanupFixtureData(namespace, FIXTURE);
  });

  let sessionCookiePair: string;
  let sessionSetCookie: string;

  test('verify response Set-Cookie carries the full __Host- attribute set', async () => {
    // Luồng thật tới mã: challenge → sink → verify. (Copy ngắn của flow chính
    // — file này cần MỘT response verify thật để assert header raw.)
    const challenge = await stackRequest(`${origin}/api/auth/challenge`, {
      method: 'POST',
      bodyText: JSON.stringify({ email: FIXTURE.email }),
    });
    expect(challenge.status).toBe(204);

    const code = await pollOtpFromSink(namespace, FIXTURE.email);

    const response = await stackRequest(`${origin}${VERIFY_PATH}`, {
      method: 'POST',
      bodyText: JSON.stringify({ email: FIXTURE.email, code }),
    });
    expect(response.status).toBe(200);

    const session = response.rawSetCookie.find((cookie) =>
      cookie.startsWith('__Host-account-session='),
    );
    expect(session).toBeDefined();
    sessionSetCookie = session ?? '';

    // FR-004, từng thuộc tính trên MỘT header Set-Cookie nguyên văn:
    expect(sessionSetCookie).toContain('Path=/;');
    expect(sessionSetCookie).toContain('Secure');
    expect(sessionSetCookie).toContain('HttpOnly');
    expect(sessionSetCookie).toContain('SameSite=Lax');
    // Max-Age = SESSION_ABSOLUTE_SECONDS = 7 ngày (session.ts hằng số).
    expect(sessionSetCookie).toContain('Max-Age=604800');
    // __Host- cấm Domain — KHÔNG được xuất hiện.
    expect(sessionSetCookie).not.toMatch(/Domain=/iu);
    sessionCookiePair = sessionSetCookie.split(';')[0] ?? '';
  });

  test('session payload carries the seeded sub and OTP acr', async () => {
    const response = await stackRequest(`${origin}/api/auth/session`, {
      extraHeaders: { cookie: sessionCookiePair },
    });
    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as { sub: unknown; acr: unknown };
    expect(payload.sub).toBe(FIXTURE.sub);
    expect(payload.acr).toBe('urn:ecoma:acr:email-otp');
  });

  test('logout without any cookie is still 204 and clears cookies', async () => {
    // Idempotency của logout: không session → vẫn 204, không lỗi lộ "đã
    // đăng nhập hay chưa" (logout.post.ts §Logout luôn 204).
    const response = await stackRequest(`${origin}/api/auth/logout`, { method: 'POST' });
    expect(response.status).toBe(204);
    expect(response.body).toBe('');
    // Route xóa cookie ở MỌI nhánh 204.
    expect(response.rawSetCookie.length).toBeGreaterThanOrEqual(2);
    for (const header of response.rawSetCookie) {
      expect(header).toMatch(/Max-Age=0/u);
    }
  });

  test('logout with a foreign session cookie is still 204 without revoking anything else', async () => {
    // Cookie không khớp hàng nào: 204, không 500, không phân biệt.
    const response = await stackRequest(`${origin}/api/auth/logout`, {
      method: 'POST',
      extraHeaders: { cookie: '__Host-account-session=does-not-match-any-row' },
    });
    expect(response.status).toBe(204);
  });
});
