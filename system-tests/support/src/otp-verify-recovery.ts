import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Số lượt chờ tối đa của pha sau khi bấm `login-code-submit` — 1 lượt verify
 * đầu + tối đa 2 recovery, MỖI LOẠI ĐÚNG MỘT LẦN (re-click `login-code-submit`
 * cho `login-request-failed`, resend + OTP mới cho `login-code-invalid`). Cứng
 * thay vì vòng tự do: mọi nhánh trong vòng chỉ được `return` (thành công) hoặc
 * throw; cạn ngân sách là lỗi thật.
 */
export const MAX_VERIFY_ATTEMPTS = 3;

/** isVisible không ném khi element biến mất giữa chờ — trả `false`. */
function isVisibleSafe(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

/**
 * Trang chết của browser — UI product mất hẳn (instance 11 #461: run
 * 44693545849, `url=chrome-error://chromewebdata/ visible=[]` khi navigation
 * chết tầng mạng). Mọi scheme ngoài http/https, kể cả chuỗi không parse được,
 * được coi là chết: chờ tiếp trên trang đó KHÔNG BAO GIỜ mount được element
 * nào; giá trị URL vẫn đi vào `describeStuckState` ở nhánh throw.
 */
function isDeadBrowserPage(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol !== 'http:' && protocol !== 'https:';
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
   * Recovery re-login đầy đủ cho trang chết (`chrome-error://…`, `about:blank`)
   * — suite sở hữu vì chỉ nó biết entry URL tuyệt đối và tham số login. Hợp
   * đồng: đưa browser trở lại trạng thái `continueTarget` ĐÃ mount nhưng CHƯA
   * bấm — caller tiếp tục bằng hành động kế tiếp vốn có của mình (click target).
   * Vắng mặt ⇒ trang chết không có recovery (hành vi cũ).
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
 *    bằng 400, tức POST tới nơi rồi: sub-case đã chứng minh duy nhất là mã ĐÃ
 *    tiêu thụ ở POST trước (verify thật sự thành công nhưng response chết —
 *    instance 13 #461, run 44705889280: re-click `login-code-submit` của nhánh
 *    4 nộp LẠI đúng mã cũ và nhận `already_consumed`; UI không phân biệt được
 *    hai reason nên sub-case "mã sai thật" không loại trừ được — nhánh recovery
 *    vẫn bounded cho cả hai). Recovery: bấm `login-resend` ĐÚNG MỘT LẦN rồi đọc
 *    OTP MỚI từ mail sink (`readOtp` trả mail mới nhất trong cửa sổ 60s —
 *    `readOtpFromMailSink` ORDER BY `created_at` DESC). Ngưỡng an toàn (hằng số
 *    thật `apps/account/server/lib/otp.ts`): số challenge cấp thêm ≤ 1 ⇒ tổng
 *    2 ≤ `OTP_RATE_LIMIT_SHORT_MAX` = 3/15 phút; resend khi challenge active
 *    còn cooldown 60s là no-op im lặng 204 (chính `challenge.post.ts` bảo đảm
 *    — không có mail mới), khi đó `readOtp` trả lại mã cũ, verify fail lặp và
 *    cạn ngân sách ⇒ throw — không che defect. Trần nhập sai cho một challenge
 *    là `MAX_OTP_ATTEMPTS` = 5; nhánh này đóng góp tối đa 2 POST sai.
 * 4. `login-request-failed` hiển thị (KHÔNG kèm `login-code-invalid`) ở lượt
 *    verify đầu — POST verify chết tầng mạng trước khi nhận response; mã CHƯA
 *    tiêu thụ cho lỗi ném (chính trang `login/index.vue` bảo đảm điều đó) nên
 *    bấm `login-code-submit` lại ĐÚNG MỘT LẦN rồi lặp pha chờ (bằng chứng
 *    #461 round 2: instances 6–10). Lượt hai chết là lỗi thật.
 * 5. URL không còn http/https (`chrome-error://…`) VÀ có `recoverFromDeadPage`
 *    — UI product mất hẳn, không element nào chờ được nữa (instance 11 #461):
 *    gọi recovery re-login ĐÚNG MỘT LẦN rồi kết thúc pha (caller tự click
 *    target theo hợp đồng của closure).
 * 6. Còn lại — `login-code-accepted` (verify OK nhưng hop confirm chết) hay
 *    bất kỳ state khác KHÔNG có recovery: throw ngay kèm `describeStuckState`.
 *
 * Hàm chỉ điều khiển pha chờ; caller bấm `login-continue-target` khi hàm trả về.
 */
export async function waitForContinueTargetAfterOtpVerify(
  page: Page,
  params: OtpVerifyRecoveryParams,
): Promise<void> {
  const { continueTarget, retryButton, requestFailed, describeStuckState } = params;
  const codeInvalid = page.getByTestId('login-code-invalid');
  // Chờ vòng đời submit kết thúc sau mỗi lần bấm `login-code-submit` lại:
  // form mã rời DOM khi navigation bắt đầu — không có bước này, lặp kế tiếp có
  // thể đọc DOM cũ của POST trước trong khi POST mới còn đang xử lý. Lỗi tại
  // đây chỉ là context bị navigation phá giữa chừng — vô hại, lặp kế tiếp vẫn
  // chờ trên element mới; form KHÔNG rời DOM trong 15s (POST chết lần hai)
  // cũng là trạng thái đo được — lặp kế tiếp sẽ throw đúng hạn kèm stuck state.
  const codeForm = page.getByTestId('login-code-form');
  const awaitSubmitRoundTrip = async (): Promise<void> => {
    await codeForm.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
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
      await page.getByTestId('login-resend').click();
      const freshOtp = await params.readOtp();
      await page.getByTestId('login-code').fill(freshOtp);
      await page.getByTestId('login-code-submit').click();
      await awaitSubmitRoundTrip();
      continue;
    }
    if (verifyAttempt === 1 && (await isVisibleSafe(requestFailed))) {
      await page.getByTestId('login-code-submit').click();
      await awaitSubmitRoundTrip();
      continue;
    }
    if (params.recoverFromDeadPage !== undefined && isDeadBrowserPage(stuckUrl)) {
      await params.recoverFromDeadPage();
      return;
    }
    throw new Error(
      `login continue page never appeared after OTP verify (${await describeStuckState()})`,
    );
  }
}
