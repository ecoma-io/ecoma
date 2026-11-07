import type {
  MailErrorClass,
  MailMessageStatus,
  MailOutcome,
} from '@ecoma-io/transactional-mail-contracts';

import type { MailMessageRecord } from './records';

/**
 * Input của `createWithOutbox` — dựng **cả** `mail_messages` và `mail_outbox` cho một logical
 * delivery mới.
 *
 * Không có trường `variables`: FR-007 — worker render một lần tại request time, chỉ persist
 * template version đã chọn và nội dung đã render. Không có trường `status`,
 * `dispatchGeneration` hay `recoveryCycleCount`: cả ba do schema đặt
 * (`accepted`, `1`, `0` — `01-architecture.md` §6.2.2) và caller không được đặt chúng, nên
 * chúng không tồn tại để cấp phát.
 */
export interface CreateMailMessageWithOutboxInput {
  /** Id của message — `msg_` theo §4.2. Strategy sinh id là decision mở (overview §10). */
  readonly messageId: string;
  /** Id của outbox row — `obx_` theo §4.3. Do caller sinh cùng lượt, không phải `DEFAULT`. */
  readonly outboxId: string;
  /** Idempotency key cấp logical delivery phía consumer; UNIQUE (`01-architecture.md` §4.3). */
  readonly deliveryId: string;

  readonly app: string;
  readonly principalId: string;
  readonly templateId: string;
  readonly templateName: string;
  readonly templateVersion: number;
  readonly locale: string;
  /** Nhạy cảm — không đưa vào log, Queue payload hay error message. */
  readonly recipient: string;
  readonly subjectRendered: string;
  readonly bodyRendered: string;

  /** Khóa idempotency; UNIQUE cùng `principalId`. */
  readonly idempotencyKey: string;
  /** HMAC có khoá dạng `p1.k1:<64 hex>` — không phải hash trần (FR-007 AC). */
  readonly requestFingerprint: string;
  readonly correlationId: string | null;

  /**
   * Epoch ms đặt cho `created_at`/`updated_at` của message và outbox, và cho `available_at`
   * của outbox.
   *
   * Truyền tường minh (thay vì để `DEFAULT`) vì mọi phép tính retention/lease/backoff đều neo
   * vào thời điểm mà application layer đã nhìn thấy — và vì test cần điều khiển thời gian
   * thay vì phụ thuộc đồng hồ thật của database.
   */
  readonly nowMs: number;
}

/**
 * Kết quả của `createWithOutbox`.
 *
 * ⚠️ Ngay cả khi khoá đã tồn tại, port cũng **không** trả một nhánh tên là `replay` hay
 * `equivalent`. Cột duy nhất database kiểm là `UNIQUE (principal_id, idempotency_key)` — nó
 * chứng minh *"cùng khoá, một hàng"*, **không** chứng minh *"cùng request"*.
 *
 * `already-exists` nghĩa là: chưa có gì được ghi, và caller **phải** tự so
 * `requestFingerprint` của bản ghi trả về với fingerprint của request hiện tại rồi mới quyết
 * định replay-match (`200`, trả bản ghi cũ) hay conflict (`409`). So hay không so là việc của
 * application layer; persistence không có canonical request nên không thể so (FR-002).
 */
export type CreateMailMessageWithOutboxResult =
  | { readonly kind: 'created'; readonly message: MailMessageRecord }
  | { readonly kind: 'already-exists'; readonly message: MailMessageRecord };

/**
 * Input của `applyDeliveryOutcome` — outcome callback từ worker
 * (`POST /internal/deliveries/:delivery_id/outcome`, `01-architecture.md` §6.2.2).
 *
 * `dispatchGeneration` là **bắt buộc**: không có giá trị mặc định và không có đường nào suy
 * nó ra từ `deliveryId` — đó chính là fencing.
 */
export interface ApplyMailDeliveryOutcomeInput {
  readonly deliveryId: string;
  readonly outcome: MailOutcome;
  readonly dispatchGeneration: number;
  /**
   * `error_class` đã validate theo đúng năm giá trị canonical, hoặc `null`.
   *
   * Đây là giá trị duy nhất được persist vào `mail_messages.failure_reason`
   * (`01-architecture.md` §7.2) — port không nhận chuỗi tự do, nên một caller bị compromise
   * không thể đẩy recipient/nội dung vào cột này.
   */
  readonly errorClass: MailErrorClass | null;
  readonly nowMs: number;
}

/**
 * Phân loại outcome callback theo **thứ tự kiểm tra cố định** của `01-architecture.md` §6.2.2
 * — không phụ thuộc thứ tự callback đến:
 *
 * 1. không có delivery → `not-found` (HTTP 404)
 * 2. `dispatchGeneration` lệch → `stale`
 * 3. khớp và `status` đã bằng chính `outcome` đó → `duplicate`
 * 4. khớp và `status ∈ {accepted, queued}` → `applied`
 * 5. còn lại (kể cả `blocked` non-terminal và `sent`/`failed` terminal) → `stale`
 *
 * `stale` **không** phải success: worker đánh dấu report `superseded` và không retry.
 * `currentDispatchGeneration` chỉ có mặt ở nhánh `stale` vì đó là giá trị worker cần để dừng
 * vòng lặp của execution cũ (hàng 7 của bảng acceptance scenarios).
 */
