/**
 * Port của delivery plane `web-push-notification-job` — toàn bộ I/O mà pipeline cần, ở
 * dạng **hẹp nhất có thể**.
 *
 * ⚠️ **Ba ranh giới, ba lý do tách port.** Pipeline ở tầng application **không** được biết:
 *
 * 1. private delivery runtime API của control plane (`runtime-control-plane-port.ts`) —
 *    `claim`/`release`/`outcome`/`invalidate`, mỗi cái một method, **không** có method "gọi
 *    chung một endpoint tuỳ ý". Một port có `request(method, path, body)` là một port đã
 *    bỏ mất ranh giới quyền: bất kỳ ai cầm nó cũng đọc được mọi route.
 * 2. D1 `push-job` (`job-state-port.ts`) — job execution state của chính worker; **không**
 *    phải logical delivery state (thuộc control plane, §11b).
 * 3. adapter Web Push (`web-push-sender.ts`, đã đóng băng) — protocol, không mang identity.
 *
 * ⚠️ **Port này không mang `fetch` thô.** Worker không có HTTP server (invariant 1 §19), và
 * một port `fetch` trong application layer sẽ khiến mọi lỗi mạng trở thành "business logic
 * bắt được exception" — đúng loại phân loại mà §5 của tài liệu cấm lặp ở client.
 */

/* -------------------------------------------------------------------------------------- */
/* Clock                                                                                      */
/* -------------------------------------------------------------------------------------- */

/**
 * Đồng hồ của pipeline — **epoch millis**.
 *
 * ⚠️ `expires_at` trên wire là RFC3339 (§7) còn lease/attempt trên D1 là epoch millis; có một
 * đồng hồ duy nhất được inject ở đây để việc quyết định "đã hết hạn chưa" không phụ thuộc
 * `Date.now()` rải rác nhiều chỗ. Test inject một clock cố định (T0) nên mọi biên thời gian
 * là tường minh.
 */
export interface PipelineClock {
  now(): number;
}

/* -------------------------------------------------------------------------------------- */
/* Queue acknowledgement                                                                      */
/* -------------------------------------------------------------------------------------- */

/**
 * Quyền ACK/retry của **một** message trong batch.
 *
 * ⚠️ **Per-message, không per-batch** (FR-018, §12.1): một message fail không được kéo các
 * message anh em. Vì vậy port này là của **từng message** — không có `ackAll`/`retryAll` ở
 * đây, vì chỉ cần chúng tồn tại là một call site có thể gọi nhầm và biến một lỗi thành một
 * batch retry.
 *
 * ⚠️ `retry()` nhận `delaySeconds` vì backoff là policy của Queue (docs §12), và
 * `retryAfterMs` từ provider (`429`) phải được tôn trọng (§17: "Tôn trọng `Retry-After`").
 * Port không tự tính delay: việc đó thuộc pipeline, nơi có đủ thông tin.
 */
export interface MessageDisposition {
  /** Kết thúc message: state cần thiết đã persist, hoặc no-op an toàn (§8). */
  ack(): void;
  /**
   * Đưa message về Queue với backoff. Chỉ dùng khi: `409 pending` (chưa có lease để
   * release), lỗi transient **sau khi đã release**, hoặc contract violation / control plane
   * 5xx (bounded retry rồi DLQ).
   */
  retry(options?: { readonly delaySeconds?: number }): void;
}

/** Thuộc tính của message đầu vào mà pipeline được phép đọc. */
export interface QueueMessageInfo {
  /** `message.attempts` của Queue — số lần đã redeliver, cơ sở của attempt budget. */
  readonly attempts: number;
}

/* -------------------------------------------------------------------------------------- */
/* Queue producer (chỉ cho job reconciliation)                                               */
/* -------------------------------------------------------------------------------------- */

/**
 * Producer của Queue `ecoma-push-delivery`, dùng **một lý do duy nhất**: re-deliver envelope
 * gốc của một job record đang kẹt (FR-022).
 *
 * ⚠️ Port này tồn tại là để quyền produce được **giới hạn bằng kiểu** chứ không bằng quy ước:
 * `republish` không nhận `delivery_id`/`transport`/`provider_id` riêng mà nhận **nguyên
 * envelope** đã lưu trong D1 `push-job`, nên không có đường nào để đổi provider, đổi
 * transport hay tạo delivery mới (FR-022 "quyền được cấp tường minh"). Worker **MUST NOT**
 * dùng nó để reroute hoặc publish notification khác.
 */
export interface QueueProducerPort {
  send(message: unknown): Promise<unknown>;
}
