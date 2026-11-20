import { expect, type Locator, type Page } from '@playwright/test';

import { waitForContinueTargetAfterOtpVerify } from './otp-verify-recovery.js';

/** isVisible không ném khi element biến mất giữa chờ — trả `false`. */
function isVisibleSafe(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

export { isNavigationRaceError } from './otp-verify-recovery.js';

/** Tham số của một lượt re-login recovery — suite sở hữu dữ liệu login. */
export interface LoginRecoveryParams {
  /**
   * Entry BFF login của suite — PHẢI là URL tuyệt đối: recovery điều hướng từ
   * trang có thể đang chết (`chrome-error://…`) nơi path tương đối không resolve
   * được về đúng origin.
   */
  readonly loginEntryUrl: string;
  /** Email của identity — truyền thẳng từ `performBrowserLogin`. */
  readonly email: string;
  /** Đọc OTP từ mail sink — mỗi lần gọi trả mail MỚI NHẤT trong cửa sổ 60s. */
  readonly readOtp: () => Promise<string>;
  /** Thẻ lỗi request (`login-request-failed`) của trang login account. */
  readonly requestFailed: Locator;
  /** Nút relay của `/login/continue` — đích của recovery. */
  readonly continueTarget: Locator;
  /** Nút retry của thẻ lỗi handoff (`login-continue-retry`). */
  readonly retryButton: Locator;
  /** Mô tả trạng thái trang lúc chết — chỉ vào message throw. */
  readonly describeStuckState: () => Promise<string>;
}

/**
 * Re-login đầy đủ ĐÚNG MỘT LẦN — recovery dùng chung cho hai mode chết mà
 * không cơ chế nào khác phủ được (#461):
 *
 * - Mode stuck-on-login/no-callback (instances 6–12; lần tái phát đầu tiên
 *   trên main post-fix là instance 12, run 44702879181, SHA `95f8f471`):
 *   landing loop thấy browser đứng ở `/login?handle=…` với form email —
 *   `goto(origin)` tái tạo interaction login MỚI (provider session chưa hoàn
 *   tất phía server) nên chờ callback trên trang đó là vô nghĩa; cách duy nhất
 *   là chạy lại luồng login.
 * - Mode chrome-error (instance 11, run 44693545849): navigation chết tầng
 *   mạng, browser rơi ra `chrome-error://chromewebdata/` — UI product mất hẳn,
 *   không element nào để bấm lại; phải điều hướng vào lại entry rồi chạy luồng.
 *
 * Trình tự: (form email chưa hiện thì `goto` entry — MỘT lần, không retry
 * cold-start vì recovery chỉ chạy khi stack đã warm: journey đã đi tới giữa
 * luồng) → nộp email (re-click ĐÚNG MỘT LẦN khi `login-request-failed` —
 * challenge chưa được cấp nên rate limit không tiêu) → đọc OTP MỚI → nộp mã →
 * chờ `login-continue-target` qua `waitForContinueTargetAfterOtpVerify` KHÔNG
 * kèm recovery lồng nhau (chết lần hai trong re-login là lỗi thật — throw, giữ
 * `describeStuckState`, không che defect).
 *
 * Ngưỡng an toàn — đối chiếu hằng số thật `apps/account/server/lib/otp.ts`:
 *
 * - Challenge cấp thêm ≤ 1 ⇒ tổng 2 cho một địa chỉ ≤ `OTP_RATE_LIMIT_SHORT_MAX`
 *   = 3/15 phút và ≤ `OTP_RATE_LIMIT_HOUR_MAX` = 10/giờ. Lượt đầu chỉ hợp lệ
 *   ăn cooldown im lặng khi challenge CÒN ACTIVE trong 60s (204 không cấp mã
 *   mới — chính sách `challenge.post.ts`); khi challenge đã consume/hết hạn,
 *   challenge mới được cấp thật và mail mới nằm trong cửa sổ đọc của
 *   `readOtp` (ORDER BY `created_at` DESC nên mail mới luôn thắng mail cũ).
 * - Trần nhập sai mỗi challenge `MAX_OTP_ATTEMPTS` = 5: re-login đóng góp tối
 *   đa 2 POST verify (1 đầu + 1 re-click), chưa từng chạm trần trong các
 *   instance đã ghi.
 * - Handoff push và consent decide phía sau là idempotent (`event_id` /
 *   `replayOrReject`) — re-login đi lại đúng các nhánh recovery một-lượt đã có
 *   của flow chính.
 *
 * Caller bấm `continueTarget` khi hàm trả về — contract giống helper pha chờ.
 */
export async function recoverLoginByRelogin(
  page: Page,
  params: LoginRecoveryParams,
): Promise<void> {
  const emailForm = page.getByTestId('login-email-form');
  if (!(await isVisibleSafe(emailForm))) {
    await page.goto(params.loginEntryUrl, { waitUntil: 'load' });
    await emailForm.waitFor({ state: 'visible', timeout: 15_000 });
  }
  await page.getByTestId('login-email').fill(params.email);
  await page.getByTestId('login-submit').click();

  const codeForm = page.getByTestId('login-code-form');
  // Hai promise luôn tự settle qua `.catch` — thua race chỉ resolve muộn hơn,
  // KHÔNG bao giờ reject, và KHÔNG được `await` lần hai sau race: await kép vào
  // promise thua là chờ thêm tới 15s vô nghĩa trước re-click. Chỉ khi thẻ lỗi
  // hiện THẬT mới re-click (challenge chưa được cấp — rate limit không tiêu);
  // form mã tự timeout một mình là lỗi thật, nhánh `expect` dưới sẽ throw.
  const challengeOutcome = await Promise.race([
    codeForm
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => 'shown' as const)
      .catch(() => 'timeout' as const),
    params.requestFailed
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then(() => 'failed' as const)
      .catch(() => 'timeout' as const),
  ]);
  if (challengeOutcome === 'failed') {
    // Challenge chưa cấp (POST chết tầng mạng) — re-click một lượt, cùng hình
    // với flow chính; lỗi lần hai là lỗi thật.
    await page.getByTestId('login-submit').click();
  }
  await expect(codeForm).toBeVisible();
  const otp = await params.readOtp();
  await page.getByTestId('login-code').fill(otp);
  await page.getByTestId('login-code-submit').click();

  await waitForContinueTargetAfterOtpVerify(page, {
    continueTarget: params.continueTarget,
    retryButton: params.retryButton,
    requestFailed: params.requestFailed,
    describeStuckState: params.describeStuckState,
  });
}

