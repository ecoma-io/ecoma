import type { MailOutboxRecord } from './records';

/**
 * Input của `claim` — lấy một lô outbox row để publish.
 *
 * Claim là **optimistic** và nguyên tử trong một statement: `UPDATE … WHERE id IN (SELECT …
 * ORDER BY available_at, created_at LIMIT ?) AND (<điều kiện claim>) RETURNING …`
 * (`01-architecture.md` §6.2). D1 không có row lock hay mức isolation được tài liệu
 * (`docs/architecture/04-platform-facts.md` DB11), nên *một* statement có guard là đơn vị bảo vệ
 * duy nhất: hai publisher gọi cùng lúc sẽ nhận hai tập row rời nhau, không trùng.
 */
export interface ClaimMailOutboxInput {
  /** Epoch ms — đặt `claimed_at` và làm mốc so với `available_at`. */
  readonly nowMs: number;
  /**
   * `claimed_at <= nowMs - leaseDurationMs` nghĩa là lease đã hỏng (owner crash) → row
   * `publishing` đó được reclaim.
   *
   * Hai điều kiện claim, cùng trong predicate:
   * - `status = 'pending' AND available_at <= nowMs` — lần đầu hoặc sau backoff.
   * - `status = 'publishing' AND claimed_at <= nowMs - leaseDurationMs` — reclaim.
   *
   * Không nhận `status = 'failed'`: row hết `maxPublishAttempts` chỉ được mở lại bằng
   * repair có authorize (§5.4 của `03-operations.md`), không phải bằng claim.
   */
  readonly leaseDurationMs: number;
  /**
   * Token định danh cho lease — ghi vào `claimed_by` và là fencing condition của mọi thao tác
   * sau đó. Không có nghĩa là "ai": mỗi lần claim có thể là một token mới.
   */
  readonly leaseOwner: string;
  /** Số row tối đa một lần claim — `>= 1`; `<= 0` trả rỗng, không chạm database. */
  readonly limit: number;
}

/**
 * Repository của `mail_outbox` — lớp "Queue command đã được send chưa".
 *
 * ⚠️ Bất biến xuyên file: **publish state không bao giờ ghi delivery outcome.** Hai method ghi
 * ở đây chỉ viết `mail_outbox`, trừ `markPublished` — method duy nhất được phép đặt
 * `mail_messages.status = queued`, và nó nằm trong cùng `db.batch()` với việc đóng outbox row
 * (§6.2, "Thành công → batch `[outbox → published, message → queued]`"). Nó **không bao giờ**
 * viết `sent`/`failed`/`blocked`.
 */
export interface MailOutboxRepository {
  /**
   * Claim một lô row bằng đúng **một** conditional `UPDATE … RETURNING`.
   *
   * `publish_attempts` được tăng **chỉ** khi reclaim một row đang `publishing`
   * (`CASE WHEN status = 'publishing' THEN publish_attempts + 1 …`): lần claim đầu tiên trên
   * `pending` không tiêu attempt, còn một owner crash-loop thì bị chặn nhờ mỗi lần reclaim
   * tốn một attempt. Khi một lô quay lại được thì `pending` đã có backoff nên không tăng —
   * kết quả là attempt được tính **lỗi thời nhưng luôn thiên về phía thận trọng**.
   *
   * Trả `[]` khi không có gì đủ điều kiện; `limit <= 0` cũng trả `[]`.
   */
  claim(input: ClaimMailOutboxInput): Promise<readonly MailOutboxRecord[]>;

  /**
   * Gia hạn lease của đúng owner đang giữ nó.
   *
   * Predicate: `status = 'publishing' AND claimed_by = ? AND dispatch_generation = ?`.
   * Owner đã bị reclaim thì `claimed_by` đã đổi → trả `null` và **không ghi gì** (invariant:
   * một stale lease holder không được động vào state sau khi fencing condition hỏng).
   *
   * `claimed_at` cũ **không** nằm trong predicate: một lease đã hết hạn nhưng chưa bị ai
   * reclaim vẫn thuộc về owner, và việc renew là race hợp lệ — hai lệnh guarded như nhau,
   * ai commit trước người đó thắng.
   */
  renewLease(input: RenewMailOutboxLeaseInput): Promise<MailOutboxRecord | null>;

  /**
   * Đóng outbox row và đặt message sang `queued` trong **một** `db.batch()` hai statement.
   *
   * - Statement 1: `UPDATE mail_outbox SET status = 'published', published_at = ?, dọn lease
   *   WHERE id = ? AND status = 'publishing' AND claimed_by = ? AND dispatch_generation = ?
   *   RETURNING id`.
   * - Statement 2: `UPDATE mail_messages SET status = 'queued' WHERE delivery_id = ? AND
   *   status IN ('accepted','queued') AND dispatch_generation = (SELECT dispatch_generation
   *   FROM mail_outbox WHERE id = ? AND delivery_id = ? AND status = 'published' AND
   *   published_at = ?) RETURNING id`.
   *
   * Statement 2 neo vào việc statement 1 **đã** đóng đúng row đó: nếu lease đã bị mất, outbox
   * row không ở `published` với `published_at` của mình → scalar subquery trả `NULL` →
   * `dispatch_generation = NULL` không bao giờ đúng → 0 hàng. Không có kịch bản nào message
   * được đặt `queued` mà outbox chưa được mình đóng.
   *
   * `messageQueued = false` là kết quả **hợp lệ và expected** (bảng acceptance scenarios hàng
   * 3): message đã terminal thì publisher chỉ đóng outbox và bỏ qua message row. Vì vậy method
   * trả **hai** cờ thay vì ném lỗi — nhưng `outboxPublished = false` nghĩa là **không ghi gì
   * cả** (lease lost), và caller không được coi lần publish là thành công.
   */
  markPublished(input: MarkMailOutboxPublishedInput): Promise<MarkMailOutboxPublishedResult>;

