import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Số lượt tối đa của pha chờ sau khi bấm `login-code-submit` — 1 lượt verify
 * đầu + 1 lượt recovery duy nhất. Cứng thay vì vòng tự do: mọi nhánh trong vòng
 * chỉ được `return` (thành công) hoặc throw; cạn ngân sách là lỗi thật.
 */
export const MAX_VERIFY_ATTEMPTS = 2;

/** isVisible không ném khi element biến mất giữa chờ — trả `false`. */
async function isVisibleSafe(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
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
}

/**
 * Chờ card continue mount sau khi bấm `login-code-submit`, kèm recovery đúng
 * MỘT lượt cho chết tầng mạng của pha này — hợp đồng dùng chung của 4 suite
 * e2e đi luồng OIDC browser (#461 round 2), mỗi nhánh dựa trên tính idempotent
 * của thao tác nó bấm lại:
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
 * 3. Vẫn ở trang login và `login-request-failed` hiển thị — POST verify chết
 *    tầng mạng trước khi tới server; mã CHƯA tiêu thụ (chính trang
 *    `login/index.vue` bảo đảm điều đó cho lỗi ném) nên bấm
 *    `login-code-submit` lại ĐÚNG MỘT LẦN rồi lặp pha chờ (bằng chứng #461
 *    round 2: 4 instance ngày 2026-11-20 — run 44677226226 và 44678063176
 *    trên main). Lượt hai chết là lỗi thật — cạn vòng và throw kèm
 *    `describeStuckState`, không che defect.
 * 4. Còn lại — `login-code-invalid` (OTP sai) hay `login-code-accepted`
 *    (verify OK nhưng hop confirm chết) KHÔNG có recovery: throw ngay.
 *
 * Hàm chỉ điều khiển pha chờ; caller bấm `login-continue-target` khi hàm trả về.
 */
export async function waitForContinueTargetAfterOtpVerify(
  page: Page,
  params: OtpVerifyRecoveryParams,
): Promise<void> {
  const { continueTarget, retryButton, requestFailed, describeStuckState } = params;
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
          `/login/continue rendered no card even after re-navigation (${await describeStuckState()})`,
        );
      }
      return;
    }
    if (verifyAttempt === 1 && (await isVisibleSafe(requestFailed))) {
      await page.getByTestId('login-code-submit').click();
      continue;
    }
    throw new Error(
      `login continue page never appeared after OTP verify (${await describeStuckState()})`,
    );
  }
}