export type ApplyMailDeliveryOutcomeResult =
  | { readonly result: 'not-found' }
  | { readonly result: 'applied' | 'duplicate'; readonly status: MailMessageStatus }
  | {
      readonly result: 'stale';
      readonly status: MailMessageStatus;
      readonly currentDispatchGeneration: number;
    };

/**
 * Repository của `mail_messages`.
 *
 * Mọi method ghi đều là **conditional write**: predicate nằm trong `WHERE` của câu `UPDATE`,
 * và "affected rows = 0" nghĩa là *đã lệch*, không phải *đã ghi*. Không method nào đọc trạng
 * thái rồi ghi không guard (`01-architecture.md` §6.2.2, "Chỉ conditional write").
 *
 * C1 **không** cung cấp primitive redrive/reset: tăng `dispatch_generation` là việc của một
 * thao tác redrive có authorize (`01-architecture.md` §6.4) và nằm ngoài phạm vi C1
 * (§5 của lệnh). Hậu quả: không có đường hợp lệ nào làm `dispatchGeneration` thay đổi trong
 * C1, nên fencing được kiểm ở tầng repository bằng cách dựng trạng thái đích trong test —
 * xem ghi chú ở `applyDeliveryOutcome`.
 */
export interface MailMessageRepository {
  /**
   * Tạo message + outbox row trong **một** `db.batch()` — hoặc cả hai, hoặc không
   * (`01-architecture.md` §6.1, `docs/architecture/04-platform-facts.md` DB2).
   *
   * Thuật toán: statement 1 `INSERT … ON CONFLICT (principal_id, idempotency_key) DO NOTHING
   * RETURNING`; statement 2 `INSERT INTO mail_outbox … SELECT … FROM mail_messages WHERE
   * principal_id = ? AND idempotency_key = ? AND id = ?`.
   *
   * - Người thắng: statement 1 trả 1 hàng → statement 2 chèn outbox row → `created`.
   * - Người thua: statement 1 trả 0 hàng → điều kiện `id = ?` của statement 2 không khớp
   *   (hàng thắng có id khác) → không có outbox row nào → `already-exists`.
   * - Cùng lúc: chỉ một bên thắng nhờ unique index; không có con đường nào tạo hai message
   *   độc lập cho cùng một khoá.
   *
   * Statement 2 **cố ý không** có `ON CONFLICT DO NOTHING`: nếu `delivery_id` đã bị dùng cho
   * một message khác (bug phía caller), ràng buộc vỡ làm **toàn bộ batch rollback** — không
   * bao giờ tồn tại message không có outbox row. Fail closed, không nuốt lỗi.
   *
   * Ngược lại, `already-exists` nghĩa là batch thành công nhưng không ghi gì: cần một
   * `SELECT` để lấy bản ghi cũ. Bản ghi đó **không** phải bằng chứng replay tương đương —
   * xem {@link CreateMailMessageWithOutboxResult}.
   *
   * Không network call nào được nằm trong batch (`01-architecture.md` §6.2).
   */
  createWithOutbox(
    input: CreateMailMessageWithOutboxInput,
  ): Promise<CreateMailMessageWithOutboxResult>;

  /**
   * Tra message theo scope uniqueness `(principalId, idempotencyKey)`.
   *
   * Không tra theo `idempotencyKey` một mình: khoá chỉ có ý nghĩa trong phạm vi principal
   * (`01-architecture.md` §4.2), và một lookup toàn cục sẽ vô tình gộp hai principal.
   */
  findByIdempotencyKey(
    principalId: string,
    idempotencyKey: string,
  ): Promise<MailMessageRecord | null>;

  /** Tra message theo `delivery_id` (UNIQUE) — đường tra của private interface. */
  findByDeliveryId(deliveryId: string): Promise<MailMessageRecord | null>;

  /** Tra message theo PK. */
  findById(messageId: string): Promise<MailMessageRecord | null>;

  /**
   * Ghi outcome của worker bằng conditional update duy nhất, rồi phân loại theo đúng thứ tự
   * §6.2.2.
   *
   * Statement 1: `UPDATE … WHERE delivery_id = ? AND dispatch_generation = ? AND status IN
   * ('accepted','queued') RETURNING …`.
   *
   * - Trả hàng → `applied`. Đây là **đường thành công duy nhất** đi qua một statement.
   * - Trả 0 hàng → statement 2 (`SELECT`) chỉ dùng để **phân loại**, không bao giờ dẫn tới
   *   một `UPDATE` không guard. Vì vậy pattern này không phải read-then-write: nếu có race
   *   giữa hai statement thì kết quả phân loại có thể *lỗi thời* theo hướng *an toàn hơn*
   *   (`duplicate` khi outcome đã được bên khác áp, `stale` khi generation vừa tăng) — không
   *   bao giờ là `applied` giả, vì `applied` chỉ trả khi chính statement 1 thành công.
   *
   * Không có redrive trong C1 nên `dispatchGeneration` không đổi được theo đường hợp lệ; để
   * kiểm fencing, test dựng trạng thái đích trực tiếp (redrive sẽ làm đúng việc đó trong
   * batch của nó) rồi xác nhận callback generation cũ nhận `stale`.
   *
   * Lệnh cấm lùi trạng thái nằm trong predicate: nguồn chỉ là `accepted`/`queued`, nên
   * `sent`/`failed`/`blocked` không bao giờ bị ghi đè.
   */
  applyDeliveryOutcome(
    input: ApplyMailDeliveryOutcomeInput,
  ): Promise<ApplyMailDeliveryOutcomeResult>;
}
