import { importJWK, jwtVerify } from 'jose';
import { expect, test } from '@playwright/test';

import {
  accountOrigin,
  authOrigin,
  discoverNamespace,
  LOCAL_CLIENT_ID,
  localRedirectUri,
  makePkceChallenge,
  makePkceVerifier,
  makeTestSubject,
  pollOtpMail,
  primaryAudience,
  seedUser,
  stackGet,
  stackPostForm,
} from './support/local-origin';

/**
 * Luồng authorize đầy đủ của ECOMA qua BROWSER thật: glue mint transaction →
 * provider tạo Interaction → account login OTP → hop `/authorize/confirm` →
 * handoff → consent → code → token → verify JWT bằng JWKS công bố.
 *
 * ⚠️ Điểm KHÁC một luồng OIDC chuẩn, và là lý do test này tồn tại: browser
 * không bao giờ TỰ quay lại `auth` sau khi tới `/login?handle=X` cho tới khi
 * OTP verify xong — khi đó trang login của account relay browser sang
 * `GET /authorize/confirm?handle=X` (URL do BFF verify cấp, §5.1.2 hàng 7).
 * Hop này CAS `pending_browser → browser_confirmed` rồi 302 về
 * `/login/continue?handle=X`; từ đó `/login/continue` push kết quả xác thực về
 * auth qua Service Binding (`POST /internal/session/verified`). Push chỉ được
 * chấp nhận khi transaction đã `browser_confirmed` — cookie
 * `__Host-auth-browser` mà browser nhận ở 302 của `/authorize` chính là bằng
 * chứng "browser của transaction" (§5.3 lớp 2). Confirm hop đi qua browser
 * thật (URL relay), nên contract của nó được chứng minh bằng `page.on('response')`
 * listener — không dùng `page.request` thủ công nữa.
 *
 * Chuỗi bước (mỗi bước một assert trong test):
 *   1. GET /authorize (glue) → 302 `/auth?...&ecoma_x=X` + Set-Cookie B.
 *   2. GET /auth (provider) → 303 `https://account.../login?handle=X`.
 *   3. UI login: fill email → submit → OTP từ mail sink → fill code → submit →
 *      trang relay sang `/authorize/confirm?handle=X` (product path) → 302
 *      `/login/continue?handle=X` (listener assert 302, không `page.request`).
 *   4. `/login/continue` handoff tự relay (window.location.assign sang
 *      continueUrl của auth).
 *   5. Consent UI: approve → continue → 303 resume → callback.
 *   6. Callback BỊ BẮT qua `waitForURL` (không `page.route`) — code single-use
 *      KHÔNG được để backoffice tiêu thụ; test là RP của riêng mình.
 *   7. POST /token với code_verifier → tokens thật; verify id_token + access
 *      token bằng jose với JWKS công bố (issuer + audience đúng).
 *
 * TTL test: OTP đi qua HTTP accept là có ngay trong sink (render tại accept);
 * budget poll 30s. Nhưng test đang chạy SONG SONG với test khác ở cùng origin
 * account — email test là duy nhất per-run để chống va chạm rate limit OTP
 * (3/15 phút, 10/giờ theo otp.ts).
 */

const TEST_TIMEOUT_MS = 120_000;

