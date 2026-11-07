import type {
  ClaimMailOutboxInput,
  MailOutboxRecord,
  MailOutboxRepository,
  MarkMailOutboxPublishedInput,
  MarkMailOutboxPublishedResult,
  RecordMailOutboxPublishFailureInput,
  RenewMailOutboxLeaseInput,
} from '@ecoma-io/transactional-mail-application';

import type { D1SubsetDatabase } from './d1-surface';
import { MAIL_OUTBOX_COLUMNS, toMailOutboxRecord } from './rows';
import type { MailOutboxRow } from './rows';

const SELECT_BY_DELIVERY_ID = `SELECT ${MAIL_OUTBOX_COLUMNS} FROM mail_outbox WHERE delivery_id = ?`;

/**
 * Claim trong **một** statement.
 *
 * Hai khối điều kiện giống hệt nhau — một lần ở nhánh con (`id IN (SELECT … LIMIT ?)`) và một
 * lần ở `WHERE` ngoài — không phải thừa: nhánh con chọn và **sắp thứ tự** (`available_at,
 * created_at`) để một lần claim lấy đúng những row tới hạn trước, còn `WHERE` ngoài là guard
 * tường minh chứng minh mỗi row vẫn đủ điều kiện tại thời điểm UPDATE đọc nó. Hai khối cùng
 * bind cùng giá trị nên không thể lệch nhau.
 *
 * D1 không có row lock hay mức isolation được tài liệu (`docs/architecture/04-platform-facts.md`
 * DB11); mỗi DB chạy đơn luồng, nên **một** statement có guard là đơn vị bảo vệ duy nhất —
 * hai publisher cùng claim sẽ nhận hai tập row rời nhau.
 */
const CLAIM = `
UPDATE mail_outbox
SET status = 'publishing',
    publish_attempts = CASE WHEN status = 'publishing' THEN publish_attempts + 1 ELSE publish_attempts END,
    claimed_at = ?,
    claimed_by = ?,
    updated_at = ?
WHERE id IN (
  SELECT id FROM mail_outbox
  WHERE (status = 'pending' AND available_at <= ?)
     OR (status = 'publishing' AND claimed_at <= ?)
  ORDER BY available_at, created_at
  LIMIT ?
)
AND (
  (status = 'pending' AND available_at <= ?)
  OR (status = 'publishing' AND claimed_at <= ?)
)
RETURNING ${MAIL_OUTBOX_COLUMNS}
`;

const RENEW_LEASE = `
UPDATE mail_outbox
SET claimed_at = ?, updated_at = ?
WHERE id = ? AND status = 'publishing' AND claimed_by = ? AND dispatch_generation = ?
RETURNING ${MAIL_OUTBOX_COLUMNS}
`;

/**
 * Statement 1 của `markPublished` — đóng outbox row bằng đúng lease mà caller đang giữ.
 *
 * `claimed_by` là fencing: owner đã bị reclaim thì `claimed_by` đã đổi, predicate sai, trả 0
 * hàng, và statement 2 (dưới) cũng không thể chạy được vì không có `published_at` của ta.
 */
const PUBLISH_OUTBOX = `
UPDATE mail_outbox
SET status = 'published', published_at = ?, claimed_at = NULL, claimed_by = NULL,
    last_error = NULL, updated_at = ?
WHERE id = ? AND status = 'publishing' AND claimed_by = ? AND dispatch_generation = ?
RETURNING ${MAIL_OUTBOX_COLUMNS}
`;

/**
 * Statement 2 của `markPublished` — nguồn `queued` duy nhất mà publisher được phép ghi.
 *
 * Predicate có **ba** tầng, cùng lúc:
 * 1. `status IN ('accepted','queued')` — không bao giờ ghi đè `sent`/`failed`/`blocked`, và
 *    `blocked` **không** phải nguồn hợp lệ (§6.2.1).
 * 2. `dispatch_generation = (SELECT …)` neo vào generation của **chính outbox row vừa đóng**,
 *    không phải giá trị caller truyền — bảng không cần tin caller.
 * 3. Subquery chỉ khớp khi row đó đang `published` với `published_at` của **lần gọi này**: nếu
 *    lease đã mất thì statement 1 không ghi gì, subquery trả `NULL`, và `x = NULL` không bao
 *    giờ đúng → 0 hàng.
 */
