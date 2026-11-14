import type { Page, Response } from '@playwright/test';

/**
 * Trần chờ của vế warm-up browser ở **local**; vượt trần là server còn thay trang
 * liên tục.
 *
 * Số đo với cache Vite nguội (lần tải đầu của browser), máy dev 16 nhân, không
 * tải cạnh tranh: banner ready của `/` xuất hiện sau 7,7-14,3s và cả vế browser
 * (năm route + khoảng lặng) kết thúc sau 13,1s. Trần 30s vẫn dư hơn hai lần.
 */
export const WARM_UP_CAP_MS = 30_000;

/**
 * Trần chờ của vế warm-up browser trên **CI**; vượt trần là server còn thay trang
 * liên tục.
 *
 * ⚠️ Vì sao local và CI phải khác trần — số đo, không phải phỏng đoán:
 *
 * - Job `integration-test` chạy `nx affected -t build,test-integration
 *   --parallel=6` trên một runner 4 vCPU; khi affected set rộng (ví dụ PR #226
 *   chỉ chạm lockfile mà kéo 27 project vào), 5-6 task thật khác (build Nuxt,
 *   vitest + testcontainers, workerd) chạy cạnh dev server của suite này.
 * - Mô phỏng đúng điều kiện đó ở local (ghim toàn bộ tiến trình vào 4 nhân
 *   `taskset -c 0-3` + 6 vòng xoay CPU độc lập, cache Vite nguội): banner ready
 *   của `/` xuất hiện sau **22,4s rồi 38,8s** ở hai lần chạy, và cả vế browser
 *   kết thúc sau **30,1s** — vượt trần local 30s. CI thật đỏ 3/3 lần ở đúng trần
 *   này (`locator.waitFor: Timeout 30000ms exceeded` tại route đầu `/`, issue
 *   #239).
 * - Cơ chế bị kéo dài là chain reload của Vite optimizer: với cache nguội,
 *   `[optimizer] bundling dependencies...` chạy **nhiều vòng** (đo được 3 vòng),
 *   mỗi vòng phát `full-reload` và browser tải lại toàn bộ module graph. Không
 *   tải cạnh tranh, một vòng hết ~3s; dưới tải 6 task, mỗi vòng lên ~13-16s.
 * - `120_000` ≈ ba lần số đo xấu nhất (38,8s) — dư địa cho runner CI chậm hơn
 *   mô phỏng, mà vẫn dưới trần `webServer.timeout` (180s) nên vòng đời server
 *   vẫn là biên ngoài. Trần local giữ nguyên để phản hồi nhanh khi dev tự chạy.
 */
export const CI_WARM_UP_CAP_MS = 120_000;

/**
 * Trần warm-up theo môi trường: `process.env.CI` là công tắc mà
 * `playwright.config.ts` đã dùng cho `reuseExistingServer`/`reporter`, nên dùng
 * cùng công tắc để trần và hành vi đổi tay nhau.
 *
 * Gọi **một lần** đầu `globalSetup` rồi truyền trần qua tham số cho mọi chỗ chờ
 * (`gotoWithReloadRetry`, `waitForRouteReady`, `waitForDevServerToSettle`), để cả
 * vế browser có đúng một trần tổng thay vì mỗi chỗ chờ một trần riêng.
 */
export function warmUpCapMs(isCI: boolean): number {
  return isCI ? CI_WARM_UP_CAP_MS : WARM_UP_CAP_MS;
}

/**
 * Sàn của một lần chờ trong vế warm-up browser.
 *
 * ⚠️ Trước đây phần "còn lại" bị kẹp xuống 1 ms: khi trần sắp cạn, mỗi lượt chờ
 * chỉ nhận 1 ms và đỏ ngay bằng một timeout locator khó đọc, không nói được là
 * đã hết ngân sách warm-up. Sàn 1 s giữ cho lượt chờ cuối vẫn có ý nghĩa.
 *
 * Biên tăng thêm do sàn, tính trên trần CI 120 s: tối đa 1 s cho lượt chờ vượt
 * trần + tối đa `QUIET_MS` 3 s của vòng settle = 4 s. Một `page.goto` không
 * truyền timeout thì dùng mặc định 30 s của Playwright (đo được: `goto` tới host
 * không phản hồi hết sau 30 004 ms) — nhưng đó là trần **có sẵn** của navigation,
 * không phải phần sàn này thêm vào. Biên ngoài thật của cả job là
 * `timeout-minutes: 30` của job `integration-test` trong `.github/workflows/ci.yaml`.
 *
 * Không lượt chờ nào bắt đầu sau khi trần đã cạn: `remainingWarmUpMs` ném lỗi
 * rõ ràng thay vì trả về một giá trị vô nghĩa.
 */
export const WARM_UP_MIN_WAIT_MS = 1_000;

