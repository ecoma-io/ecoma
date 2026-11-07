import { expect, test } from '@playwright/test';

import { LOGOUT_IDENTITY, UNAUTHENTICATED_STATUS } from './support/fixtures';
import { CookieJar, resolveStackOrigin, stackGet, stackRequest } from './support/local-origin';
import { performBrowserLogin } from './support/oidc-flow';
import {
  mailWicContainerOf,
  readOtpFromMailSink,
  resolvePostgresContainer,
  seedAccountIdentity,
} from './support/stack-fixtures';

/**
 * Logout — lớp chốt vòng đời phiên.
 *
 * Contract (`apps/backoffice/server/api/auth/logout.post.ts`):
 * - CSRF double-submit: cookie `__Host-backoffice-csrf` phải echo trong header
 *   `x-ecoma-csrf`; CSRF cookie CÓ mà header sai/thiếu ⇒ **403** trước khi
 *   chạm DB.
 * - Thành công luôn **204** (idempotent, không lộ "có phiên hay không"),
 *   `Set-Cookie` xoá CẢ `__Host-backoffice-session` lẫn CSRF (Max-Age=0).
 * - Sau logout, session cookie cũ gọi `/api/me` ⇒ **401** — phiên đã revoke
 *   server-side, không phải chỉ xoá cookie.
 *
 * Suite dùng Node request với CookieJar (không browser) cho phần contract:
 * logout là hành vi HTTP thuần; browser chỉ cần thiết để đi luồng OIDC lấy
 * cặp cookie thật.
 */

/** Cookie jar từ browser context — chuyển sang Node request cho phần contract. */
async function jarFromBrowser(page: import('@playwright/test').Page): Promise<CookieJar> {
  const cookies = await page.context().cookies(resolveStackOrigin());
  const jar = new CookieJar();
  for (const cookie of cookies) {
    jar.absorb({
      status: 0,
      headers: { 'set-cookie': `${cookie.name}=${cookie.value}; Path=/` },
      body: '',
    });
  }
  return jar;
}

/**
 * Resolve origin TRONG từng test — KHÔNG ở scope file/describe: `--list` thu
 * thập test mà không có `.env`, gọi sớm là throw lúc collection (config no-throw
 * không đủ; chính helper `resolveStackOrigin` là đường fail-closed cho lệnh
 * gọi ngoài Nx). Hàm một dòng này capture `resolveStackOrigin` nên rule
 * `consistent-function-scoping` vẫn thoả.
 */
const origin = (): string => resolveStackOrigin();

test.describe.serial('logout revokes the session', () => {
  test('login once, then logout with the CSRF pair clears cookies and kills the session', async ({
    page,
  }) => {
    const postgres = await resolvePostgresContainer(origin());
    await seedAccountIdentity(postgres, LOGOUT_IDENTITY);

    const sinceMs = Date.now();
    const mailWic = mailWicContainerOf(postgres);

    // Login trong browser để lấy CẶP cookie thật (session + CSRF).
    await performBrowserLogin(page, {
      email: LOGOUT_IDENTITY.email,
      readOtp: () => readOtpFromMailSink(mailWic, { recipient: LOGOUT_IDENTITY.email, sinceMs }),
    });
    const jar = await jarFromBrowser(page);
    const sessionCookie = jar.get('__Host-backoffice-session');
    const csrfCookie = jar.get('__Host-backoffice-csrf');
    expect(sessionCookie).toBeDefined();
    expect(csrfCookie).toBeDefined();

    // — Bước 1: CSRF sai ⇒ 403, phiên KHÔNG bị thu hồi. —
    const mismatch = await stackRequest(`${origin()}/api/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: jar.header() ?? '',
        'x-ecoma-csrf': 'wrong-value',
      },
    });
    expect(mismatch.status).toBe(403);

    // — Bước 2: CSRF đúng ⇒ 204 + Set-Cookie xoá cặp cookie. —
    const ok = await stackRequest(`${origin()}/api/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: jar.header() ?? '',
        'x-ecoma-csrf': csrfCookie ?? 'missing',
      },
    });
    expect(ok.status).toBe(204);
    const cleared = ok.headers['set-cookie'] ?? '';
    expect(cleared).toContain('__Host-backoffice-session=');
    expect(cleared).toMatch(/__Host-backoffice-session=[^;]*; Max-Age=0/u);
    expect(cleared).toContain('__Host-backoffice-csrf=');
    expect(cleared).toMatch(/__Host-backoffice-csrf=[^;]*; Max-Age=0/u);
    jar.absorb(ok);

    // — Bước 3: cookie cũ gọi /api/me ⇒ 401 — phiên đã revoke server-side. —
    const afterLogout = await stackGet(`${origin()}/api/me`, { cookie: jar.header() ?? '' });
    expect(afterLogout.status).toBe(UNAUTHENTICATED_STATUS);
  });

  test('logout without any cookie is an idempotent 204', async () => {
    const response = await stackRequest(`${origin()}/api/auth/logout`, { method: 'POST' });
    expect(response.status).toBe(204);
    // Vẫn xoá cookie để dọn state của client lạ.
    const cleared = response.headers['set-cookie'] ?? '';
    expect(cleared).toContain('__Host-backoffice-session=');
    expect(cleared).toContain('__Host-backoffice-csrf=');
  });
});
