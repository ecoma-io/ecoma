import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Ngân sách recovery MỖI LOẠI của vòng chờ: resend cho `login-code-invalid` và
 * re-click cho `login-request-failed` — mỗi loại ĐÚNG MỘT lần. Hai nhánh
 * recovery trong vòng là nơi ngân sách này được tiêu (cờ `invalidRecovered`
 * và điều kiện lượt verify đầu).
 */
export const MAX_RECOVERY_PER_TYPE = 1;

/**
 * Số lượt chờ tối đa của pha sau khi bấm `login-code-submit` = 1 lượt verify
 * đầu + mỗi loại recovery đúng một lần (derivation dưới). Cứng thay vì vòng
 * tự do: mọi nhánh trong vòng chỉ được `return` (thành công) hoặc throw; cạn
 * ngân sách là lỗi thật.
 */
export const MAX_VERIFY_ATTEMPTS = 1 + 2 * MAX_RECOVERY_PER_TYPE;

/**
 * Số lượt resend TỐI ĐA của nhánh `login-code-invalid` — một resend THÀNH CÔNG
 * (challenge mới + mail mới) cộng các lượt bị cooldown chặn im lặng. Product
 * chặn resend trong 60s kể từ challenge gần nhất (`OTP_RESEND_COOLDOWN_SECONDS`,
 * `apps/account/server/lib/otp.ts` — chặn về 204, không mail mới, không tiêu
 * rate limit); 6 lượt với gap 10s cầu được trần 60s đó từ mọi thời điểm nhập
 * nhánh. Challenge THẬT được cấp tối đa 2 (lượt đầu + resend khi cooldown đã
 * hết) — ≤ `OTP_RATE_LIMIT_SHORT_MAX` = 3/15 phút; các lượt bị chặn không đếm.
 */
export const MAX_RESEND_ATTEMPTS = 6;

/** Nghỉ giữa hai lượt resend khi `readOtp` còn trả mã cũ (cooldown chưa hết). */
export const RESEND_RETRY_GAP_MS = 10_000;

/** Lượt verify đầu — duy nhất cho phép nhánh re-click `login-request-failed`. */
const INITIAL_VERIFY_ATTEMPT = 1;

/** isVisible không ném khi element biến mất giữa chờ — trả `false`. */
function isVisibleSafe(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

/**
 * Lỗi race điều hướng — element/context bị navigation đang chạy phá giữa chừng
 * (redirect chain hoàn tất đúng lúc click). ChỈ giá trị `Error` (hoặc kế thừa
 * Error, ví dụ DOMException) có message khớp chữ ký được nhận; giá trị thô
 * non-Error luôn bị loại — truyền nhầm đối số phải surfaced, không được nuốt.
 * Chỉ các chữ ký này được nuốt khi retry path đã có vòng phía sau xử lý; mọi
 * lỗi khác (timeout, element không tìm thấy, frame detached...) là lỗi thật.
 */
export function isNavigationRaceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /element was detached from the DOM|Execution context was destroyed|Target page, context or browser has been closed|Target closed/u.test(
      error.message,
    )
  );
}

/**
 * Trang chết của browser — UI product mất hẳn (instance 11 #461: run
 * 44693545849, `url=chrome-error://chromewebdata/ visible=[]` khi navigation
 * chết tầng mạng). CHỈ `chrome-error:` và `data:` (trang rỗng lì) được coi là
 * chết; `about:blank` là trạng thái mid-navigation nhất thời giữa các redirect
 * và VẪN có thể mount element — nhầm nó thành chết chỉ tốn một re-login
 * bounded, nhưng phân loại đúng thì vòng chờ tự settle. Chuỗi không parse được
 * coi là chết (không xác định ⇒ không chờ mù); URL vẫn vào `describeStuckState`
 * ở nhánh throw.
 */
function isDeadBrowserPage(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'chrome-error:' || protocol === 'data:';
  } catch {
    return true;
  }
}

