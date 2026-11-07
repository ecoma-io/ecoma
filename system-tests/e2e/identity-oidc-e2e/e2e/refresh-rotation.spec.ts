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
  seedUser,
  stackPostForm,
} from './support/local-origin';

/**
 * Họ quay vòng refresh token của ECOMA — rotation + reuse detection — và
 * revocation endpoint, chạy TRÊN grant thật tạo bằng cùng luồng browser như
 * `oidc-browser-flow.spec.ts`.
 *
 * Hợp đồng cần chứng minh (mỗi mệnh đề là một assert riêng):
 *   R1. refresh RT1 → 200 với RT2 MỚI (rotate; RT1 bị consume).
 *   R2. refresh lại RT1 (reuse) → 400 invalid_grant.
 *   R3. refresh RT2 (đã rotate trước đó, cùng family) → 400 invalid_grant —
 *       reuse detection THU HỒI TOÀN FAMILY, không chỉ từ chối token cũ.
 *   R4. POST /revocation với RT hợp lệ (lấy từ một grant khác) → 200, và
 *       refresh sau đó → 400 — endpoint RFC 7009 sống thật trên stack.
 *
 * ⚠️ `error_description` của InvalidGrant là hằng 'grant request is invalid'
 * (errors.js của provider) — assert đúng `error` code và HẬU QUẢ (các test
 * tiếp theo chết theo cách đo được), không assert chuỗi chi tiết.
 *
 * Việc tạo token grant: mỗi test tự đi qua browser flow một lần (provider test
 * độc lập, workers: 2 cho phép hai flow song song — mỗi test một email riêng
 * nên không va chạm OTP rate limit).
 */

const TEST_TIMEOUT_MS = 180_000;

interface TokenBundle {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
}

async function obtainTokens(page: import('@playwright/test').Page): Promise<TokenBundle> {
  const namespace = requireNamespace();
  const origin = authOrigin();
  const account = accountOrigin();
  const redirectUri = localRedirectUri();

  const email = `oidc-rot-${Date.now().toString(36)}@e2e-test.ecoma.local`;
  const sub = makeTestSubject();
  seedUser(namespace, sub, email);
  const otpSinceMs = Date.now();

  const verifier = makePkceVerifier();
  const authorizeUrl =
    `${origin}/authorize?client_id=${LOCAL_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code&scope=${encodeURIComponent('openid offline_access')}` +
    `&state=st-rot&code_challenge=${makePkceChallenge(verifier)}&code_challenge_method=S256`;

  await page.goto(authorizeUrl, { waitUntil: 'commit' });
  await page.waitForURL(`${account}/login**`, { timeout: 30_000 });
  // Browser đã đứng ở trang login account mang handle — hop `/authorize/confirm`
  // không còn là bước thủ công của test: trang login tự relay browser qua hop
  // này sau verify OTP (§5.1.2 hàng 7), rồi `/login/continue` push về auth.

  const emailInput = page.getByTestId('login-email');
  await emailInput.waitFor({ state: 'visible', timeout: 30_000 });
  await emailInput.fill(email);
  await page.getByTestId('login-submit').click();
  await page.getByTestId('login-challenge').waitFor({ state: 'visible', timeout: 30_000 });

  const otp = await pollOtpMail(namespace, email, otpSinceMs, { budgetMs: 60_000 });
  await page.getByTestId('login-code').fill(otp.code);
  await page.getByTestId('login-code-submit').click();

  // Sau verify, product relay browser qua hop `/authorize/confirm` rồi 302 về
  // `/login/continue` — click-to-continue: bấm nút relay trước khi handoff push
  // chạy và browser đi tiếp sang auth (consent).
  const continueTarget = page.getByTestId('login-continue-target');
  await continueTarget.waitFor({ state: 'visible', timeout: 30_000 });
  await continueTarget.click();

  await page.waitForURL(`${account}/consent**`, { timeout: 60_000 });
  await page.getByTestId('consent-card').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('consent-approve').click();
  const continueButton = page.getByTestId('consent-continue');
  await continueButton.waitFor({ state: 'visible', timeout: 30_000 });
  await continueButton.click();

  // KHÔNG dùng `page.route` để chặn callback: interception không đảm bảo fire
  // qua redirect chain thật của provider (đã đỏ thật — request lọt tới
  // backoffice, poll chết). `waitForURL` + `page.url()` bắt đúng URL cuối;
  // code chưa bị tiêu thụ vì backoffice 401 (`no_flow_cookie`) trước khi đổi
  // code, và test là bên duy nhất POST /token.
  await page.waitForURL(`${localRedirectUri()}**`, { timeout: 30_000 });
  const callbackUrl = new URL(page.url());
  const code = callbackUrl.searchParams.get('code');
  expect(typeof code).toBe('string');

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
  };
  expect(typeof tokens.refresh_token).toBe('string');
  return {
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token as string,
  };
}

