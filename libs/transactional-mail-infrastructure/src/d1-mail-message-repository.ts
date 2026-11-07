import type {
  ApplyMailDeliveryOutcomeInput,
  ApplyMailDeliveryOutcomeResult,
  CreateMailMessageWithOutboxInput,
  CreateMailMessageWithOutboxResult,
  MailMessageRecord,
  MailMessageRepository,
} from '@ecoma-io/transactional-mail-application';

import type { D1SubsetDatabase } from './d1-surface';
import { MAIL_MESSAGE_COLUMNS, MAIL_OUTBOX_COLUMNS, toMailMessageRecord } from './rows';
import type { MailMessageRow } from './rows';

/**
 * Statement tạo message. Status/generation/counter đặt bằng **literal schema-owned**, không bind:
 * `accepted`, `1`, `0` là trạng thái khởi tạo của initial dispatch (`01-architecture.md` §6.2.2)
 * và caller không có đường nào cấp phát chúng.
 *
 * `ON CONFLICT` nhắm **đúng unique index** `(principal_id, idempotency_key)`: chỉ xung đột ở
 * khoá idempotency mới bị nuốt, còn xung đột PK hay `delivery_id` vẫn ném lỗi và làm cả batch
 * rollback — đó là hành vi mà invariant "không bao giờ tồn tại message mồ côi" cần.
 */
const INSERT_MESSAGE = `
INSERT INTO mail_messages (
  id, app, principal_id, template_id, template_name, template_version, locale, recipient,
  subject_rendered, body_rendered, status, delivery_id, dispatch_generation,
  recovery_cycle_count, idempotency_key, request_fingerprint, correlation_id, failure_reason,
  terminal_at, created_at, updated_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, 1, 0, ?, ?, ?, NULL, NULL, ?, ?)
ON CONFLICT (principal_id, idempotency_key) DO NOTHING
RETURNING ${MAIL_MESSAGE_COLUMNS}
`;

/**
 * Statement tạo outbox row từ **chính hàng message vừa chèn**.
 *
 * `WHERE … AND id = ?` là điểm then chốt: khi statement 1 thua conflict thì hàng của ta không
 * nằm trong bảng (id của ta chưa từng được chèn), nên `SELECT` không khớp hàng nào và không có
 * outbox row nào được tạo — người thua tạo **cả hai hoặc không cái nào**, trong cùng một batch.
 *
 * Cố ý **không** có `ON CONFLICT DO NOTHING`: nếu `delivery_id` đã bị một message khác dùng
 * (bug phía caller) thì ràng buộc vỡ và toàn bộ batch rollback, thay vì lặng lẽ để lại message
 * không có outbox row.
 */
const INSERT_OUTBOX_FROM_MESSAGE = `
INSERT INTO mail_outbox (
  id, delivery_id, dispatch_generation, status, publish_attempts, available_at,
  claimed_at, claimed_by, published_at, last_error, created_at, updated_at
)
SELECT ?, delivery_id, dispatch_generation, 'pending', 0, ?, NULL, NULL, NULL, NULL, ?, ?
FROM mail_messages
WHERE principal_id = ? AND idempotency_key = ? AND id = ?
RETURNING ${MAIL_OUTBOX_COLUMNS}
`;

const SELECT_BY_DELIVERY_ID = `SELECT ${MAIL_MESSAGE_COLUMNS} FROM mail_messages WHERE delivery_id = ?`;
const SELECT_BY_ID = `SELECT ${MAIL_MESSAGE_COLUMNS} FROM mail_messages WHERE id = ?`;
const SELECT_BY_IDEMPOTENCY_KEY = `SELECT ${MAIL_MESSAGE_COLUMNS} FROM mail_messages WHERE principal_id = ? AND idempotency_key = ?`;

/**
 * Guard của outcome callback: đúng generation **và** trạng thái còn in-flight.
 *
 * Không có nhánh nào đọc trạng thái rồi ghi không guard: nếu predicate sai thì statement trả 0
 * hàng và **không có gì thay đổi**.
 */
const UPDATE_OUTCOME = `
UPDATE mail_messages
SET status = ?, failure_reason = ?, terminal_at = ?, updated_at = ?
WHERE delivery_id = ? AND dispatch_generation = ? AND status IN ('accepted', 'queued')
RETURNING ${MAIL_MESSAGE_COLUMNS}
`;

/** Repository D1 của `mail_messages`. Xem JSDoc của từng method trong port. */
export class D1MailMessageRepository implements MailMessageRepository {
  readonly #db: D1SubsetDatabase;

  constructor(db: D1SubsetDatabase) {
    this.#db = db;
  }

