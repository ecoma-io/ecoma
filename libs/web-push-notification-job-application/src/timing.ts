/**
 * Hai khái niệm hạn **tách biệt** của §16 — và việc làm chúng lẫn là một lỗi chính.
 *
 * - **Notification `expires_at`** là hạn nghiệp vụ: worker kiểm **một lần, ngay trước** khi
 *   gọi provider. Hết hạn → không gọi provider, không ghi outcome, không invalidate, không
 *   release; chỉ ghi attempt rồi `ack()`.
 * - **Web Push transport `TTL`** là gợi ý thời gian push service giữ message (WP4): nó
 *   **không vượt** thời gian còn lại tới `expires_at`, tức `floor((expires_at - now)/1000)`.
 *
 * ⚠️ `expires_at` trên wire là **RFC3339 string** (§7) trong khi mọi so sánh nội bộ là epoch
 * millis. Hàm này là chỗ **duy nhất** quy đổi giữa hai thứ, để không có một `Date.parse` nào
 * lọt vào pipeline và tự quyết định sai.
 */

import { isRfc3339Timestamp } from '@ecoma-io/push-notification-contracts';

/**
 * Số giây TTL gửi cho provider, **không vượt** thời gian còn lại tới `expires_at`.
 *
 * ⚠️ Clamp ≥ 0 và **không** tròn lên: `TTL = 0` là "không giữ lại nếu user agent chưa sẵn
 * sàng" (WP4) — một giá trị âm sẽ là header không hợp lệ, và làm tròn lên ở ranh giới 1 giây
 * là một message sống ** lâu hơn hạn nghiệp vụ, đúng thứ §16 cấm.
 *
 * @returns `null` khi `expires_at` không parse được RFC3339 — đó là dữ liệu hỏng từ peer và
 *   phải là contract violation, **không** phải TTL bằng 0 im lặng.
 */
export function computeTtlSeconds(expiresAt: string, nowMs: number): number | null {
  // ⚠️ **`Date.parse` một mình KHÔNG đủ.** Nó **normalize** thay vì từ chối: một ngày không
  // tồn tại vẫn ra một con số hợp lệ (`2026-02-30T00:00:00Z` → 2/3, tức TTL = 86_400 thay vì
  // một contract violation), và một hạn sai như vậy biến thành một message sống **hai ngày**
  // thay vì một ngày. Vì vậy shape/ngày-tồn-tại được kiểm bằng **validator canonical**
  // (`isRfc3339Timestamp` của contracts — cùng validator mà `validateDeliveryClaim` dùng cho
  // `expires_at`), còn `Date.parse` chỉ còn nhiệm vụ quy đổi thời điểm đã hợp lệ thành millis.
  if (!isRfc3339Timestamp(expiresAt)) {
    return null;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return null;
  }
  return Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
}

/**
 * Backoff của Queue retry — **bounded**, và **không** nhạy dữ liệu người dùng.
 *
 * ⚠️ **`message.attempts` là input duy nhất** của hàm này. Backoff tính từ số lần redeliver mà
 * Queue đếm, tức thứ **không** ai kiểm soát được ngoài chính Queue; tính từ `Date.now()` sẽ
 * khiến backoff không tái lập được và một test không kiểm chứng được.
 *
 * ⚠️ **Delay trả về là `undefined` khi không có yêu cầu cụ thể** — `retry()` không nhận tham số
 * thì Queue tự áp dụng policy backoff của nó (`wrangler.jsonc` chưa chốt `retry_delay`, xem
 * docs §4: giá trị là operational item chưa chốt). Việc **tự bịa** một delay sẽ là tạo một
 * operational gate chưa được quyết định. Chỉ khi có `retryAfterMs` từ provider (`429`) mới
 * truyền delay tường minh, vì đó là protocol, không phải policy.
 *
 * @returns `delaySeconds` cần truyền cho `retry()`, hoặc `undefined` để dùng policy Queue.
 */
export function queueRetryDelaySeconds(input: {
  readonly attempts: number;
  readonly retryAfterMs: number | null;
}): number | undefined {
  if (input.retryAfterMs !== null && input.retryAfterMs > 0) {
    // `Retry-After` của provider là **mức sàn**: nhân suy ra giây và giữ nguyên để không tạo
    // một delay ngắn hơn thứ provider đã yêu cầu — điều mà §17 yêu cầu rõ ("Tôn trọng
    // `Retry-After`").
    return Math.ceil(input.retryAfterMs / 1000);
  }
  return undefined;
}

/**
 * Timeout của một external request — **hằng module-level**, không phải config key.
 *
 * ⚠️ **Cố ý không** trở thành biến `env`. Docs §3 liệt kê tập config tối thiểu
 * (`QUEUE · PUSH_NOTIFICATION_SERVICE · LOG_LEVEL · ENVIRONMENT`) và FR-013 chỉ yêu cầu
 * "timeout hữu hạn" — không chốt một giá trị. Thêm một config key cho nó là **tự quyết định**
 * một operational gate (`docs/architecture/03-operations.md` §10 liệt kê `provider timeout` là
 * chưa chốt), mà Agent này không có quyền chốt. Giá trị dưới đây là một **hằng số kỹ thuật** có
 * chủ ý: đủ dưới giới hạn CPU của Worker cho một round-trip HTTP đơn, và đủ ngắn để một
 * message không bị giữ ở `processing` quá lâu.
 */
export const WEB_PUSH_REQUEST_TIMEOUT_MS = 10_000;