test.describe('refresh token rotation + reuse detection', () => {
  test('rotates on first use, revokes the whole family on reuse, and leaves the newest token dead', async ({
    page,
  }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const origin = authOrigin();

    const first = await obtainTokens(page);
    const rt1 = first.refreshToken;

    // R1 — rotate: RT1 → RT2 (mới, khác RT1).
    const rotate = await stackPostForm(`${origin}/token`, {
      grant_type: 'refresh_token',
      refresh_token: rt1,
      client_id: LOCAL_CLIENT_ID,
    });
    expect(rotate.status).toBe(200);
    const rotated = JSON.parse(rotate.body) as { refresh_token?: string };
    expect(typeof rotated.refresh_token).toBe('string');
    const rt2 = rotated.refresh_token as string;
    expect(rt2).not.toBe(rt1);

    // R2 — reuse RT1: 400 invalid_grant (RT1 đã consume lúc rotate).
    const reuse = await stackPostForm(`${origin}/token`, {
      grant_type: 'refresh_token',
      refresh_token: rt1,
      client_id: LOCAL_CLIENT_ID,
    });
    expect(reuse.status).toBe(400);
    const reuseBody = JSON.parse(reuse.body) as { error?: string };
    expect(reuseBody['error']).toBe('invalid_grant');

    // R3 — reuse detection THU HỒI FAMILY: RT2 (sinh sau RT1, cùng grant) cũng
    // chết theo revokeByGrantId. Đây là assert mạnh nhất của policy.
    const afterFamily = await stackPostForm(`${origin}/token`, {
      grant_type: 'refresh_token',
      refresh_token: rt2,
      client_id: LOCAL_CLIENT_ID,
    });
    expect(afterFamily.status).toBe(400);
    const afterFamilyBody = JSON.parse(afterFamily.body) as { error?: string };
    expect(afterFamilyBody['error']).toBe('invalid_grant');
  });
});

test.describe('revocation endpoint (RFC 7009)', () => {
  test('revokes a live refresh token so the next refresh attempt fails', async ({ page }) => {
    test.setTimeout(TEST_TIMEOUT_MS);
    const origin = authOrigin();

    const bundle = await obtainTokens(page);

    // R4a — revoke RT đang sống: 200 (RFC 7009 trả 200 kể cả token lạ, nhưng ở
    // đây token là thật nên 200 phải kèm hiệu lực thật).
    const revoke = await stackPostForm(`${origin}/revocation`, {
      token: bundle.refreshToken,
      client_id: LOCAL_CLIENT_ID,
      token_type_hint: 'refresh_token',
    });
    expect(revoke.status).toBe(200);

    // R4b — hiệu lực đo được: refresh bằng RT vừa revoke → 400 invalid_grant.
    const after = await stackPostForm(`${origin}/token`, {
      grant_type: 'refresh_token',
      refresh_token: bundle.refreshToken,
      client_id: LOCAL_CLIENT_ID,
    });
    expect(after.status).toBe(400);
    const afterBody = JSON.parse(after.body) as { error?: string };
    expect(afterBody['error']).toBe('invalid_grant');
  });
});

// ── helpers cục bộ (giống oidc-browser-flow.spec.ts — mỗi suite tự chứa) ────

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
