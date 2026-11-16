import { expect, type Page, type Response } from '@playwright/test';

/**
 * Luồng login browser đầy đủ của suite — quay OTP qua mail sink thật.
 *
 * Bản đồ luồng giống hệt `backoffice-access-control-e2e` (cùng issuer `auth`,
 * cùng trang login/consent của `account`) — khác biệt duy nhất là BFF đích:
 * callback `/api/auth/callback` của `remote-cache-app` đổi code lấy token,
 * insert `bff_sessions` vào `db-remote-cache-app`, set
 * `__Host-remote-cache-app-session` + `__Host-remote-cache-app-csrf`, rồi 302
 * về `/` (portal không có gate onboarding — callback luôn đáp `/`).
 *
 * Helper KHÔNG assert chi tiết contract từng redirect — chỉ điều khiển UI cho
 * đến khi browser đứng ở `/` của portal với session cookie.
 */

/** Người nhận OTP — được mọi caller truyền từ fixture identity dùng chung. */
export interface LoginFlowParams {
  readonly email: string;
  /** Đọc mã OTP từ mail sink — inject để test tự định thời điểm `sinceMs`. */
  readonly readOtp: () => Promise<string>;
}

/**
 * Kết quả một lượt login — những gì test muốn xem sau khi browser đã tới `/`.
 */
export interface LoginFlowResult {
  /**
   * Status + `Set-Cookie` của hop CUỐI (callback 302): bằng chứng contract
   * hop cuối của callback.
   */
  readonly finalHop: { readonly status: number; readonly setCookie: string | undefined };
  /** Path mà browser đứng sau khi callback 302 — luôn `/` cho portal này. */
  readonly finalPath: string;
}

/**
 * Số lần điều hướng lại tối đa khi đích đến chưa sẵn sàng, và tổng ngân sách
 * cho toàn bộ vòng — cùng hợp đồng "retry chỉ cho chữ ký chưa sẵn sàng" của
 * gate (`global-setup.ts`).
 */
const NAVIGATION_RETRIES = 5;
const NAVIGATION_BUDGET_MS = 45_000;

/**
 * Đường đích của phiên sau callback 302 — portal không có gate onboarding,
 * callback luôn đáp `/`.
 */
const LANDED_PATH_PATTERN = /\/$/u;

/**
 * Trang chết "chưa sẵn sàng" mà browser đang đứng — đọc từ status của response
 * ĐÍCH và nội dung body.
 *
 * ⚠️ `page.goto` resolve BÌNH THƯỜNG với mọi HTTP status: đáp xuống trang 404
 * KHÔNG phải navigation error. Hai kênh cùng lúc: status của response cuối
 * redirect chain (404/502/503/504) và body text Go-mux (`404 page not found`).
 */
async function isDeadGatewayPage(
  page: Page,
  response: Response | null,
): Promise<string | undefined> {
  const status = response?.status() ?? 0;
  if (status === 404 || status === 502 || status === 503 || status === 504) {
    return `dead gateway page (status ${status})`;
  }
  const bodyText =
    (await page
      .locator('body')
      .textContent({ timeout: 2_000 })
      .catch(() => '')) ?? '';
  if (bodyText.includes('404 page not found')) {
    return 'dead gateway page (Go-mux 404 body)';
  }
  return undefined;
}

/**
 * Điều hướng theo toàn bộ redirect chain tới trang login của account và chờ
 * form email mount — THỬ LẠI khi đích rơi vào cửa sổ cold start.
 *
 * Khi Traefik chưa có router cho `auth.<root>`, browser đứng yên trên trang Go
 * 404 — page đã `load` xong và sẽ KHÔNG BAO GIỜ fetch lại, nên việc chờ form
 * trên trang đó chỉ hết thời gian. Retry đúng nghĩa phải `goto` LẠI.
 */
async function gotoLoginPageUntilReady(page: Page): Promise<void> {
  const emailForm = page.getByTestId('login-email-form');
  const deadline = Date.now() + NAVIGATION_BUDGET_MS;
  for (let attempt = 1; ; attempt += 1) {
    const exhausted = attempt >= NAVIGATION_RETRIES || Date.now() >= deadline;
    try {
      // Điểm vào duy nhất: BFF dựng authorize URL (URL login do server dựng).
      const response = await page.goto('/api/auth/login', { waitUntil: 'load' });
      const dead = await isDeadGatewayPage(page, response);
      if (dead !== undefined) {
        if (exhausted) {
          throw new Error(`login page not ready after ${attempt} attempts: ${dead}`);
        }
        await page.waitForTimeout(2_000);
        continue;
      }
      await emailForm.waitFor({ state: 'visible', timeout: 15_000 });
      return;
    } catch (error) {
      const isFormTimeout = error instanceof Error && error.message.includes('login-email-form');
      const message = error instanceof Error ? error.message : String(error);
      const netNotReady =
        !isFormTimeout &&
        (/\b(502|503|504)\b/u.test(message) ||
          /ERR_(CONNECTION|NETWORK|HTTP2)/u.test(message) ||
          /net::/u.test(message));
      if (isFormTimeout || !netNotReady) {
        throw error;
      }
      if (exhausted) {
        throw new Error(
          `login page not ready after ${attempt} attempts: goto kept failing — ${message.slice(0, 120)}`,
          { cause: error },
        );
      }
      await page.waitForTimeout(2_000);
    }
  }
}