  /**
   * Ghi thất bại của một lần publish: tăng `publish_attempts`, ghi `last_error`, đẩy
   * `available_at` ra sau backoff, xoá lease, về `pending` — hoặc về `failed` khi đã chạm
   * `maxPublishAttempts`.
   *
   * `status` được tính **trong** statement
   * (`CASE WHEN publish_attempts + 1 >= maxPublishAttempts THEN 'failed' ELSE 'pending' END`),
   * không phải bằng cách đọc số lần thử rồi quyết ở application layer: đọc-ghi không guard sẽ
   * cho hai publisher cùng nhường một lần thử.
   *
   * Trả `null` khi lease đã mất hoặc generation đã đổi — **không ghi gì**. Trả record khi đã
   * ghi; record đó mang `status` nên caller phân biệt được `failed` (hết chu kỳ) với `pending`
   * (sẽ thử lại).
   *
   * `lastError` bắt buộc là error code/token đã sanitize: cột này không nhận recipient, nội
   * dung render, credential hay raw payload (constraint `mail_outbox_last_error_format_check`
   * chặn chuỗi rỗng, không chặn nội dung — việc sanitize là việc của caller trước khi truyền).
   */
  recordPublishFailure(
    input: RecordMailOutboxPublishFailureInput,
  ): Promise<MailOutboxRecord | null>;

  /** Tra outbox row theo `delivery_id` (UNIQUE). */
  findByDeliveryId(deliveryId: string): Promise<MailOutboxRecord | null>;
}

/** Input của {@link MailOutboxRepository.renewLease}. */
export interface RenewMailOutboxLeaseInput {
  readonly outboxId: string;
  readonly leaseOwner: string;
  readonly dispatchGeneration: number;
  /** Epoch ms đặt cho `claimed_at` — lease mới tính từ thời điểm này. */
  readonly nowMs: number;
}

/** Input của {@link MailOutboxRepository.markPublished}. */
export interface MarkMailOutboxPublishedInput {
  readonly outboxId: string;
  readonly deliveryId: string;
  readonly leaseOwner: string;
  readonly dispatchGeneration: number;
  /** Epoch ms — đặt `published_at` của outbox và `updated_at` của message. */
  readonly nowMs: number;
}

/** Kết quả của {@link MailOutboxRepository.markPublished}. */
export interface MarkMailOutboxPublishedResult {
  /**
   * `true` = outbox row đã được đóng. `false` = **không có gì được ghi** (lease lost hoặc
   * generation lệch) và lần publish này không được coi là thành công.
   */
  readonly outboxPublished: boolean;
  /**
   * `true` = message đã được đặt `queued`. `false` = message không còn ở `accepted`/`queued`
   * (đã terminal, hoặc `blocked` — dữ liệu không nhất quán) nên bị bỏ qua có chủ đích.
   *
   * `outboxPublished = true` kèm `messageQueued = false` là trạng thái **hợp lệ**: Queue
   * `send()` đã thành công nên outbox phải ghi sự thật đó, còn message giữ nguyên trạng thái
   * của mình (bảng acceptance scenarios hàng 3).
   */
  readonly messageQueued: boolean;
}

/** Input của {@link MailOutboxRepository.recordPublishFailure}. */
export interface RecordMailOutboxPublishFailureInput {
  readonly outboxId: string;
  readonly deliveryId: string;
  readonly leaseOwner: string;
  readonly dispatchGeneration: number;
  /** Error code/token đã sanitize — không bao giờ là nguyên văn error body từ provider. */
  readonly lastError: string;
  /**
   * Epoch ms mà row được phép claim lại — **application layer** tính backoff (exponential theo
   * `03-operations.md` §5.2) rồi truyền vào; persistence không chứa chính sách backoff.
   *
   * Chỉ có ý nghĩa khi kết quả là `pending`; khi đã chạm ngưỡng thì row sang `failed` và
   * `available_at` không còn được đọc.
   */
  readonly nextAvailableAtMs: number;
  /**
   * Ngưỡng chu kỳ publish — giá trị vận hành do application layer truyền vào, cùng nhóm với
   * `maxRecoveryCycles`. Không nằm trong schema: đổi ngưỡng là đổi config, không phải
   * migration (cùng lý lẽ với `limit` của rate limit).
   */
  readonly maxPublishAttempts: number;
  /** Epoch ms — đặt `updated_at`. */
  readonly nowMs: number;
}
