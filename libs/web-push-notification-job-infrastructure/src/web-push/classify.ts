/**
 * Phân loại HTTP response của push service thành `WebPushSendResult`.
 *
 * ⚠️ Đây là **error matrix canonical** (`docs/applications/push-notification/03-operations.md`
 * §5), và adapter là nơi duy nhất được phép quyết HTTP nào là permanent. Nguyên tắc dẫn
 * đường cho mọi dòng dưới đây:
 *
 * - **`endpoint_invalid` chỉ khi provider chứng minh endpoint chết** — `404` và `410`.
 *   Mọi lỗi cục bộ (endpoint parse hỏng, key hỏng) tuy cũng là "permanent của attempt" nhưng
 *   **không** được mang class này, vì caller sẽ invalidate một subscription còn tốt.
 * - **`410` trên send path không bao giờ là tạm thời.** RFC 8030 §7.3 định nghĩa `404` cho
 *   subscription hết hạn trên send path (`410` chỉ dành cho receipt channel §6.2/§6.3), nhưng
 *   push service sản phẩm — Mozilla autopush — map `NoUser`/`NoSubscription` → `410 GONE`
 *   ("Expired URL endpoint", errno 103/105/106; `autoendpoint/src/error.rs`, `docs/src/errors.md`).
 *   Một `410` giữ transient chỉ đốt queue budget rồi vô DLQ, trong khi subscription đã chết.
 *   `httpStatus` giữ nguyên 410 để metrics phân biệt spike 404 với spike 410.
 * - **Đọc `Retry-After` không bao giờ làm lộ secret** — chỉ header, không body (SR-002).
 * - **Body của provider không bao giờ** vào kết quả: body phản chiếu endpoint/credential.
 */

import type { WebPushSendResult } from '@ecoma-io/web-push-notification-job-application';

/** Header `Retry-After` dạng delta-seconds (RFC 9110 §10.2.3). */
const RETRY_AFTER = 'retry-after';

/**
 * Phân loại status + header thành kết quả port.
 *
 * Tham số là **chỉ** những gì matrix cần (`status`, `retryAfter`). Hàm cố tình không nhận
 * endpoint, body hay bất kỳ material nào — đó là cách giữ SR-002/SR-003 đúng bằng *shape*
 * thay vì bằng kỷ luật: không có gì để lộ.
 *
 * ⚠️ `redirect`/`before send` **không** phân loại ở đây — chúng không có response nào để
 * xem. `WebPushSender` xử lý riêng, vì cả hai đều là quyết định về *việc đã gửi hay chưa*,
 * không phải về status.
 */
export function classifyResponse(status: number, retryAfter: string | null): WebPushSendResult {
  if (status >= 200 && status < 300) {
    return { outcome: 'delivered' };
  }
  if (status === 404) {
    return { outcome: 'failed', failureClass: 'endpoint_invalid', httpStatus: 404 };
  }
  if (status === 410) {
    // DC-1: cùng nhánh 404 — endpoint đã biến mất khỏi push service (autopush vendor
    // behavior). Giữ `httpStatus: 410` riêng để metrics thấy được một spike 410 khác 404.
    return { outcome: 'failed', failureClass: 'endpoint_invalid', httpStatus: 410 };
  }
  if (status === 401 || status === 403) {
    // Provider-level credential/configuration failure. **Không** invalidate (03-operations §5).
    return { outcome: 'failed', failureClass: 'provider_auth', httpStatus: status };
  }
  if (status === 413) {
    return { outcome: 'failed', failureClass: 'payload_too_large', httpStatus: 413 };
  }
  if (status >= 300 && status < 400) {
    // `redirect:'manual'` nghĩa là mọi 3xx là câu trả lời cuối, không phải đường đi tiếp.
    return { outcome: 'failed', failureClass: 'redirect_not_followed', httpStatus: status };
  }
  if (status === 429) {
    return {
      outcome: 'transient',
      phase: 'after_send',
      retryAfterMs: parseRetryAfterMs(retryAfter),
      httpStatus: 429,
    };
  }
  // 4xx còn lại và 5xx: không chứng minh được gì → transient để bounded retry/DLQ xử lý.
  return { outcome: 'transient', phase: 'after_send', retryAfterMs: null, httpStatus: status };
}

/**
 * Đọc `Retry-After` thành milliseconds.
 *
 * Chỉ nhận **dạng delta-seconds** của RFC 9110 §10.2.3. Dạng HTTP-date trả `null` chứ không
 * đoán: adapter không có clock skew đáng tin với push service, và một date sai sẽ thành backoff
 * sai. Caller coi `null` là "không có" và dùng backoff của hàng đợi.
 */
export function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (retryAfter === null) {
    return null;
  }
  const trimmed = retryAfter.trim();
  // `delta-seconds` là 1*DIGIT: chỉ chữ số. Dạng HTTP-date chứa chữ và dấu `,`/`:` → rơi
  // xuống dưới và trả `null`.
  if (!/^[0-9]+$/u.test(trimmed)) {
    return null;
  }
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds)) {
    return null;
  }
  return seconds * 1000;
}

/** Đọc header `Retry-After` từ `Headers` — trả `null` khi vắng (không phải chuỗi rỗng). */
export function readRetryAfter(headers: Headers): string | null {
  return headers.get(RETRY_AFTER);
}
