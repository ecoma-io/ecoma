import { expect, type Page, type Response } from '@playwright/test';

/**
 * Luồng login browser đầy đủ của suite — quay OTP qua mail sink thật.
 *
 * ## Bản đồ luồng (đã verify từng bước trong code nguồn)
 *
 * 1. `GET /api/auth/login` (backoffice BFF) — 302 tới `GET {issuer}/authorize`
 *    kèm `__Host-backoffice-login` (Max-Age 600, Secure, HttpOnly, SameSite=Lax;
 *    `libs/backoffice-application/src/login-flow.ts`).
 * 2. `handleAuthorize` của auth (`apps/auth/src/browser-handlers.ts`) — mint
 *    binding `__Host-auth-browser`, 302 tới `{issuer}/auth?…&ecoma_x=X`.
 * 3. Provider tạo Interaction, `interactions.url` đẩy browser tới
 *    `{accountBaseUrl}/login?handle=X` (`apps/auth/src/oidc/provider.ts`).
 * 4. Trang login của account (`apps/account/app/pages/login/index.vue`):
 *    `login-email-form` → `login-email` → `login-submit` → challenge mode
 *    `code` → `login-code-form` → `login-code` → `login-code-submit` → OTP
 *    verify OK ⇒ trang relay browser qua hop `GET /authorize/confirm?handle=X`
 *    của auth (URL do BFF verify cấp, §5.1.2 hàng 7) → auth CAS
 *    `browser_confirmed` rồi 302 về `{accountBaseUrl}/login/continue?handle=X`
 *    (`apps/account/app/pages/login/continue.vue`).
 * 5. `/login/continue`: người dùng bấm nút `login-continue-target` ⇒
 *    `completeHandoff` push `/internal/session/verified` về auth và
 *    `window.location.assign` sang `continueUrl` do auth cấp.
 *    `session-verified-handler` của auth: consent chưa có ⇒
 *    `consent_required` với `continue_url` = `/consent?handle=Y`; đã grant ⇒
 *    `granted` với `continue_url` = resume URL của provider.
 *    Browser lần đầu ⇒ qua trang consent: `consent-approve` → `consent-continue`
 *    (nút relay, `apps/account/app/pages/consent.vue`) → provider resume.
 * 6. Provider cấp `code` về `redirect_uri` = `…/api/auth/callback`; callback
 *    của BFF đổi code lấy token qua `NUXT_BACKOFFICE_AUTH_INTERNAL_ORIGIN`,
 *    insert `bff_sessions`, set `__Host-backoffice-session` +
 *    `__Host-backoffice-csrf`, xoá login-flow cookie, 302 `/`
 *    (onboarding redirect không kích hoạt local vì `ACCOUNT_SERVICE` binding
 *    không được cấp cho container Node — `accountClientConfig` trả `null`).
 *
 * Helper KHÔNG assert chi tiết contract từng redirect — việc đó thuộc các test
 * contract chạy bằng request Node; helper chỉ điều khiển UI cho đến khi
 * browser đứng ở `/` của backoffice với session cookie. Hàm trả chuỗi
 * `Set-Cookie` nhìn thấy được ở hop cuối (callback → `/`) để test assert
 * contract ngay hop đó thay vì đọc lại từ browser context (cookie HttpOnly
 * đọc được qua `context.cookies`, nhưng hop contract là bằng chứng sát server hơn).
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
   * Status + `Set-Cookie` của hop CUỐI (callback 302 `/`): bằng chứng contract
   * hop cuối của callback, lấy từ response listener gắn trước khi điều hướng.
   */
  readonly finalHop: { readonly status: number; readonly setCookie: string | undefined };
}

/**
 * Số lần điều hướng lại tối đa khi đích đến chưa sẵn sàng, và tổng ngân sách
 * thời gian cho toàn bộ vòng — cùng hợp đồng "retry chỉ cho chữ ký chưa sẵn
 * sàng" của gate (`global-setup.ts`): 404 Go-mux (Traefik chưa có router cho
 * host — cửa sổ đăng ký router sau `pulumi up` thấy thật ở run CI
 * 40920298937/40924766746), 502/503/504 (upstream chưa vào config), lỗi
 * navigation net (ECONNRESET khi container restart). Mọi hình dạng khác là
 * lỗi thật — không thử lại.
 */
const NAVIGATION_RETRIES = 5;
const NAVIGATION_BUDGET_MS = 45_000;