/** Pathname của URL, trả `undefined` khi chuỗi không parse được — không crash. */
function safePathname(url: string): string | undefined {
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

/** Các element và dữ liệu chẩn đoán mà pha chờ cần từ suite sở hữu trang. */
export interface OtpVerifyRecoveryParams {
  /** Nút relay của `/login/continue` — đích thành công của pha này. */
  readonly continueTarget: Locator;
  /** Nút retry của thẻ lỗi handoff (`login-continue-retry`). */
  readonly retryButton: Locator;
  /** Thẻ lỗi request (`login-request-failed`) trên trang login của account. */
  readonly requestFailed: Locator;
  /**
   * Mô tả trạng thái trang lúc chết — suite sở hữu (tập test id và URL là của
   * từng suite); giá trị chỉ vào message throw để log phân loại được nguyên nhân.
   */
  readonly describeStuckState: () => Promise<string>;
  /**
   * Đọc OTP tươi từ mail sink — bật recovery cho `login-code-invalid` (instance
   * 13 #461, run 44705889280). Vắng mặt ⇒ state đó không có recovery (hành vi
   * cũ) — helper không tự biết đọc mã.
   */
  readonly readOtp?: () => Promise<string>;
  /**
   * Mã OTP mà caller VỪA nộp ở lượt verify trước khi vào helper (`oidc-flow`
   * đọc từ mail sink rồi `fill` + `login-code-submit`). Là mốc so sánh của vòng
   * resend: `readOtp` trả mã "mới nhất trong cửa sổ 60s" nên resend bị cooldown
   * chặn (204 im lặng, không mail mới) hoặc mail mới chưa kịp render vẫn trả
   * lại mã CŨ — nộp lại mã cũ là 400 chắc chắn. Vắng mặt ⇒ vòng resend giữ
   * hành vi cũ: đúng một lượt resend + đọc + nộp.
   */
  readonly submittedOtp?: string;
  /**
   * Recovery re-login đầy đủ cho trang chết (`chrome-error://…`, `data:`, URL
   * không parse được) — suite sở hữu vì chỉ nó biết entry URL tuyệt đối và tham
   * số login. Hợp đồng: đưa browser trở lại trạng thái `continueTarget` ĐÃ
   * mount nhưng CHƯA bấm — caller tiếp tục bằng hành động kế tiếp vốn có của
   * mình (click target). Vắng mặt ⇒ trang chết không có recovery (hành vi cũ).
   */
  readonly recoverFromDeadPage?: () => Promise<void>;
}

/**
 * Chờ card continue mount sau khi bấm `login-code-submit`, kèm recovery có
 * điều kiện cho chết tầng mạng của pha này — hợp đồng dùng chung của 4 suite
 * e2e đi luồng OIDC browser (#461), mỗi nhánh dựa trên tính idempotent của thao
 * tác nó bấm lại:
 *
 * 1. `login-continue-retry` hiện trước `login-continue-target` trong cửa sổ
 *    30s — handoff push TỰ ĐỘNG lúc mount chết tầng mạng (#335, run
 *    44000010697); push idempotent theo `event_id` nên bấm lại ĐÚNG MỘT LẦN
 *    là an toàn, rồi chờ target mount.
 * 2. Cả hai nút vắng mặt mà `page.url()` còn ở `/login/continue` — hop điều
 *    hướng vào trang chết tầng mạng (ERR_NETWORK_CHANGED family — instance
 *    thật `remote-cache-portal-e2e` run 44639848365, #498): điều hướng lại
 *    chính URL đó (`completeHandoff` fire lúc mount, push idempotent theo
 *    `event_id` từ `session_ref` — auth trả `already_processed`, không tiêu
 *    OTP/challenge mới) rồi cho một cơ hội thứ hai; cạn cơ hội ⇒ throw.
 * 3. `login-code-invalid` hiển thị VÀ có `readOtp` — server ĐÃ trả lời verify
 *    bằng 400, tức POST tới nơi rồi: mã sai thật, hoặc mã ĐÃ tiêu thụ ở POST
 *    trước (verify thành công nhưng response chết — instance 13 #461, run
 *    44705889280; cùng họ run 44784071601: re-click `login-code-submit` của
 *    nhánh 4 nộp LẠI đúng mã cũ và nhận `no_active_challenge`; UI không phân
 *    biệt được các reason nên nhánh recovery vẫn bounded cho tất cả). Recovery:
 *    bấm `login-resend` rồi đọc OTP từ mail sink (`readOtp` trả mail mới nhất
 *    trong cửa sổ 60s — `readOtpFromMailSink` ORDER BY `created_at` DESC), với
 *    vòng freshness khi caller truyền `submittedOtp`: resend bị cooldown 60s
 *    chặn là 204 im lặng KHÔNG có mail mới (chính `challenge.post.ts` bảo đảm)
 *    nên lần đọc đầu vẫn trả mã cũ — so với `submittedOtp`, trùng mã ⇒ nghỉ
 *    `RESEND_RETRY_GAP_MS` rồi resend lại, tối đa `MAX_RESEND_ATTEMPTS` lượt
 *    (cầu được trần cooldown từ mọi thời điểm nhập nhánh). Ngưỡng an toàn (hằng
 *    số thật `apps/account/server/lib/otp.ts`): challenge THẬT cấp thêm ≤ 1 ⇒
 *    tổng 2 ≤ `OTP_RATE_LIMIT_SHORT_MAX` = 3/15 phút — lượt bị cooldown chặn
 *    không đếm và không tiêu rate limit; cạn ngân sách resend vẫn nộp mã đọc
 *    được cuối (thêm một 400 vô hại, trần `MAX_OTP_ATTEMPTS` = 5 của challenge)
 *    rồi vòng lặp chính throw stuck-state — không treo, không che defect.
 * 4. `login-request-failed` hiển thị (KHÔNG kèm `login-code-invalid`) ở lượt
 *    verify đầu — POST verify chết tầng mạng trước khi nhận response; mã CHƯA
 *    tiêu thụ cho lỗi ném (chính trang `login/index.vue` bảo đảm điều đó) nên
 *    bấm `login-code-submit` lại ĐÚNG MỘT LẦN rồi lặp pha chờ (bằng chứng
 *    #461 round 2: instances 6–10). Sub-case response chết SAU khi server đã
 *    xử lý (status -1 với challenge đã consume — run 44784071601): re-click
 *    nhận 400, trang giữ form kèm `login-code-invalid` — round-trip được nuốt
 *    (xem `awaitSubmitRoundTrip`) và lượt kế đi vào nhánh 3. Lượt hai chết là
 *    lỗi thật.
 * 5. URL là trang chết (`chrome-error://…`, `data:`, không parse được) VÀ có
 *    `recoverFromDeadPage`
 *    — UI product mất hẳn, không element nào chờ được nữa (instance 11 #461):
 *    gọi recovery re-login ĐÚNG MỘT LẦN rồi kết thúc pha (caller tự click
 *    target theo hợp đồng của closure).
 * 6. Còn lại — `login-code-accepted` (verify OK nhưng hop confirm chết) hay
 *    bất kỳ state khác KHÔNG có recovery: throw ngay kèm `describeStuckState`.
 *    Sub-case run 44784071601 (lượt 2, trình tự consent → callback chết
 *    "Failed to fetch" trên `/authorize`) thuộc nhóm này ở pha landing của
 *    `performBrowserLogin`, không ở pha này.
 *
 * Hàm chỉ điều khiển pha chờ; caller bấm `login-continue-target` khi hàm trả về.
 */
export async function waitForContinueTargetAfterOtpVerify(
  page: Page,
  params: OtpVerifyRecoveryParams,
): Promise<void> {
  const { continueTarget, retryButton, requestFailed, describeStuckState } = params;
  const codeInvalid = page.getByTestId('login-code-invalid');
  /** isVisible không ném khi element biến mất giữa chờ — trả `false`. */
  const errorRendered = async (): Promise<boolean> =>
    (await isVisibleSafe(codeInvalid)) || (await isVisibleSafe(requestFailed));
  // Chờ vòng đời submit kết thúc sau mỗi lần bấm `login-code-submit` lại:
  // form mã rời DOM khi navigation bắt đầu — không có bước này, lặp kế tiếp có
  // thể đọc DOM cũ của POST trước trong khi POST mới còn đang xử lý. Ba lối ra:
  // (1) form ẩn — navigation bắt đầu, round-trip xong; (2) lỗi race điều hướng
  // được nuốt (context bị navigation phá giữa chừng — vô hại, lặp kế tiếp vẫn
  // chờ trên element mới); (3) timeout NHƯNG thẻ lỗi đang render — POST đã
  // hoàn tất bằng 400 (`no_active_challenge`/`code_mismatch` — run 44784071601,
  // PR #549: verify đầu chết -1 sau khi server consume challenge, re-click của
  // nhánh 4 nhận 400 và trang chủ động GIỮ form kèm `login-code-invalid`,
  // KHÔNG có navigation nào để ẩn form) — nuốt để vòng lặp phân loại (branch
  // resend / throw stuck-state), không phải chết bằng TimeoutError trước khi
  // recovery kịp chạy. Không thẻ lỗi nào ⇒ POST chưa hoàn tất — timeout là lỗi
  // thật, rethrow.
  const codeForm = page.getByTestId('login-code-form');
  // Số race điều hướng đã nuốt ở round-trip — không tự throw nhưng KHÔNG được
  // ẩn: cạn ngân sách mà counter > 0 nghĩa là navigation phá submit lặp lại,
  // count đi vào message throw kèm stuck state để chẩn đoán flake.
  let swallowedRoundTripRaces = 0;
  const awaitSubmitRoundTrip = async (): Promise<void> => {
    await codeForm.waitFor({ state: 'hidden', timeout: 15_000 }).catch(async (error: unknown) => {
      if (isNavigationRaceError(error)) {
        swallowedRoundTripRaces += 1;
        return;
      }
      if (await errorRendered()) {
        return;
      }
      throw error;
    });
  };
  // Resend đến khi `readOtp` trả mã KHÁC mã đã nộp — resend bị cooldown chặn
  // (204 im lặng, `challenge.post.ts`) không sinh mail mới nên lần đọc đầu vẫn
  // trả mã cũ; bấm lại sau một gap cho tới khi challenge mới thật được cấp và
  // mail mới thắng phép đọc ORDER BY `created_at` DESC. Cạn ngân sách vẫn trả
  // mã đọc được cuối: lượt nộp sau chỉ thêm một 400 vô hại (attempt trần 5 của
  // challenge), vòng lặp chính throw stuck-state có chẩn đoán — không treo,
  // không che defect. Không có `submittedOtp` (mọi mã đều ≠ undefined) ⇒ vòng
  // dừng sau lượt đầu — hành vi cũ của instance 13 giữ nguyên.
  const readFreshOtpAfterResend = async (readOtp: () => Promise<string>): Promise<string> => {
    for (let resendAttempt = 0; ; resendAttempt += 1) {
      await page.getByTestId('login-resend').click();
      const otp = await readOtp();
      if (otp !== params.submittedOtp || resendAttempt >= MAX_RESEND_ATTEMPTS) {
        return otp;
      }
      await page.waitForTimeout(RESEND_RETRY_GAP_MS);
    }
  };
  let invalidRecovered = false;
  for (let verifyAttempt = 1; verifyAttempt <= MAX_VERIFY_ATTEMPTS; verifyAttempt += 1) {
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
      return;
    }
    if (continueOrRetry === 'continue') {
      return;
    }
    const stuckUrl = page.url();
    if (safePathname(stuckUrl) === '/login/continue') {
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
          `/login/continue rendered no card even after re-navigation (${await describeStuckState()})`,
        );
      }
      return;
    }
    if (!invalidRecovered && params.readOtp !== undefined && (await isVisibleSafe(codeInvalid))) {
      invalidRecovered = true;
      const freshOtp = await readFreshOtpAfterResend(params.readOtp);
      await page.getByTestId('login-code').fill(freshOtp);
      await page.getByTestId('login-code-submit').click();
      await awaitSubmitRoundTrip();
      continue;
    }
    if (verifyAttempt === INITIAL_VERIFY_ATTEMPT && (await isVisibleSafe(requestFailed))) {
      await page.getByTestId('login-code-submit').click();
      await awaitSubmitRoundTrip();
      continue;
    }
    if (params.recoverFromDeadPage !== undefined && isDeadBrowserPage(stuckUrl)) {
      await params.recoverFromDeadPage();
      return;
    }
    const raceNote =
      swallowedRoundTripRaces > 0
        ? `; swallowed submit round-trip races: ${swallowedRoundTripRaces}`
        : '';
    throw new Error(
      `login continue page never appeared after OTP verify${raceNote} (${await describeStuckState()})`,
    );
  }
}
