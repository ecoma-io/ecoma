import { expect, type Locator, type Page, type Response } from '@playwright/test';

import { resolvePortalOrigin } from './local-origin';

/**
 * Luồng login browser đầy đủ của suite — quay OTP qua mail sink thật.
 *
 * Bản đồ luồng giống hệt `remote-cache-portal-e2e` (cùng issuer `auth`,
 * cùng trang login/consent của `account`) — khác biệt duy nhất là BFF đích:
 * callback `/api/auth/callback` của `pact-broker-app` đổi code lấy token,
 * insert `bff_sessions` vào `db-pact-broker-app`, set
 * `__Host-pact-broker-session` + `__Host-pact-broker-csrf`, rồi 302 về `/`
 * (portal không có gate onboarding — callback luôn đáp `/`).
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
 * `goto(origin)`). Mỗi re-entry đi path granted auto — grant đã persist,
 * KHÔNG tiêu OTP/challenge mới, không đụng rate limit — nên thêm lượt là an
 * toàn; vẫn fail thật khi cả 4 lượt đều không thấy callback (bằng chứng
 * `remote-cache-portal-e2e` run 44543816898, #461/#498: 2 lượt không đủ dưới
 * churn docker của CI).
 */
const CALLBACK_LANDING_ATTEMPTS = 4;

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
 * Điều khiển theo toàn bộ redirect chain tới trang login của account và chờ
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
  // auth rồi 302 về `/login/continue`; bấm `login-continue-target` để chạy
  // handoff push và điều hướng sang auth (consent lần đầu hoặc resume trực tiếp).
  const continueTarget = page.getByTestId('login-continue-target');
  // BFF cold start: trang /login/continue có thể mất lâu hơn 15s mặc định để
  // render nút — nới timeout thay vì retry (OTP đã tiêu một challenge).
  // Flake `ERR_NETWORK_CHANGED` trên CI (#335, run 44000010697): handoff TỰ ĐỘNG
  // (`POST /api/auth/handoff`, fire lúc mount TRƯỚC khi bấm) chết ở tầng mạng →
  // trang render thẻ lỗi với nút `login-continue-retry`; push idempotent
  // (`event_id`) nên bấm lại ĐÚNG MỘT LẦN là an toàn. Lỗi lần hai là lỗi thật.
  const retryButton = page.getByTestId('login-continue-retry');
  const continueOrRetry = await Promise.race([
    continueTarget
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'continue' as const)
      .catch(() => 'none' as const),
    retryButton
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => 'retry' as const)
      .catch(() => 'none' as const),
  ]);
  if (continueOrRetry === 'retry') {
    await retryButton.click();
    await expect(continueTarget).toBeVisible({ timeout: 30_000 });
  } else if (continueOrRetry === 'none') {
    // Cả target lẫn retry vắng mặt 30s: hop điều hướng vào `/login/continue`
    // chết tầng mạng (ERR_NETWORK_CHANGED family — instance thật ở
    // `remote-cache-portal-e2e` run 44639848365, #498; cùng trang `account`)
    // — page.url() còn giữ URL đích kèm `handle`. Điều hướng lại chính URL
    // đó: `completeHandoff` fire lúc mount và push idempotent (`event_id` từ
    // `session_ref`, auth trả `already_processed` nếu đã xử lý) — không tiêu
    // OTP/challenge mới. Chỉ MỘT lượt: cạn lần hai là lỗi thật.
    const stuckUrl = page.url();
    if (new URL(stuckUrl).pathname === '/login/continue') {
      await page.goto(stuckUrl, { waitUntil: 'load' });
      const secondChance = await Promise.race([
        continueTarget
          .waitFor({ state: 'visible', timeout: 30_000 })
          .then(() => 'continue' as const)
          .catch(() => 'none' as const),
        retryButton
          .waitFor({ state: 'visible', timeout: 30_000 })
          .then(() => 'retry' as const)
          .catch(() => 'none' as const),
      ]);
      if (secondChance === 'retry') {
        await retryButton.click();
        await expect(continueTarget).toBeVisible({ timeout: 30_000 });
      } else if (secondChance === 'none') {
        throw new Error(
          `/login/continue rendered no card even after re-navigation (${await describeStuckState(page)})`,
        );
      }
    } else {
      throw new Error(
        `login continue page never appeared after OTP verify (${await describeStuckState(page)})`,
      );
    }
  }
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
      // Flake `ERR_NETWORK_CHANGED` trên CI (#335): POST decide thất bại ở tầng
      // mạng trước khi tới server (status -1), trang render thẻ lỗi — handle
      // chưa bị tiêu thụ nên bấm lại approve an toàn, không nguy cơ double-grant.
      // Retry ĐÚNG MỘT LẦN: lỗi lần hai là lỗi thật — không che defect.
      const decideFailed = page
        .locator('[data-testid="account-result"][data-tone="danger"]')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => 'failed' as const)
        .catch(() => 'none' as const);
      const continueShown = consentContinue
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => 'continue' as const)
        .catch(() => 'none' as const);
      const outcome = await Promise.race([decideFailed, continueShown]);
      if (outcome === 'failed') {
        await page.getByTestId('consent-approve').click();
        await expect(consentContinue).toBeVisible({ timeout: 30_000 });
      } else if (outcome === 'none') {
        // Không lỗi hiện ra trong 5s: chờ nửa mặc định còn lại trước khi fail.
        await expect(consentContinue).toBeVisible({ timeout: 15_000 });
      }
      await consentContinue.click();
    }
  }

  // Callback → 302 `/`: portal không có gate onboarding. Phát hiện hop cuối qua
  // listener `finalHop`, KHÔNG qua `toHaveURL`: run 44006332081 (#335) chứng minh
  // URL có thể match trong 21ms TRƯỚC khi `chrome-error://chromewebdata/` kịp
  // render, khi hop auth→callback cuối chết `-1 net::ERR_NETWORK_CHANGED` —
  // callback không bao giờ xảy ra dù URL trông "hợp lệ".
  const origin = resolvePortalOrigin();
  let waited = await waitForCallbackOrTimeout(page, () => finalHop, CALLBACK_FIRST_WINDOW_MS);
  // Flake `ERR_NETWORK_CHANGED` ở hop redirect cuối (#335): consent đã được
  // quyết XONG phía server (grant tồn tại) và session cookie còn — `goto` lại
  // portal `/` đi path granted auto và callback xảy ra. Mỗi lượt re-entry còn
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
      await page.goto(origin, { waitUntil: 'load' });
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
  // Callback đã xảy ra — browser đứng ở `/`.
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
 * sang các suite cùng nhóm qua #498): vòng re-entry cũ chỉ `goto(origin)` —
 * hữu ích duy nhất khi auth-session + grant còn nguyên (path granted auto).
 * Hai trạng thái treo khiến chain KHÔNG BAO GIỜ tự tới callback dù lặp bao
 * nhiêu lượt:
 *
 * 1. Consent chưa decided: POST decide chết ngầm trước khi commit mà UI không
 *    kịp render thẻ lỗi (cửa sổ decideFailed 5s của flow chính bỏ lỡ) —
 *    `/authorize` thấy transaction còn `awaiting_consent` và render lại consent
 *    card; không ai bấm ⇒ mỗi lượt goto lặp đúng cảnh đó.
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
 * mount; chờ nút một-mình sẽ timeout 30s dù luồng đã thành công. Trả `true`
 * khi nút mount để bấm tiếp, `false` khi đã landed hoặc cả hai chết trong
 * budget — trường hợp sau do vòng landing quyết định (tiếp tục quan sát hoặc
 * throw kèm `describeStuckState`), không che lỗi.
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
  const states = ['consent-card', 'login-continue-retry', 'login-email-form', 'login-code-form'];
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
