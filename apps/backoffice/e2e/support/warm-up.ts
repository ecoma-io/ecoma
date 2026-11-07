import type { Page, Response } from '@playwright/test';

/**
 * Trần chờ của vế warm-up browser; vượt trần là server còn thay trang liên tục.
 *
 * Nguồn chân lý của con số nằm ở `global-setup.ts` (kèm số đo trên CI); helper này
 * nhận trần qua tham số và **mặc định** theo giá trị đó, nên hai nơi luôn đi cùng
 * một trần mà không cần import ngược.
 */
export const WARM_UP_CAP_MS = 30_000;

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