  async createWithOutbox(
    input: CreateMailMessageWithOutboxInput,
  ): Promise<CreateMailMessageWithOutboxResult> {
    // Chỉ **dựng** statement, không gọi `all()` ở ngoài batch: gọi `all()` trước là đã gửi đi
    // một statement chạy riêng, và batch sẽ gửi lại lần nữa — đúng thứ phải tránh khi hai
    // statement phải nằm trong một transaction.
    const insertMessage = this.#db
      .prepare(INSERT_MESSAGE)
      .bind(
        input.messageId,
        input.app,
        input.principalId,
        input.templateId,
        input.templateName,
        input.templateVersion,
        input.locale,
        input.recipient,
        input.subjectRendered,
        input.bodyRendered,
        input.deliveryId,
        input.idempotencyKey,
        input.requestFingerprint,
        input.correlationId,
        input.nowMs,
        input.nowMs,
      );
    const insertOutbox = this.#db
      .prepare(INSERT_OUTBOX_FROM_MESSAGE)
      .bind(
        input.outboxId,
        input.nowMs,
        input.nowMs,
        input.nowMs,
        input.principalId,
        input.idempotencyKey,
        input.messageId,
      );

    const [createdRows, outboxRows] = await this.#db.batch([insertMessage, insertOutbox]);

    // `batch<T>` dùng chung một `T` cho mọi statement, còn hai statement này trả hai shape
    // khác nhau — nên ép kiểu tại đây, cho từng statement. Shape thật của từng cột được kiểm
    // bằng spec trên D1 thật, không phải bằng dòng cast này.
    const createdRow = createdRows.results[0] as MailMessageRow | undefined;

    if (createdRow) {
      // Người thắng: outbox phải đi theo đúng một hàng.
      if (outboxRows.results.length !== 1) {
        throw new Error('createWithOutbox: message was created without its outbox row');
      }
      return { kind: 'created', message: toMailMessageRecord(createdRow) };
    }

    if (outboxRows.results.length !== 0) {
      throw new Error('createWithOutbox: conflict path must not create an outbox row');
    }

    // Người thua: batch thành công nhưng không ghi gì. Chỉ-đọc để lấy bản ghi cũ — không có
    // WRITE nào sau phép đọc này.
    const existing = await this.#db
      .prepare(SELECT_BY_IDEMPOTENCY_KEY)
      .bind(input.principalId, input.idempotencyKey)
      .all<MailMessageRow>();

    const existingRow = existing.results[0];
    if (!existingRow) {
      // Unique index báo conflict mà hàng thì không có: chỉ xảy ra nếu có bên thứ ba xoá hàng
      // trong lúc này. C1 không có đường xoá, nên đây là internal error — trả `null` sẽ biến
      // một bất biến bị phá thành kết quả "hợp lệ" im lặng.
      throw new Error('createWithOutbox: conflicting message row disappeared after the batch');
    }

    return { kind: 'already-exists', message: toMailMessageRecord(existingRow) };
  }

  async findByIdempotencyKey(
    principalId: string,
    idempotencyKey: string,
  ): Promise<MailMessageRecord | null> {
    const found = await this.#db
      .prepare(SELECT_BY_IDEMPOTENCY_KEY)
      .bind(principalId, idempotencyKey)
      .all<MailMessageRow>();
    const row = found.results[0];
    return row ? toMailMessageRecord(row) : null;
  }

  async findByDeliveryId(deliveryId: string): Promise<MailMessageRecord | null> {
    const found = await this.#db
      .prepare(SELECT_BY_DELIVERY_ID)
      .bind(deliveryId)
      .all<MailMessageRow>();
    const row = found.results[0];
    return row ? toMailMessageRecord(row) : null;
  }

  async findById(messageId: string): Promise<MailMessageRecord | null> {
    const found = await this.#db.prepare(SELECT_BY_ID).bind(messageId).all<MailMessageRow>();
    const row = found.results[0];
    return row ? toMailMessageRecord(row) : null;
  }

  async applyDeliveryOutcome(
    input: ApplyMailDeliveryOutcomeInput,
  ): Promise<ApplyMailDeliveryOutcomeResult> {
    // `terminal_at` chỉ có mặt khi outcome là terminal — parity với constraint
    // `mail_messages_terminal_at_parity_check`; `blocked` là non-terminal nên giữ NULL.
    const terminalAtMs =
      input.outcome === 'sent' || input.outcome === 'failed' ? input.nowMs : null;

    const applied = await this.#db
      .prepare(UPDATE_OUTCOME)
      .bind(
        input.outcome,
        input.errorClass,
        terminalAtMs,
        input.nowMs,
        input.deliveryId,
        input.dispatchGeneration,
      )
      .all<MailMessageRow>();

    const appliedRow = applied.results[0];
    if (appliedRow) {
      return { result: 'applied', status: appliedRow.status };
    }

    // Guard chặn: chỉ-đọc để phân loại theo đúng thứ tự §6.2.2. Không có WRITE nào đi sau
    // phép đọc này, nên pattern này không phải read-then-write.
    const found = await this.#db
      .prepare(SELECT_BY_DELIVERY_ID)
      .bind(input.deliveryId)
      .all<MailMessageRow>();
    const current = found.results[0];

    if (!current) {
      return { result: 'not-found' };
    }

    // 2. generation lệch → stale (trước mọi kiểm tra khác, kể cả khi status trùng outcome).
    if (current.dispatch_generation !== input.dispatchGeneration) {
      return {
        result: 'stale',
        status: current.status,
        currentDispatchGeneration: current.dispatch_generation,
      };
    }

    // 3. cùng generation, status đã bằng đúng outcome → duplicate.
    if (current.status === input.outcome) {
      return { result: 'duplicate', status: current.status };
    }

    // 4. guard đáng lẽ đã khớp nhưng statement 1 trả 0 hàng: trạng thái đổi giữa hai statement.
    // Không được báo `applied` vì không có gì được ghi; báo `stale` là nhánh fail-closed.
    // Theo state machine đã chốt thì nhánh này bất biến: `dispatch_generation` chỉ tăng (redrive
    // luôn kèm `generation++`, nên redrive làm lệch generation thay vì đưa status về in-flight),
    // và không đường nào đưa status terminal về `accepted`/`queued` mà không redrive.
    return {
      result: 'stale',
      status: current.status,
      currentDispatchGeneration: current.dispatch_generation,
    };
  }
}
