import {
  QUARANTINE_REASON_VALUES,
  MailJobValidationError,
  assertClosedValue,
  assertBoundedString,
  assertSafeInteger,
  sanitizeFieldName,
  type QuarantineRecord,
  type QuarantineRepository,
  type UpsertQuarantineRecordParams,
  type UpsertQuarantineRecordResult,
} from '@ecoma-io/transactional-mailer-job-application';

import { readChanges, type D1DatabaseLike } from './d1-database-like';
import { decodeQuarantineRow, QUARANTINE_COLUMNS } from './mail-job-row';

const QCOLS = QUARANTINE_COLUMNS.join(', ');

export type D1QuarantineRepositoryOptions = {
  readonly db: D1DatabaseLike;
};

/**
 * Repository D1 cho bảng `quarantine` (`03-operations.md` §3.1).
 *
 * ## Data policy — bản ghi này cố tình **không** có raw payload
 *
 * Bảng chỉ lưu: digest HMAC của raw body (`quarantine_id`), id message của Queue,
 * `reason`, **tên** key vi phạm (không phải value), counter và timestamps. Không có
 * cột nào cho payload thô, recipient, subject/body, value của key vi phạm hay
 * credential — schema không có chỗ để lưu chúng, và decoder không thêm gì.
 *
 * `quarantine_id` là HMAC-SHA-256 của **raw** bytes do worker tự tính (khoá là Worker
 * Secret). Repository này chỉ nhận digest **đã tính sẵn**; nó không có raw body và
 * không bao giờ re-serialize một object đã parse rồi gọi đó là raw input — encoding của
 * raw Queue payload là một quyết định riêng của worker (`unparseable-body` path), chưa
 * chốt trong tài liệu và J1 không tự quyết.
 */
export class D1QuarantineRepository implements QuarantineRepository {
  readonly #db: D1DatabaseLike;

  constructor(options: D1QuarantineRepositoryOptions) {
    this.#db = options.db;
  }

  async #read(quarantineId: string, queueMessageId: string): Promise<QuarantineRecord | null> {
    const row = await this.#db
      .prepare<Record<string, unknown>>(
        `SELECT ${QCOLS} FROM quarantine WHERE quarantine_id = ? AND queue_message_id = ?`,
      )
      .bind(quarantineId, queueMessageId)
      .first();
    return row === null ? null : decodeQuarantineRow(row);
  }

  /**
   * Ghi một bản ghi quarantine, hoặc tăng counter nếu cặp khoá đã tồn tại.
   *
   * Ghi lặp cùng một `(quarantine_id, queue_message_id)` phải **idempotent** theo nghĩa
   * "một bản ghi, counter tăng" — không tạo bản ghi trùng và không ghi đè bản ghi của một
   * Queue message khác có cùng digest (khoá chính tổ hợp chính là để giữ hai message
   * khác nhau là hai bản ghi riêng).
   *
   * `ON CONFLICT DO UPDATE` chỉ chạm `attempts`/`updated_at` — nó **không** chạm
   * `reason`/`field_name`/`created_at`, nên lần ghi đầu tiên là nguồn của việc phân loại
   * và các lần sau chỉ phản ánh "đã thấy lại bao nhiêu lần". Ghi đè `reason` sẽ làm mất
   * dấu vết phân loại gốc.
   */
  async upsertQuarantineRecord(
    params: UpsertQuarantineRecordParams,
  ): Promise<UpsertQuarantineRecordResult> {
    // Validate trước khi chạm D1 (§6): reason là closed set (CHECK của schema chỉ là
    // lưới an toàn thứ hai), id là chuỗi bắt buộc, `field_name` đi qua sanitizer riêng —
    // KHÔNG dùng error-token sanitizer vì key như `api_key` chứa `_` là canonical.
    assertBoundedString(params.quarantineId, 'quarantineId');
    assertBoundedString(params.queueMessageId, 'queueMessageId');
    assertClosedValue(params.reason, QUARANTINE_REASON_VALUES, 'reason');
    assertSafeInteger(params.nowMs, 'nowMs');
    // Parity của `forbidden-field` (CHECK `quarantine_forbidden_field_name_check`):
    // kiểm trước để lỗi là lỗi caller tường minh, không phải lỗi SQLITE sau khi chạy.
    if (params.reason === 'forbidden-field' && params.fieldName === undefined) {
      throw new MailJobValidationError(
        'fieldName is required when reason is forbidden-field',
        'field-name-required',
      );
    }
    const fieldName =
      params.fieldName === undefined ? null : sanitizeFieldName(params.fieldName, 'fieldName');

    const result = await this.#db
      .prepare(
        `INSERT INTO quarantine
           (quarantine_id, queue_message_id, reason, field_name, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (quarantine_id, queue_message_id) DO UPDATE SET
           attempts = quarantine.attempts + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(
        params.quarantineId,
        params.queueMessageId,
        params.reason,
        fieldName,
        params.nowMs,
        params.nowMs,
      )
      .run();

    const changes = readChanges(result) ?? 0;
    if (changes === 0) {
      // Không có write nào xảy ra: nghĩa là platform trả về 0 dù statement đã match.
      // Coi đây là lỗi thay vì báo thành công — upsert không được im lặng bỏ qua.
      throw new Error('quarantine upsert reported zero changes');
    }

    const record = await this.#read(params.quarantineId, params.queueMessageId);
    if (record === null) {
      throw new Error('quarantine upsert wrote a row that could not be read back');
    }

    // Một upsert vừa insert có `attempts === 1`; một upsert vừa update có `attempts >= 2`
    // vì DO UPDATE đã cộng thêm 1. Counter là persisted, nên trong D1 single-flight
    // (một query một lần) lần đọc lại sau khi ghi không thể bị xen bởi upsert khác
    // trên cùng key. Trên một backend đa luồng thật, hai upsert đồng thời có thể khiến
    // caller insert nhận nhãn `updated` — chỉ ảnh hưởng ngữ nghĩa metrics, counter
    // vẫn đúng; không dùng read-before-write để phân biệt (sẽ mở race).
    return record.attempts === 1 ? { kind: 'created', record } : { kind: 'updated', record };
  }

  async getQuarantineRecord(params: {
    quarantineId: string;
    queueMessageId: string;
  }): Promise<QuarantineRecord | null> {
    return this.#read(params.quarantineId, params.queueMessageId);
  }
}
