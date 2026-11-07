/**
 * Port gửi Web Push — **interface đã đóng băng bởi Lead** giữa pipeline delivery
 * (`web-push-notification-job-application` — Agent C) và protocol adapter
 * (`web-push-notification-job-infrastructure/src/web-push` — Agent D).
 *
 * ⚠️ File này là **hợp đồng giữa hai agent**: pipeline chỉ thấy port này, adapter chỉ
 * implement port này. Đổi shape ở đây phải đi qua Lead — đổi riêng một bên là tạo lệch
 * interface mà typecheck hai bên vẫn có thể xanh vì import chéo qua barrel.
 *
 * Phân loại kết quả trả về bám **error matrix canonical**
 * (`docs/applications/push-notification/03-operations.md` §5) — bảng dùng thống nhất cho
 * control plane và delivery plane:
 *
 * | HTTP        | Kết quả port                          | Caller (pipeline) làm gì                      |
 * | ----------- | ------------------------------------- | --------------------------------------------- |
 * | `2xx`       | `delivered`                           | ghi outcome `delivered` + ACK                  |
 * | `404`       | `failed` / `endpoint_invalid`         | outcome `failed` + invalidate + ACK            |
 * | `410`       | `failed` / `endpoint_invalid`         | outcome `failed` + invalidate + ACK            |
 * | `401`/`403` | `failed` / `provider_auth`            | outcome `failed`, **KHÔNG** invalidate + ACK   |
 * | `413`       | `failed` / `payload_too_large`        | outcome `failed` + ACK, không retry            |
 * | `3xx`       | `failed` / `redirect_not_followed`    | outcome `failed`, **KHÔNG** invalidate + ACK   |
 * | `429`/`5xx` | `transient`                           | release lease → `retry()`                      |
 * | timeout / connection (trước khi tới provider) | `transient` / `before_send` | release lease → `retry()` |
 * | timeout / reset (SAU khi request có thể đã tới) | `transient` / `after_send` | release lease → `retry()` — nguồn duplicate tiềm năng, alert |
 *
 * ⚠️ Port **không** mang `dispatch_generation`, `delivery_id` hay bất kỳ identity nào:
 * fencing/outcome là việc của pipeline; adapter chỉ biết "gửi một Web Push request và
 * phân loại kết quả". Điều đó giữ adapter không thể ghi state nào và giữ mọi secret
 * (p256dh/auth/VAPID key) nằm trong tham số vào — **không bao giờ** trong kết quả ra,
 * không trong log, không trong error message (worker SR-002/SR-003).
 */

/** Pha của một lỗi transient — quyết định đây có phải nguồn duplicate tiềm năng không. */
export type WebPushTransientPhase =
  /** Request **chưa** tới provider (DNS/connection refused trước khi gửi) — retry không tạo duplicate. */
  | 'before_send'
  /** Request **có thể** đã tới provider (timeout sau khi gửi, reset giữa response) — crash window đã chấp nhận (worker §12 nhóm iii). */
  | 'after_send';

/**
 * Class permanent failure của attempt — **không retry**.
 *
 * `endpoint_invalid` là class **duy nhất** cho phép invalidate subscription (chỉ khi
 * provider chứng minh endpoint chết — `404` hoặc `410`, worker §13); mọi class khác
 * **MUST NOT** dẫn tới invalidate (§7.2: `provider_auth` là provider-level failure;
 * `redirect_not_followed` cấm invalidate — `03-operations.md` §5).
 */
export type WebPushPermanentFailureClass =
  /** Provider trả `404` hoặc `410` — endpoint không còn hợp lệ. */
  | 'endpoint_invalid'
  /** Provider trả `401`/`403` — credential/configuration provider-level; remediation ở control plane. */
  | 'provider_auth'
  /** Provider trả `413`, hoặc payload vượt trần 3993 octets plaintext phát hiện trước khi gửi (worker §15). */
  | 'payload_too_large'
  /** Provider trả **mọi** `3xx` — redirect không được đi theo (FR-005); alert. */
  | 'redirect_not_followed'
  /** VAPID key của `vapid_key_id` không có/không import được để ký (worker §18) — permanent của attempt. */
  | 'vapid_key_missing';

/**
 * Kết quả của một lần gửi — union đóng ba nhánh của error matrix.
 *
 * Không có nhánh "unknown": mọi kết quả không parse được thành một trong ba nhánh là
 * lỗi của adapter (throw) — caller xử lý như lỗi contract (`retry()` bounded, không
 * gọi lại provider trong cùng attempt).
 */