const QUEUE_MESSAGE = `
UPDATE mail_messages
SET status = 'queued', updated_at = ?
WHERE delivery_id = ?
  AND status IN ('accepted', 'queued')
  AND dispatch_generation = (
    SELECT outbox.dispatch_generation FROM mail_outbox AS outbox
    WHERE outbox.id = ? AND outbox.delivery_id = ? AND outbox.status = 'published'
      AND outbox.published_at = ?
  )
RETURNING id
`;

const RECORD_FAILURE = `
UPDATE mail_outbox
SET publish_attempts = publish_attempts + 1,
    last_error = ?,
    available_at = ?,
    claimed_at = NULL,
    claimed_by = NULL,
    status = CASE WHEN publish_attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
    updated_at = ?
WHERE id = ? AND status = 'publishing' AND claimed_by = ? AND dispatch_generation = ?
RETURNING ${MAIL_OUTBOX_COLUMNS}
`;

/** Repository D1 của `mail_outbox`. Xem JSDoc của từng method trong port. */
export class D1MailOutboxRepository implements MailOutboxRepository {
  readonly #db: D1SubsetDatabase;

  constructor(db: D1SubsetDatabase) {
    this.#db = db;
  }

  async claim(input: ClaimMailOutboxInput): Promise<readonly MailOutboxRecord[]> {
    if (input.limit < 1) {
      return [];
    }

    // Tính một lần rồi bind hai lần: `nowMs - leaseDurationMs` phải là **chính** mốc dùng cho
    // cả hai nửa của predicate, nếu tách thành hai biểu thức riêng thì một thay đổi sau này có
    // thể làm hai nửa lệch nhau và claim bắt đầu bỏ sót row.
    const leaseExpiredBeforeMs = input.nowMs - input.leaseDurationMs;

    const claimed = await this.#db
      .prepare(CLAIM)
      .bind(
        input.nowMs,
        input.leaseOwner,
        input.nowMs,
        input.nowMs,
        leaseExpiredBeforeMs,
        input.limit,
        input.nowMs,
        leaseExpiredBeforeMs,
      )
      .all<MailOutboxRow>();

    return claimed.results.map(toMailOutboxRecord);
  }

  async renewLease(input: RenewMailOutboxLeaseInput): Promise<MailOutboxRecord | null> {
    const renewed = await this.#db
      .prepare(RENEW_LEASE)
      .bind(input.nowMs, input.nowMs, input.outboxId, input.leaseOwner, input.dispatchGeneration)
      .all<MailOutboxRow>();
    const row = renewed.results[0];
    return row ? toMailOutboxRecord(row) : null;
  }

  async markPublished(input: MarkMailOutboxPublishedInput): Promise<MarkMailOutboxPublishedResult> {
    const closeOutbox = this.#db
      .prepare(PUBLISH_OUTBOX)
      .bind(input.nowMs, input.nowMs, input.outboxId, input.leaseOwner, input.dispatchGeneration);
    const queueMessage = this.#db
      .prepare(QUEUE_MESSAGE)
      .bind(input.nowMs, input.deliveryId, input.outboxId, input.deliveryId, input.nowMs);

    const [outboxRows, messageRows] = await this.#db.batch([closeOutbox, queueMessage]);

    return {
      outboxPublished: outboxRows.results.length === 1,
      messageQueued: messageRows.results.length === 1,
    };
  }

  async recordPublishFailure(
    input: RecordMailOutboxPublishFailureInput,
  ): Promise<MailOutboxRecord | null> {
    const updated = await this.#db
      .prepare(RECORD_FAILURE)
      .bind(
        input.lastError,
        input.nextAvailableAtMs,
        input.maxPublishAttempts,
        input.nowMs,
        input.outboxId,
        input.leaseOwner,
        input.dispatchGeneration,
      )
      .all<MailOutboxRow>();
    const row = updated.results[0];
    return row ? toMailOutboxRecord(row) : null;
  }

  async findByDeliveryId(deliveryId: string): Promise<MailOutboxRecord | null> {
    const found = await this.#db
      .prepare(SELECT_BY_DELIVERY_ID)
      .bind(deliveryId)
      .all<MailOutboxRow>();
    const row = found.results[0];
    return row ? toMailOutboxRecord(row) : null;
  }
}