/** Dependency mà consumer inject vào factory re-login — page + dữ liệu của suite. */
export interface RunReloginDeps extends LoginRecoveryParams {
  /** Trang browser đang chết — consumer nắm và truyền vào. */
  readonly page: Page;
}

/** Ngân sách re-login một lượt của `performBrowserLogin` (#461). */
export interface ReloginBudget {
  /**
   * Chạy re-login đúng một lượt. Ngân sách đếm ATTEMPT: cờ flip TRƯỚC khi gọi
   * — attempt chết cũng tiêu ngân sách, nhưng throw của nó làm test abort nên
   * cạn ngân sách không có hậu quả thêm; semantics này là thứ chặn re-entry
   * vô hạn qua hai hook (dead-page + landing).
   */
  readonly run: () => Promise<void>;
  /** Ngân sách còn nguyên — điều kiện kích hoạt recovery trong landing loop. */
  readonly available: () => boolean;
}

/**
 * Factory ngân sách re-login của #461 — trừu hoá phần copy-paste giữa 4
 * consumer: mỗi suite chỉ inject dữ liệu của mình (entry URL tuyệt đối, email,
 * `readOtp`, locators) và nhận lại handle `run`/`available` dùng cho cả hai
 * hook (dead-page trong helper pha chờ, landing loop).
 */
export function makeRunRelogin(deps: RunReloginDeps): ReloginBudget {
  let used = false;
  return {
    available: () => !used,
    run: async () => {
      if (used) {
        throw new Error('relogin recovery budget already spent');
      }
      used = true;
      const { page, ...params } = deps;
      await recoverLoginByRelogin(page, params);
    },
  };
}