/**
 * Phần ngân sách warm-up còn lại cho một lượt chờ.
 *
 * - Còn nhiều hơn sàn: trả về đúng phần còn lại.
 * - Còn ít hơn sàn nhưng chưa cạn: trả về sàn (`WARM_UP_MIN_WAIT_MS`), để lượt
 *   chờ cuối không bị biến thành một timeout 1 ms vô nghĩa.
 * - Đã cạn: **ném** lỗi nói rõ đã dùng bao lâu, trần bao nhiêu và đang ở bước
 *   nào, thay vì để lượt chờ kế tiếp đỏ với `Timeout 1ms exceeded`.
 *
 * `stage` là nhãn cho người đọc (route/bước) để lỗi chỉ đúng chỗ; đồng hồ nhận
 * qua tham số để unit-test được (xem `tests/warm-up.spec.ts`).
 */
export function remainingWarmUpMs(options: {
  readonly capMs: number;
  readonly phaseStart: number;
  readonly stage: string;
  readonly now?: () => number;
}): number {
  const now = options.now ?? Date.now;
  const elapsedMs = now() - options.phaseStart;
  const remainingMs = options.capMs - elapsedMs;

  if (remainingMs <= 0) {
    throw new Error(
      `Warm-up browser budget exhausted after ${String(elapsedMs)} ms (cap ${String(options.capMs)} ms) at ${options.stage}; refusing to start a meaningless wait.`,
    );
  }

  return Math.max(remainingMs, WARM_UP_MIN_WAIT_MS);
}

/**
 * Điều hướng chịu được `full-reload` của `nuxt dev` giữa chừng.
 *
 * ⚠️ Vì sao cần hàm này: khi Vite pre-bundle dependency theo lượt tải đầu tiên của
 * browser (cache dependency nguội — đúng tình huống runner CI sạch), dev server gửi
 * `full-reload` để client tự tải lại trang. Reload đó **huỷ navigation đang bay** và
 * `page.goto()` ném `net::ERR_ABORTED` — app khoẻ, chỉ là dev server chọn đúng
 * khoảnh khắc navigation để thay trang. `warmUpBrowserClient` tồn tại để "ăn" đúng
 * race này, nên lỗi abort ở đây là **kết quả mong đợi của warm-up**, không phải lỗi
 * của app: bắt và thử lại navigation.
 *
 * Giới hạn thay vì retry vô hạn — dùng **deadline** thay vì đếm số lần retry: số lần
 * dev server thay trang không có trần lý thuyết, còn thời gian warm-up thì có (cùng
 * trần `WARM_UP_CAP_MS` với `waitForDevServerToSettle` — tổng thời gian chấp nhận
 * được của cả hai vế warm-up browser). Hết deadline mà vẫn abort thì **ném** tiếp:
 * server thay trang liên tục là bất thường, và nuốt lỗi ở đây sẽ biến "server hỏng"
 * thành một lần timeout mơ hồ ở test kế tiếp.
 *
 * Lỗi **không phải** abort (mất mạng thật, server sập giữa navigation, ...) được
 * **đẩy lên ngay**: chúng là lỗi thật của app/hạ tầng, giữ hành vi fail-loud.
 *
 * Nhận vào `goto` và đồng hồ dưới dạng tham số để unit-test được logic retry mà
 * không cần chạy Playwright (xem `tests/warm-up.spec.ts`).
 */
export async function gotoWithReloadRetry(
  page: Page,
  url: string,
  options: {
    /** Đồng hồ — mặc định `Date.now`, thay được trong test để không phụ thuộc thời gian thực. */
    readonly now?: () => number;
    /** Trần thời gian áp cho cả chuỗi retry; mặc định trần warm-up `WARM_UP_CAP_MS`. */
    readonly capMs?: number;
  } = {},
): Promise<Response | null> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.capMs ?? WARM_UP_CAP_MS);

  for (;;) {
    try {
      return await page.goto(url);
    } catch (cause) {
      if (!isNavigationAborted(cause)) {
        throw cause;
      }

      if (now() >= deadline) {
        throw new Error(
          `Navigation tới ${url} bị huỷ liên tục bởi dev server thay trang (full-reload) trong ${String(
            options.capMs ?? WARM_UP_CAP_MS,
          )} ms warm-up — dừng thay vì chạy test trên server không ổn định.`,
          { cause },
        );
      }
    }
  }
}

/**
 * `page.goto` ném khi navigation bị huỷ — nhưng **không phải mọi** abort đều do
 * `full-reload` (đóng tab, giả lập offline trong test cũng ném cùng loại lỗi). Playwright
 * không có mã lỗi ổn định để phân biệt, nên phân loại theo đúng nghĩa của lỗi: navigation
 * bị huỷ là khi browser **tự động điều hướng sang URL khác** trong lúc đang bay — đúng
 * điều mà `full-reload` làm, và đúng chữ "navigation to <url> was canceled by another one"
 * của Playwright.
 */
function isNavigationAborted(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);

  return message.includes('net::ERR_ABORTED') && message.includes('was canceled by another one');
}
