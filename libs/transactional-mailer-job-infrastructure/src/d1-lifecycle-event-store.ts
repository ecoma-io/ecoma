import {
  MailJobValidationError,
  assertBoundedString,
  assertClosedValue,
  assertSafeInteger,
  MAIL_LIFECYCLE_EVENT_TYPE_VALUES,
  MAIL_LIFECYCLE_REASON_TOKEN_VALUES,
  type MailLifecycleEvent,
} from '@ecoma-io/transactional-mailer-job-application';

import { readChanges, type D1DatabaseLike } from './d1-database-like';

export type D1LifecycleEventStoreOptions = {
  readonly db: D1DatabaseLike;
};

/**
 * Store D1 cho `mail_lifecycle_events` (migration `0004`) — cài seam `store` của
 * `ingestLifecycleEventMessage` (application).
 *
 * ## Dedupe nằm ở PRIMARY KEY, không ở read-before-write
 *
 * `INSERT ... ON CONFLICT (event_id) DO NOTHING` + `meta.changes`: `changes === 0`
 * nghĩa là `event_id` đã có row — ingest trả `duplicate`, Queue message vẫn ack. Không
 * có read nào trước write nên hai delivery đồng thời của cùng event không sinh row đôi
 * — SQLite/D1 single-statement là nguyên tử.
 *
 * ## Correlation là một conditional UPDATE, không phải điều kiện INSERT
 *
 * Event được persist TRƯỚC, correlate với `mail_jobs` SAU (§11.3): event chưa tra được
 * delivery (`delivery_id` NULL) vẫn nằm lại — correlation bù sau là việc truy vấn.
 * Hai statement trong một `batch` của D1 là một transaction ngầm (implicit transaction
 * của batch API), fail statement hai không rollback statement một — đúng thứ tự
 * "persist trước, correlate là best-effort sau" đã chốt.
 */
export class D1LifecycleEventStore {
  readonly #db: D1DatabaseLike;

  constructor(options: D1LifecycleEventStoreOptions) {
    this.#db = options.db;
  }

  /**
   * Ghi event và trả `'stored'` | `'duplicate'`.
   *
   * Ném khi D1 lỗi — caller (`ingestLifecycleEventMessage`) map thành `transient`,
   * chưa có gì bền vững để mất.
   */
  async store(event: MailLifecycleEvent): Promise<'stored' | 'duplicate'> {
    // Validate trước khi chạm D1 — CHECK của schema chỉ là lưới an toàn thứ hai (§6).
    assertBoundedString(event.eventId, 'eventId');
    assertBoundedString(event.messageId, 'messageId');
    assertClosedValue(event.type, MAIL_LIFECYCLE_EVENT_TYPE_VALUES, 'event.type');
    assertSafeInteger(event.occurredAt, 'event.occurredAt');
    if (event.occurredAt < 0) {
      throw new MailJobValidationError('occurredAt must be >= 0', 'occurred-at-negative');
    }
    if (event.reasonToken !== null) {
      assertClosedValue(event.reasonToken, MAIL_LIFECYCLE_REASON_TOKEN_VALUES, 'event.reasonToken');
    }

    const results = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO mail_lifecycle_events
             (event_id, event_type, message_id, delivery_id, occurred_at, terminal, reason_token, created_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
           ON CONFLICT (event_id) DO NOTHING`,
        )
        .bind(
          event.eventId,
          event.type,
          event.messageId,
          event.occurredAt,
          event.terminal ? 1 : 0,
          event.reasonToken,
          event.occurredAt,
        ),
      // Best-effort correlate: khớp `provider_message_id` của delivery đang sống
      // (mọi status — event terminal vẫn hợp lệ cho row `sent` vì sender đã persist
      // trước). Không match thì không có gì xảy ra — event giữ `delivery_id` NULL.
      this.#db
        .prepare(
          `UPDATE mail_lifecycle_events SET delivery_id = (
           SELECT delivery_id FROM mail_jobs
           WHERE provider_message_id = ?1
           ORDER BY updated_at DESC
           LIMIT 1
         )
         WHERE event_id = ?2 AND delivery_id IS NULL`,
        )
        .bind(event.messageId, event.eventId),
    ]);

    const changes = readChanges(results[0]) ?? 0;
    return changes === 0 ? 'duplicate' : 'stored';
  }
}