/**
 * Trang chết "chưa sẵn sàng" mà browser đang đứng — đọc từ status của response
 * ĐÍCH và nội dung body.
 *
 * ⚠️ `page.goto` resolve BÌNH THƯỜNG với mọi HTTP status: đáp xuống trang 404
 * KHÔNG phải navigation error, exception nào cũng không mang chữ ký — chữ ký
 * nằm trong NỘI DUNG TRANG (run 40924766746: 3 test đỏ cùng trang Go 404
 * trong khi vòng retry cũ chỉ đọc message của exception, 0 lần thử lại). Hai
 * kênh cùng lúc: status của response cuối redirect chain (404/502/503/504) và
 * body text Go-mux (`404 page not found` — bắt đúng khi goto resolve ở hop
 * 302 trung gian mà response object không phản ánh đích cuối).
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
 * Vì sao phải retry ở tầng ĐIỀU HƯỚNG chứ không phải tầng expect: khi Traefik
 * chưa có router cho `auth.<root>`, browser đứng yên trên trang Go 404 (`404
 * page not found`) — page đã `load` xong và sẽ KHÔNG BAO GIỜ fetch lại, nên
 * việc chờ form trên trang đó chỉ hết thời gian mà không có request nào mới.
 * Retry đúng nghĩa phải `goto` LẠI: mỗi lần thử là một authorize request mới
 * (state/code_challenge mới do BFF cấp — hợp lệ vì request trước chưa tạo
 * interaction nào).
 *
 * Hai kênh fail chia MỘT budget: (1) trang chết — phát hiện qua status/body
 * NGAY SAU goto, trước khi chờ form; (2) goto ném lỗi net thật (`net::`,
 * `ERR_*`, 5xx trong message). Chờ form timeout trên trang KHÔNG chết là bug
 * thật (trang khỏe, DOM sai) — fail tức thời, không retry.
 */
async function gotoLoginPageUntilReady(page: Page): Promise<void> {
  const emailForm = page.getByTestId('login-email-form');
  const deadline = Date.now() + NAVIGATION_BUDGET_MS;
  for (let attempt = 1; ; attempt += 1) {
    const exhausted = attempt >= NAVIGATION_RETRIES || Date.now() >= deadline;
    try {
      // Điểm vào duy nhất: BFF dựng authorize URL (URL login do server dựng).
      const response = await page.goto('/api/auth/login', { waitUntil: 'load' });
      // Trang login của account nhận browser sau hai redirect (auth glue →
      // provider → interaction URL). Form email là bước đầu của interaction —
      // nhưng chỉ chờ khi trang KHÔNG phải trang chết cold-start.
      const dead = await isDeadGatewayPage(page, response);
      if (dead !== undefined) {
        if (exhausted) {
          // Ném lỗi MỚI mang tín hiệu cuối cùng, không phải TimeoutError trần —
          // người đọc log phải thấy ngay lý do "chưa sẵn sàng".
          throw new Error(`login page not ready after ${attempt} attempts: ${dead}`);
        }
        await page.waitForTimeout(2_000);
        continue;
      }
      await emailForm.waitFor({ state: 'visible', timeout: 15_000 });
      return;
    } catch (error) {
      // Kênh goto-net: lỗi ném ra TỪ goto (không phải TimeoutError của form —
      // lỗi đó chỉ xảy ra sau khi trang đã qua bước kiểm trang chết ⇒ bug thật).
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
      // Ngắn hơn expect timeout của trang chết — tổng budget do vòng giữ.
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
  // auth rồi 302 về `/login/continue` (§5.1.2 hàng 7); tiếp tục phải qua nút
  // relay của trang đó — bấm `login-continue-target` để chạy handoff push và
  // điều hướng sang auth (consent lần đầu hoặc resume trực tiếp).
  const continueTarget = page.getByTestId('login-continue-target');
  await expect(continueTarget).toBeVisible();
  await continueTarget.click();

  // Lần đầu login ⇒ trang consent với nút approve; nhưng grant của identity
  // tồn tại qua các run (persist trong `oauth_grants`) ⇒ run sau đi path
  // `granted` — handoff trả resume URL và browser về `/` TRỰC TIẾP, không qua
  // consent. `Promise.race` chấp nhận cả hai hình dạng: thấy consent card thì
  // đi đủ approve → continue, không thấy (đã về `/`) thì đi thẳng.
  const consentCard = page.getByTestId('consent-card');
  const backAtHome = page.waitForURL(/\/$/u, { timeout: 30_000 });
  const consentShown = consentCard
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  const sawConsent = await Promise.race([consentShown, backAtHome.then(() => false)]);
  if (sawConsent) {
    await page.getByTestId('consent-approve').click();

    // Nút relay `consent-continue` xuất hiện sau quyết định — bấm để provider
    // resume và cấp code về callback.
    const consentContinue = page.getByTestId('consent-continue');
    await expect(consentContinue).toBeVisible();
    await consentContinue.click();
  }

  // Callback → 302 `/`; browser đổ về overview của backoffice với session.
  await expect(page).toHaveURL(/\/$/u);
  if (finalHop === undefined) {
    throw new Error('login flow finished but no /api/auth/callback response was observed');
  }
  return { finalHop };
}
