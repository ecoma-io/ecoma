import { createHash } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { EXPECTED_CLIENT_ID } from './support/fixtures';
import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Contract của login kickoff — `GET /api/auth/login` khi CHƯA đăng nhập.
 *
 * Đây là hop ĐẦU TIÊN của luồng OIDC, do BFF tự dựng (`apps/backoffice/server/
 * api/auth/login.get.ts`): insert login flow vào DB, set cookie
 * `__Host-backoffice-login` (dùng một lần), rồi 302 browser tới authorize của
 * issuer với bộ tham số OIDC đầy đủ. Suite assert TRỰC TIẾP trên 302 này bằng
 * request Node (không theo redirect) — mọi tham số protocol là thứ suite sinh
 * ra để kiểm, để browser tự theo là giấu đúng phần cần inspect.
 *
 * PKCE không kiểm được chiều ngược (verifier nằm server-side trong
 * `login_flows`), nhưng `code_challenge_method=S256` và presence của
 * `code_challenge` là contract của URL — assert được từ ngoài.
 */

test.describe('login kickoff contract', () => {
  test('GET /api/auth/login redirects 302 to the authorize endpoint with the full OIDC parameter set', async () => {
    const response = await stackGet(`${resolveStackOrigin()}/api/auth/login`);

    expect(response.status).toBe(302);
    const location = response.headers.location;
    // `expect(...).toBeDefined()` trước rồi mới parse — vừa là assertion vừa
    // là narrow cho TS, không cần non-null assertion (root `.oxlintrc.json`
    // cấm `!.` ở mức 2).
    expect(location).toBeDefined();
    const target = new URL(location ?? 'about:invalid');

    // Đích là authorize của issuer local — host `auth.<rootHostname>` với port
    // động của stack (issuer GHIM chuỗi có port, xem `backoffice-deploy`).
    expect(target.hostname).toBe(
      new URL(resolveStackOrigin()).hostname.replace(/^office\./u, 'auth.'),
    );
    expect(target.pathname).toBe('/authorize');

    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('client_id')).toBe(EXPECTED_CLIENT_ID);
    expect(target.searchParams.get('redirect_uri')).toBe(
      `${resolveStackOrigin()}/api/auth/callback`,
    );
    // Scope ghim ADR-0012 §6: openid cho ID token, offline_access cho refresh.
    expect(target.searchParams.get('scope')).toBe('openid offline_access');
    // PKCE S256: challenge là base64url SHA-256 của verifier server-side —
    // shape 43 ký tự base64url (32 byte → 43), method phải khai tường minh.
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // `state` là flow value 256-bit của BFF (createFlowValue) — cùng shape.
    expect(target.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test('GET /api/auth/login sets the one-time __Host-backoffice-login cookie with the mandated flags', async () => {
    const response = await stackGet(`${resolveStackOrigin()}/api/auth/login`);

    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const flowCookie = (setCookie ?? '')
      .split('\n')
      .find((line) => line.startsWith('__Host-backoffice-login='));
    expect(flowCookie).toBeDefined();
    const cookieLine = flowCookie ?? '';
    // Cookie `__Host-`: Secure + Path=/ là điều kiện bắt buộc của browser
    // (prefix `__Host-` bị Chrome/Firefox ép); HttpOnly + SameSite=Lax là
    // lựa chọn của `loginFlowCookie` (`libs/backoffice-application`).
    expect(cookieLine).toContain('Secure');
    expect(cookieLine).toContain('HttpOnly');
    expect(cookieLine).toContain('SameSite=Lax');
    expect(cookieLine).toContain('Path=/');
    expect(cookieLine).toMatch(/Max-Age=600/u);
    // Value là flow value 256-bit — cùng shape với `state`.
    const value = cookieLine.split(';')[0]?.split('=').slice(1).join('=') ?? '';
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test('two kickoff requests produce distinct state and PKCE challenges (no replay of flow values)', async () => {
    const first = await stackGet(`${resolveStackOrigin()}/api/auth/login`);
    const second = await stackGet(`${resolveStackOrigin()}/api/auth/login`);
    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    expect(first.headers.location).toBeDefined();
    expect(second.headers.location).toBeDefined();

    const firstUrl = new URL(first.headers.location ?? 'about:invalid');
    const secondUrl = new URL(second.headers.location ?? 'about:invalid');
    // Hai luồng login là hai luồng độc lập — `state` trùng là bug (flow value
    // không được tái sử dụng; callback đối chiếu state theo cookie từng lần).
    expect(firstUrl.searchParams.get('state')).not.toBe(secondUrl.searchParams.get('state'));
    expect(firstUrl.searchParams.get('code_challenge')).not.toBe(
      secondUrl.searchParams.get('code_challenge'),
    );

    // Invariant chiều S256: challenge trên URL không bao giờ là ảnh SHA-256
    // của chính nó (nó là ảnh của verifier server-side — không đoán được từ
    // ngoài, nhưng "challenge = SHA256(challenge)" là điểm bất khả thi toán
    // học mà một leak verifier-via-URL sẽ vi phạm).
    const challenge = firstUrl.searchParams.get('code_challenge') ?? '';
    expect(challenge).not.toBe(createHash('sha256').update(challenge).digest('base64url'));
  });
});