/** Điều khiển browser đi hết luồng login, trả contract hop cuối. */
export async function performBrowserLogin(
  page: Page,
  params: LoginFlowParams,
): Promise<LoginFlowResult> {
  // Gắn listener TRƯỚC khi điều hướng — hop cuối (callback) chỉ xảy ra một
  // lần trong luồng và không lặp lại được sau đó.
  let finalHop: { status: number; setCookie: string | undefined } | undefined;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/auth/callback') {
      finalHop = {
        status: response.status(),
        setCookie: response.headers()['set-cookie'],
      };
    }
  });

  await gotoLoginPageUntilReady(page);
  await page.getByTestId('login-email').fill(params.email);
  await page.getByTestId('login-submit').click();

  // Challenge mode `code` — OTP đã được account gửi qua transactional-mail.
  const codeForm = page.getByTestId('login-code-form');
  await expect(codeForm).toBeVisible();
  const otp = await params.readOtp();
  await page.getByTestId('login-code').fill(otp);
  await page.getByTestId('login-code-submit').click();

  // Sau verify OK, trang login relay browser qua hop `/authorize/confirm` của
  // auth rồi 302 về `/login/continue`; bấm `login-continue-target` để chạy
  // handoff push và điều hướng sang auth (consent lần đầu hoặc resume trực tiếp).
  const continueTarget = page.getByTestId('login-continue-target');
  // BFF cold start (CI): trang /login/continue có thể mất lâu hơn 15s mặc định
  // để render nút — nới timeout thay vì retry (OTP đã tiêu một challenge).
  await expect(continueTarget).toBeVisible({ timeout: 30_000 });
  await continueTarget.click();

  // BFF cold start có thể làm push handoff lỗi ở lần bấm đầu: trang render
  // thẻ lỗi với nút `login-continue-retry`. Retry ĐÚNG MỘT lần — push idempotent
  // (`event_id` từ `session_ref`, retry nhận `already_processed`), nên bấm lại
  // an toàn. Lỗi hai lần là lỗi thật — bỏ qua nó chỉ che defect.
  const retry = page.getByTestId('login-continue-retry');
  const retryOrMoved = await Promise.race([
    retry
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => 'retry' as const)
      .catch(() => 'none' as const),
    page
      .waitForURL(/\/(authorize|login\/continue)/u, { timeout: 5_000 })
      .then(() => 'navigated' as const)
      .catch(() => 'none' as const),
  ]);
  if (retryOrMoved === 'retry') {
    await retry.click();
    await expect(continueTarget).toBeVisible({ timeout: 30_000 });
  }

  // Lần đầu login ⇒ trang consent với nút approve; grant của identity tồn tại
  // qua các run (persist trong `oauth_grants`) ⇒ run sau đi path `granted`.
  // `Promise.race` chấp nhận cả hai hình dạng.
  const consentCard = page.getByTestId('consent-card');
  const backAtDestination = page.waitForURL(LANDED_PATH_PATTERN, { timeout: 30_000 });
  const consentShown = consentCard
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  // `.catch` trên backAtDestination: nếu consentShown thắng race, rejection
  // muộn của waitForURL không được trở thành unhandled rejection.
  const sawConsent = await Promise.race([
    consentShown,
    backAtDestination.then(() => false).catch(() => false),
  ]);
  if (sawConsent) {
    // Race giữa nút approve xuất hiện và trang tự điều hướng về đích: auth có
    // thể resolve grant NGAY SAU khi render card (hoặc render trang lỗi rồi
    // redirect) — nếu URL đã về đích thì KHÔNG bấm nữa, coi là path granted.
    const approve = page.getByTestId('consent-approve');
    const approveOrLanded = await Promise.race([
      approve
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => 'approve' as const)
        .catch(() => 'none' as const),
      backAtDestination.then(() => 'landed' as const).catch(() => 'none' as const),
    ]);
    if (approveOrLanded === 'approve') {
      await approve.click();

      const consentContinue = page.getByTestId('consent-continue');
      await expect(consentContinue).toBeVisible();
      await consentContinue.click();
    }
  }

  // Callback → 302 `/`: portal không có gate onboarding.
  await expect(page).toHaveURL(LANDED_PATH_PATTERN);
  if (finalHop === undefined) {
    throw new Error('login flow finished but no /api/auth/callback response was observed');
  }
  return { finalHop, finalPath: new URL(page.url()).pathname };
}