export type WebPushSendResult =
  /** Provider trả `2xx`. */
  | { readonly outcome: 'delivered' }
  /**
   * Permanent failure — không retry.
   *
   * `httpStatus` là status HTTP của provider khi có; `null` cho lỗi không qua HTTP
   * (ví dụ key import fail). **Không bao giờ** chứa body của provider: body có thể mang
   * endpoint/secret phản chiếu (SR-002).
   */
  | {
      readonly outcome: 'failed';
      readonly failureClass: WebPushPermanentFailureClass;
      readonly httpStatus: number | null;
    }
  /**
   * Transient — caller **release lease rồi `retry()`** (worker §12: release là bắt buộc
   * trước khi trả `retry()`, nếu không message redelivery gặp `409 lease_held` và retry
   * của Queue vô hiệu).
   *
   * `retryAfterMs` là `Retry-After` (đổi ra ms) của `429` khi provider trả và parse được;
   * `null` khi không có. Caller ghi nhận để quan sát (§14.8) chứ không tự sleep.
   */
  | {
      readonly outcome: 'transient';
      readonly phase: WebPushTransientPhase;
      readonly retryAfterMs: number | null;
      readonly httpStatus: number | null;
    };

/** Tham số gửi — đủ cho **một** Web Push request, không hơn (worker §6: không discovery). */
export interface WebPushSendRequest {
  /**
   * Endpoint của subscription — dùng **nguyên văn** từ runtime material (FR-005: worker
   * **MUST NOT** re-validate allowlist, **MUST NOT** tự lọc/đổi endpoint).
   */
  readonly endpoint: string;
  /** Public key ECDH của subscription (base64url, RFC 8291) — subscription delivery secret. */
  readonly p256dh: string;
  /** Authentication secret của subscription (base64url, RFC 8291) — subscription delivery secret. */
  readonly auth: string;
  /**
   * Private key VAPID để ký JWT ES256 — key khớp `vapid_key_id` **của subscription**
   * (worker §18), không phải "key hiện tại của App". Base64url của DER PKCS#8.
   */
  readonly vapidPrivateKey: string;
  /** Public key VAPID khớp private key — base64url của điểm EC P-256 uncompressed (65 byte), đi vào tham số `k` (WP6). */
  readonly vapidPublicKey: string;
  /**
   * Claim `sub` của JWT VAPID (RFC 8292 §5 — contact URI `mailto:`/`https:`); `null`
   * khi provider configuration không cung cấp. Lấy từ `provider.configuration`, không
   * bịa default.
   */
  readonly vapidSubject: string | null;
  /** Payload đã serialize JSON (đúng 4 field của FR-013) — adapter mã hoá aes128gcm trước khi gửi. */
  readonly payloadJson: string;
  /** TTL (giây) — caller đã tính **không vượt** thời gian còn lại tới `expires_at` (worker §16, WP4). */
  readonly ttlSeconds: number;
  /** Timeout hữu hạn của request (worker §16) — adapter phải thực thi bằng AbortController. */
  readonly timeoutMs: number;
}

/**
 * Adapter Web Push — implement ở `web-push-notification-job-infrastructure/src/web-push`.
 *
 * Implement **MUST**:
 * - mã hoá payload theo RFC 8291 `aes128gcm` (101 byte framing header khi có keyid) và
 *   từ chối plaintext vượt **3993 octets** trước khi gọi fetch → `payload_too_large`;
 * - ký VAPID JWT ES256 (WP3: `aud` = origin của endpoint, `exp` ≤ 24h) và đặt header
 *   `Authorization: vapid t=<jwt>, k=<pubkey>` (WP6); JWT **không bao giờ** vào log;
 * - đặt header `TTL` = `ttlSeconds` (WP4);
 * - `redirect: 'manual'` — **không** đi theo redirect; **mọi** `3xx` → `redirect_not_followed`;
 * - thực thi `timeoutMs` bằng AbortController; lỗi aborted sau khi request đã gửi →
 *   `transient`/`after_send`; lỗi connection/DNS trước khi gửi → `transient`/`before_send`;
 * - **không** log endpoint, `auth`, `p256dh`, VAPID key, JWT hay body (SR-003).
 */
export interface WebPushSender {
  send(request: WebPushSendRequest): Promise<WebPushSendResult>;
}
