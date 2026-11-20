import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { waitForContinueTargetAfterOtpVerify } from '@ecoma-io/system-tests-support';

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
 *    `__Host-backoffice-csrf`, xoá login-flow cookie, rồi 302:
 *    - `/onboarding` khi session CHƯA có display name ở `account` (gate
 *      onboarding của #325/#242 — server quyết định, không phải client);
 *    - `/` khi session ĐÃ có display name.
 *    Trước #242, container Node local không có binding `ACCOUNT_SERVICE` ⇒
 *    `accountClientConfig` trả `null` ⇒ gate luôn mềm ⇒ mọi phiên đáp `/`;
 *    nay CẢ HAI đích đều là hành vi đúng, nên helper chấp nhận cả hai và
 *    trả `finalPath` để test assert đúng nhánh mình đang chứng minh.
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
   * Status + `Set-Cookie` của hop CUỐI (callback 302): bằng chứng contract
   * hop cuối của callback, lấy từ response listener gắn trước khi điều hướng.
   */
  readonly finalHop: { readonly status: number; readonly setCookie: string | undefined };
  /**
   * Path mà browser đứng sau khi callback 302 — `/` khi user đã có display name,
   * `/onboarding` khi chưa (gate onboarding của #325/#242 quyết định ở server).
   */
  readonly finalPath: string;
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
 * Hai đích hợp lệ sau khi callback 302 — `/` (đã có display name) và
 * `/onboarding` (chưa có tên ⇒ gate onboarding của #325/#242 điều hướng).
 *
 * ⚠️ Pattern này là **đường đích của phiên**, không phải "bất cứ đâu trong
 * app": `/$` khớp đúng `/` (không khớp `/onboarding`), `/\/onboarding$/` khớp
 * đúng `/onboarding`. Trước #242, account không trả lời được local ⇒ gate luôn
 * mềm ⇒ mọi phiên đáp `/`; nay nhánh `/onboarding` là hành vi ĐÚNG, nên helper
 * phải chấp nhận cả hai — còn `performBrowserLogin` trả `finalPath` để test
 * assert CHÍNH NHÁNH mình muốn chứng minh.
 */
const LANDED_PATH_PATTERN = /(?:\/$|\/onboarding$)/u;

/**
 * Cửa sổ quan sát callback lần đầu — ngắn để phân biệt nhanh "chậm" với
 * "chết"; các lượt re-entry sau dùng cửa sổ dài hơn.
 */
const CALLBACK_FIRST_WINDOW_MS = 5_000;
/**
 * Cửa sổ quan sát callback mỗi lượt re-entry — BFF/auth lạnh trên CI runner
 * hosted (VM mới mỗi run) có thể chậm hơn 5s mà KHÔNG chết.
 */
const CALLBACK_REENTRY_WINDOW_MS = 15_000;
/**
 * Tổng số lượt chốt landing callback (1 lần đầu + 3 lượt re-entry qua
 * `goto`). Mỗi re-entry đi path granted auto — grant đã persist, KHÔNG tiêu
 * OTP/challenge mới, không đụng rate limit — nên thêm lượt là an toàn; vẫn
 * fail thật khi cả 4 lượt đều không thấy callback (bằng chứng
 * `remote-cache-portal-e2e` run 44543816898, #461/#498: 2 lượt không đủ dưới
 * churn docker của CI).
 */
const CALLBACK_LANDING_ATTEMPTS = 4;

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

  // Flake `ERR_NETWORK_CHANGED` trên CI (run 44069058685): POST challenge chết
  // ở tầng mạng trước khi tới server → trang render `login-request-failed` và
  // GIỮ NGUYÊN form email (`challenge` không được set). Challenge chưa được cấp
  // nên bấm submit lại ĐÚNG MỘT LẦN là an toàn (rate limit 3 challenge/15 phút
  // không bị tiêu). Lỗi lần hai là lỗi thật — không che defect.
  const codeForm = page.getByTestId('login-code-form');
  const requestFailed = page.getByTestId('login-request-failed');
  const challengeShown = codeForm
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  const challengeFailed = requestFailed
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (await Promise.race([challengeShown, challengeFailed])) {
    if (!(await challengeShown)) {
      await page.getByTestId('login-submit').click();
    }
  }
  await expect(codeForm).toBeVisible();
  const otp = await params.readOtp();
  await page.getByTestId('login-code').fill(otp);
  await page.getByTestId('login-code-submit').click();

  // Sau verify OK, trang login relay browser qua hop `/authorize/confirm` của
  // auth rồi 302 về `/login/continue` (§5.1.2 hàng 7); tiếp tục phải qua nút
  // relay của trang đó — bấm `login-continue-target` để chạy handoff push và
  // điều hướng sang auth (consent lần đầu hoặc resume trực tiếp).
  const continueTarget = page.getByTestId('login-continue-target');
  // BFF cold start (CI): trang /login/continue có thể mất lâu hơn timeout mặc
  // định để render nút. Flake `ERR_NETWORK_CHANGED` trên CI (#335, run
  // 44000010697 — cùng hình ở các suite cùng nhóm): handoff TỰ ĐỘNG
  // (`POST /api/auth/handoff`, fire lúc mount TRƯỚC khi bấm) chết ở tầng mạng →
  // trang render thẻ lỗi với nút `login-continue-retry`; push idempotent
  // (`event_id`) nên bấm lại ĐÚNG MỘT LẦN là an toàn. Lỗi lần hai là lỗi thật.
  const retryButton = page.getByTestId('login-continue-retry');
  // Hợp đồng recovery của pha chờ sau verify (#461 round 2) — dùng chung của
  // 4 suite, tài liệu đầy đủ sống ở `@ecoma-io/system-tests-support`.
  await waitForContinueTargetAfterOtpVerify(page, {
    continueTarget,
    retryButton,
    requestFailed,
    describeStuckState: () => describeStuckState(page),
  });
  await continueTarget.click();

  // Lần đầu login ⇒ trang consent với nút approve; nhưng grant của identity
  // tồn tại qua các run (persist trong `oauth_grants`) ⇒ run sau đi path
  // `granted` — handoff trả resume URL và browser về trang đích TRỰC TIẾP,
  // không qua consent. `Promise.race` chấp nhận cả hai hình dạng: thấy consent
  // card thì đi đủ approve → continue, không thấy (đã về đích) thì đi thẳng.
  const consentCard = page.getByTestId('consent-card');
  const backAtDestination = page.waitForURL(LANDED_PATH_PATTERN, { timeout: 30_000 });
  const consentShown = consentCard
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  const sawConsent = await Promise.race([consentShown, backAtDestination.then(() => false)]);
  if (sawConsent) {
    await page.getByTestId('consent-approve').click();

    // Nút relay `consent-continue` xuất hiện sau quyết định — bấm để provider
    // resume và cấp code về callback.
    const consentContinue = page.getByTestId('consent-continue');
    await expect(consentContinue).toBeVisible();
    await consentContinue.click();
  }

  // Callback → 302: browser đổ về `/` (đã có display name) HOẶC `/onboarding`
  // (chưa có — gate onboarding của #325/#242 quyết định ở server, không ở
  // client). Trước #242, account không trả lời được local ⇒ gate luôn mềm ⇒
  // mọi phiên đáp `/`; nay nhánh `/onboarding` là hành vi ĐÚNG và bắt buộc,
  // nên helper chấp nhận CẢ HAI đích. Phát hiện hop cuối qua listener
  // `finalHop`, KHÔNG qua `toHaveURL` trước: URL có thể match trong 21ms
  // TRƯỚC khi `chrome-error://chromewebdata/` kịp render, khi hop auth→callback
  // cuối chết `-1 net::ERR_NETWORK_CHANGED` (bằng chứng `remote-cache-portal-e2e`
  // run 44006332081, #335) — callback không bao giờ xảy ra dù URL trông "hợp lệ".
  let waited = await waitForCallbackOrTimeout(page, () => finalHop, CALLBACK_FIRST_WINDOW_MS);
  // Flake `ERR_NETWORK_CHANGED` ở hop redirect cuối (#335): consent đã được
  // quyết XONG phía server (grant tồn tại) và session cookie còn — `goto` lại
  // điểm vào BFF đi path granted auto và callback xảy ra. Mỗi lượt re-entry còn
  // tiến hoá trạng thái treo trước khi điều hướng (consent undecided, handoff
  // chưa xong — `resumeStuckLoginState`); goto bị bỏ qua ở lượt vừa resume để
  // không cắt ngang redirect chain đang chạy. Re-entry là idempotent (không OTP
  // mới, không challenge, không rate limit) nên vòng bị chặn trên
  // CALLBACK_LANDING_ATTEMPTS lượt thay vì đúng một: dưới churn docker của CI
  // hosted (VM mới mỗi run), HAI lượt liên tiếp chết là xác suất thực (bằng
  // chứng `remote-cache-portal-e2e` run 44543816898, #461/#498). Cạn vòng vẫn
  // throw — lỗi thật không bị che.
  for (let attempt = 1; !waited && attempt < CALLBACK_LANDING_ATTEMPTS; attempt += 1) {
    // Element có thể detach giữa isVisible và click khi redirect chain hoàn tất
    // đúng lúc đó — lỗi đó do vòng xử lý: callback sắp được quan sát, còn nếu
    // không thì cạn vòng vẫn throw kèm describeStuckState (không che lỗi thật).
    let resumed: string | undefined;
    try {
      resumed = await resumeStuckLoginState(page);
    } catch {
      resumed = undefined;
    }
    if (resumed === undefined) {
      await page.goto('/api/auth/login', { waitUntil: 'load' });
    }
    waited = await waitForCallbackOrTimeout(page, () => finalHop, CALLBACK_REENTRY_WINDOW_MS);
  }
  if (!waited) {
    throw new Error(
      `login flow finished but no /api/auth/callback response was observed (${await describeStuckState(page)})`,
    );
  }
  if (finalHop === undefined) {
    // Không thể xảy ra sau `waited === true` — bước kiểm cho TS thu hẹp kiểu.
    throw new Error('callback observed but finalHop is undefined');
  }
  // Callback đã xảy ra — browser đứng ở đích của BFF.
  await expect(page).toHaveURL(LANDED_PATH_PATTERN, { timeout: 5_000 });
  return { finalHop, finalPath: new URL(page.url()).pathname };
}

/**
 * Tiến hoá một trạng thái treo của browser về phía callback — trả mô tả hành
 * động đã làm, hoặc `undefined` khi trang không ở trạng thái treo nào nhận
 * diện được (browser đang đi path granted auto, chỉ cần điều hướng lại).
 *
 * Root cause của chữ ký "login flow finished but no /api/auth/callback
 * response was observed" (5 instance ở `remote-cache-portal-e2e`, #461; port
 * sang các suite cùng nhóm qua #498): vòng re-entry cũ chỉ `goto` — hữu ích
 * duy nhất khi auth-session + grant còn nguyên (path granted auto). Hai trạng
 * thái treo khiến chain KHÔNG BAO GIỜ tự tới callback dù lặp bao nhiêu lượt:
 *
 * 1. Consent chưa decided: POST decide chết ngầm trước khi commit mà UI không
 *    kịp render thẻ lỗi — `/authorize` thấy transaction còn `awaiting_consent`
 *    và render lại consent card; không ai bấm ⇒ mỗi lượt goto lặp đúng cảnh đó.
 * 2. Handoff push chưa xong: trang `/login/continue` render thẻ lỗi với nút
 *    retry sau khi cửa sổ retry 5s của flow chính đã qua.
 *
 * Cả hai action đều idempotent, cùng nền tảng với các retry một-lượt của flow
 * chính: handoff push idempotent theo `event_id`; decide replay an toàn —
 * `event_id` deterministic `consent:<decision>:<transaction_id>` của auth
 * (`apps/auth/src/consent-handler.ts`) nhận ra quyết định đã commit qua
 * `replayOrReject`, không double-grant.
 */
async function resumeStuckLoginState(page: Page): Promise<string | undefined> {
  const continueRetry = page.getByTestId('login-continue-retry');
  if (await isVisibleSafe(continueRetry)) {
    await continueRetry.click();
    if (await waitForContinueOrLanded(page, page.getByTestId('login-continue-target'))) {
      // Target mount ⇒ push đã thành công và đang chờ nút của người dùng —
      // bấm để chain chạy tiếp tới callback; landed thắng ⇒ callback đã xảy ra.
      await page.getByTestId('login-continue-target').click();
    }
    return 'clicked login-continue-retry';
  }
  const consentCard = page.getByTestId('consent-card');
  if (await isVisibleSafe(consentCard)) {
    await page.getByTestId('consent-approve').click();
    const consentContinue = page.getByTestId('consent-continue');
    if (await waitForContinueOrLanded(page, consentContinue)) {
      await consentContinue.click();
    }
    return 're-approved undecided consent';
  }
  return undefined;
}

/** isVisible không ném khi element biến mất giữa chờ — trả `false`. */
async function isVisibleSafe(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

/**
 * Race giữa nút continue mount và trang tự về đích — auth resolve grant ngay
 * sau khi render card là hành vi thật, callback có thể xảy ra TRƯỚC khi nút
 * mount; chờ nút một-mình sẽ timeout dù luồng đã thành công. Trả `true` khi
 * nút mount để bấm tiếp, `false` khi đã landed hoặc cả hai chết trong budget
 * — trường hợp sau do vòng landing quyết định (tiếp tục quan sát hoặc throw
 * kèm `describeStuckState`), không che lỗi.
 */
async function waitForContinueOrLanded(page: Page, target: Locator): Promise<boolean> {
  return Promise.race([
    target
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false),
    page
      .waitForURL(LANDED_PATH_PATTERN, { timeout: 30_000 })
      .then(() => false)
      .catch(() => false),
  ]);
}

/** Mô tả trạng thái trang lúc cạn vòng — dữ liệu đo được cho instance sau. */
async function describeStuckState(page: Page): Promise<string> {
  const states = [
    'consent-card',
    'login-continue-retry',
    'login-email-form',
    'login-code-form',
    // Ba trạng thái kết quả của submit mã — instance round-2 của #461 (6–10)
    // chỉ báo được `login-code-form` nên không phân loại được nguyên nhân; thêm
    // để log stuck-state phân biệt ngay: request-failed (verify chết tầng mạng,
    // mã chưa tiêu), code-invalid (OTP sai), code-accepted (verify OK nhưng
    // hop confirm chết).
    'login-request-failed',
    'login-code-invalid',
    'login-code-accepted',
  ];
  const visible: string[] = [];
  for (const testId of states) {
    if (await isVisibleSafe(page.getByTestId(testId))) {
      visible.push(testId);
    }
  }
  return `url=${page.url()} visible=[${visible.join(', ')}]`;
}

/** Chờ callback `/api/auth/callback` được quan sát trong `budgetMs`. */
async function waitForCallbackOrTimeout(
  page: Page,
  observed: () => { status: number; setCookie: string | undefined } | undefined,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (observed() !== undefined) {
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}