test('completes the full browser authorize → OTP login → consent → token flow', async ({
  page,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);

  const namespace = requireNamespace();
  const origin = authOrigin();
  const account = accountOrigin();
  const redirectUri = localRedirectUri();
  const state = `st-${Date.now().toString(36)}`;
  const nonce = `n-${Date.now().toString(36)}`;

  // ── Seed: user + email verified trong db-account (idempotent) ────────────
  const email = makeTestEmail();
  const sub = makeTestSubject();
  seedUser(namespace, sub, email);
  const otpSinceMs = Date.now();

  // ── Bước 1: GET /authorize (glue) ────────────────────────────────────────
  const verifier = makePkceVerifier();
  const challenge = makePkceChallenge(verifier);
  const authorizeUrl =
    `${origin}/authorize?client_id=${LOCAL_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=${encodeURIComponent('openid offline_access')}` +
    `&state=${state}&nonce=${nonce}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;

  // ── Bước 3 listener: hop `/authorize/confirm` của product path ───────────
  // Gắn TRƯỚC khi điều hướng: sau verify OTP, trang login relay browser sang
  // confirm endpoint (URL do BFF verify cấp). Listener ghi lại response của
  // hop này để assert contract (302 → /login/continue?handle=X) mà không cần
  // `page.request` thủ công — request phải do PRODUCT phát ra, mới là bằng
  // chứng luồng thật.
  let confirmHop: { status: number; location: URL } | undefined;
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname === '/authorize/confirm') {
      const location = response.headers()['location'] ?? '';
      confirmHop = { status: response.status(), location: new URL(location, origin) };
    }
  });

  // Navigate glue endpoint bằng browser thật — Set-Cookie `__Host-auth-browser`
  // phải vào cookie jar của context (Secure + __Host- yêu cầu https, stack có).
  await page.goto(authorizeUrl, { waitUntil: 'commit' });
  // 302 thứ nhất (glue) → /auth → 303 provider → account /login. Playwright
  // tự theo chuỗi; đích cuối là trang login account với handle.
  await page.waitForURL(`${account}/login**`, { timeout: 30_000 });
  const loginUrl = new URL(page.url());
  const handleX = loginUrl.searchParams.get('handle');
  expect(handleX).not.toBeNull();

  // Cookie browser binding đã được glue mint và browser lưu — một cookie cho
  // một transaction; assert presence (không assert giá trị).
  const browserCookies = await page.context().cookies(origin);
  expect(browserCookies.some((cookie) => cookie.name === '__Host-auth-browser')).toBe(true);

  // ── Bước 3: UI login OTP → product tự đi hop confirm ────────────────────
  // Trang login hiện form email (testid login-email + login-submit).
  const emailInput = page.getByTestId('login-email');
  await emailInput.waitFor({ state: 'visible', timeout: 30_000 });
  await emailInput.fill(email);
  await page.getByTestId('login-submit').click();

  // Challenge screen: testid login-challenge xuất hiện sau khi POST challenge
  // 204 (session anonymous + binding được tạo server-side; mail được accept).
  const challengeBox = page.getByTestId('login-challenge');
  await challengeBox.waitFor({ state: 'visible', timeout: 30_000 });

  // OTP từ mail sink (D1 trong WIC mail) — nội dung render NGAY LÚC ACCEPT,
  // poll ở đây là chờ HTTP round-trip + wrangler đọc sqlite.
  const otp = await pollOtpMail(namespace, email, otpSinceMs, { budgetMs: 60_000 });

  // Assertion mã đúng là mã đã cấp: digest HMAC khớp hàng otp_challenges mà
  // account vừa ghi. (Không log code; chỉ so digest.)
  const codeInput = page.getByTestId('login-code');
  await codeInput.fill(otp.code);
  await page.getByTestId('login-code-submit').click();

  // Verify OK → product tự relay browser qua hop `/authorize/confirm` rồi 302
  // về `/login/continue`. Contract của hop confirm (bằng chứng product path):
  // request do trang login phát ra (không phải page.request), status 302, đích
  // /login/continue cùng handle (§5.1.2 hàng 2 + hàng 7).
  // ⚠️ `expect(variable).toBeDefined()` KHÔNG retry — listener gán biến ngoài
  // vòng lifecycle của expect, nên assertion chạy ngay lập tức với `undefined` dù
  // response sắp tới (đỏ thật ở round 5). `expect.poll` là hình dạng đúng:
  // đọc lại biến mỗi khoảng poll cho tới budget 30s.
  await expect.poll(() => confirmHop, { timeout: 30_000 }).toBeDefined();
  expect(confirmHop?.status).toBe(302);
  expect(confirmHop?.location.origin + confirmHop?.location.pathname).toBe(
    `${account}/login/continue`,
  );
  expect(confirmHop?.location.searchParams.get('handle')).toBe(handleX);

  // `/login/continue` là click-to-continue: push handoff chỉ chạy khi người
  // dùng bấm nút relay — bấm nó rồi mới đến continueUrl của auth (consent
  // path), đích cuối là trang consent của account.
  const continueTarget = page.getByTestId('login-continue-target');
  await continueTarget.waitFor({ state: 'visible', timeout: 30_000 });
  await continueTarget.click();

  await page.waitForURL(`${account}/consent**`, { timeout: 60_000 });
  const consentUrl = new URL(page.url());
  expect(consentUrl.searchParams.get('handle')).not.toBeNull();

  // ── Bước 5: consent ──────────────────────────────────────────────────────
  const consentCard = page.getByTestId('consent-card');
  await consentCard.waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('consent-approve').click();
  // Nút continue chỉ render khi auth trả continue_url (resume URL của provider).
  const continueButton = page.getByTestId('consent-continue');
  await continueButton.waitFor({ state: 'visible', timeout: 30_000 });
  await continueButton.click();

  // ── Bước 6: resume 303 → callback ─────────────────────────────────────────
  // KHÔNG dùng `page.route` để chặn callback: qua redirect chain thật của
  // provider (303 `/auth/:uid` → callback trên origin khác) interception
  // không đảm bảo fire (đã đỏ thật — request lọt tới backoffice, poll chết).
  // `waitForURL` + đọc `page.url()` bắt đúng URL cuối của chain; code vẫn chưa
  // bị tiêu thụ vì backoffice 401 (`no_flow_cookie`) TRƯỚC khi đổi code, và
  // test là bên duy nhất POST /token ở bước 7.
  await page.waitForURL(`${localRedirectUri()}**`, { timeout: 30_000 });
  const capturedCallbackUrl = new URL(page.url());
  // Callback URI khớp đúng redirect_uri đã đăng ký (origin + path).
  const callbackTarget = `${capturedCallbackUrl?.origin ?? ''}${capturedCallbackUrl?.pathname ?? ''}`;
  expect(callbackTarget).toBe(redirectUri);
  expect(capturedCallbackUrl?.searchParams.get('state')).toBe(state);
  // iss parameter bật trong discovery — provider gắn vào authorization response.
  expect(capturedCallbackUrl?.searchParams.get('iss')).toBe(origin);
  const code = capturedCallbackUrl?.searchParams.get('code');
  expect(typeof code).toBe('string');
  expect((code as string).length).toBeGreaterThan(0);

  // ── Bước 7: POST /token + verify JWT bằng JWKS công bố ───────────────────
  const tokenResponse = await stackPostForm(`${origin}/token`, {
    grant_type: 'authorization_code',
    code: code as string,
    redirect_uri: redirectUri,
    client_id: LOCAL_CLIENT_ID,
    code_verifier: verifier,
  });
  expect(tokenResponse.status).toBe(200);
  const tokens = JSON.parse(tokenResponse.body) as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in?: number;
  };
  expect(tokens.token_type).toBe('Bearer');
  expect(typeof tokens.access_token).toBe('string');
  // offline_access + prompt=consent do glue chèn ⇒ refresh token phải được cấp.
  expect(typeof tokens.refresh_token).toBe('string');

  // JWKS công bố — private material đã được file protocol-surface assert vắng.
  const jwksResponse = await stackGet(`${origin}/jwks.json`, { Accept: 'application/json' });
  const jwks = JSON.parse(jwksResponse.body) as { keys: Array<Record<string, unknown>> };
  const es256Key = jwks.keys[0];
  expect(es256Key).toBeDefined();
  const publicKey = (await importJWK({ ...es256Key, alg: 'ES256' }, 'ES256')) as never;

  // id_token: iss = origin, aud = client_id (OIDC core), acr + auth_time từ
  // result.login mà account push.
  const idClaims = (
    await jwtVerify(tokens.id_token, publicKey, { issuer: origin, audience: LOCAL_CLIENT_ID })
  ).payload as Record<string, unknown>;
  expect(idClaims['sub']).toBe(sub);
  expect(idClaims['acr']).toBe('urn:ecoma:acr:email-otp');
  expect(typeof idClaims['auth_time']).toBe('number');
  // nonce được phản chiếu nguyên vẹn khi request mang nonce.
  expect(idClaims['nonce']).toBe(nonce);

  // access token: ES256, aud = primary audience (resource indicator mặc định
  // của client không nằm trong AUTH_RESOURCES), sub khớp.
  const accessClaims = (
    await jwtVerify(tokens.access_token, publicKey, { issuer: origin, audience: primaryAudience() })
  ).payload as Record<string, unknown>;
  expect(accessClaims['sub']).toBe(sub);
  // SCOPE openid+offline_access — không có profile ⇒ KHÔNG có email claim nào
  // (claims_supported chỉ sub/acr/auth_time; email_verified không tồn tại).
  expect(accessClaims).not.toHaveProperty('email');
  expect(accessClaims).not.toHaveProperty('email_verified');

  // Token còn dùng được ở một đường protocol khác: refresh ngay (assert chi
  // tiết rotation nằm ở file refresh-rotation.spec.ts, đây chỉ pin tính sống).
  const rotateProbe = await stackPostForm(`${origin}/token`, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token as string,
    client_id: LOCAL_CLIENT_ID,
  });
  expect(rotateProbe.status).toBe(200);
});

// ── helpers cục bộ ───────────────────────────────────────────────────────────

function requireNamespace(): string {
  const namespace = discoverNamespace();
  if (namespace === undefined) {
    throw new Error(
      'could not discover the Docker namespace of this worktree (no ecoma-*-traefik container ' +
        'with the ROOT_DOMAIN port). Run `pnpm nx affected -t system-test -c local` first.',
    );
  }
  return namespace;
}

/**
 * Email test duy nhất per-run: OTP rate limit là 3/15 phút + 10/giờ theo địa
 * chỉ — một địa chỉ cố định sẽ chết ở lần chạy thứ tư. Chữ số run-time khiến
 * mỗi lần chạy có pool riêng.
 */
function makeTestEmail(): string {
  return `oidc-e2e-${Date.now().toString(36)}@e2e-test.ecoma.local`;
}
