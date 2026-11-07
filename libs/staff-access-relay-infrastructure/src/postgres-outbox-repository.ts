import type { Pool } from 'pg';

import type {
  ClaimPendingInput,
  MarkPublishedInput,
  OutboxRepository,
  OutboxRow,
  RecordFailureInput,
  MarkSettledInput,
} from '@ecoma-io/staff-access-relay-application';

/**
 * Outbox repository trên PostgreSQL thật — cài đặt {@link OutboxRepository} của
 * application lib bằng driver `pg` qua Hyperdrive (pattern `apps/auth-nonce-prune-job`).
 *
 * ⚠️ **Fencing bằng `attempts + 1` NGAY TẠI CLAIM** — một statement UPDATE ...
 * RETURNING là đơn vị nguyên tử duy nhất: hai relay chạy song song serialize ở
 * row lock, mỗi bên nhận một giá trị `attempts` khác nhau. Không có cột lease
 * nào trong schema 0004 (đã merge, không sửa), và thêm cột đòi migration 0005 —
 * khóa lô bằng lock-held-while-publish không khả thi với pool autocommit, nên
 * claim-tăng-attempts là thiết kế được chọn: publish duplicate là chấp nhận
 * được (at-least-once, ưu tiên duplicate hơn mất message), còn `attempts` đạt
 * trần là DLQ — filter `attempts < maxAttempts` của claim không bao giờ lấy lại
 * row đó nếu không replay manual.
 */

/** Hàng thô của `pg` — jsonb về object, timestamptz về Date. */
interface RawOutboxRow {
  readonly event_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly occurred_at: Date | string;
  readonly published_at: Date | string | null;
  readonly settle_status: string | null;
  readonly attempts: number | string;
  readonly last_error: string | null;
}

/** Chuẩn hóa một giá trị timestamp của driver về ISO string (hoặc null). */
function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function toOutboxRow(raw: RawOutboxRow): OutboxRow {
  const payload =
    typeof raw.payload === 'string' ? raw.payload : JSON.stringify(raw.payload ?? null);
  return {
    event_id: raw.event_id,
    aggregate_type: raw.aggregate_type,
    aggregate_id: raw.aggregate_id,
    event_type: raw.event_type,
    payload,
    occurred_at: iso(raw.occurred_at) ?? '',
    published_at: iso(raw.published_at),
    settle_status: raw.settle_status,
    attempts: Number(raw.attempts),
    last_error: raw.last_error,
  };
}

/** Sanitize token lỗi: chỉ token ASCII ngắn, không bao giờ nguyên văn error body. */
function errorToken(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z0-9_]{1,64}$/u.test(error.name)) {
    return error.name;
  }
  return 'unknown_error';
}

/**
 * Dựng outbox repository trên một pool `pg` đã có — caller sở hữu pool lifecycle
 * (composition root của app dựng pool từ Hyperdrive binding, pattern nonce-prune-job).
 */
export function createPostgresOutboxRepository(pool: Pool): OutboxRepository {
  return {
    async claimPending(input: ClaimPendingInput): Promise<readonly OutboxRow[]> {
      // MỘT statement: CTE khóa lô bằng FOR UPDATE SKIP LOCKED, outer UPDATE
      // tăng attempts (fencing) rồi RETURNING. Hai relay song song không bao
      // giờ nhận chung một row — bên đến sau bỏ qua row đang khóa (SKIP LOCKED)
      // hoặc thấy attempts mới.
      const result = await pool.query<RawOutboxRow>(
        `WITH claimed AS (
           SELECT event_id
             FROM staff_access.entitlement_outbox_events
            WHERE published_at IS NULL
              AND attempts < $2
            ORDER BY occurred_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE staff_access.entitlement_outbox_events t
            SET attempts = t.attempts + 1
           FROM claimed c
          WHERE t.event_id = c.event_id
         RETURNING t.event_id, t.aggregate_type, t.aggregate_id, t.event_type,
                   t.payload, t.occurred_at, t.published_at, t.settle_status, t.attempts, t.last_error`,
        [input.limit, input.maxAttempts],
      );
      return result.rows.map(toOutboxRow);
    },

    async markPublished(input: MarkPublishedInput): Promise<boolean> {
      // Guard `published_at IS NULL`: row đã bị publish/replay giữa chừng thì
      // lần mark này không ghi đè — đúng nghĩa "chỉ lần đầu thắng".
      const result = await pool.query<{ event_id: string }>(
        `UPDATE staff_access.entitlement_outbox_events
            SET published_at = $2::timestamptz, last_error = NULL
          WHERE event_id = $1 AND published_at IS NULL
         RETURNING event_id`,
        [input.eventId, new Date(input.nowMs).toISOString()],
      );
      return result.rowCount === 1;
    },

    async recordFailure(input: RecordFailureInput): Promise<boolean> {
      // attempts ĐÃ tăng ở claim — statement này chỉ ghi token lỗi. Token được
      // sanitize trước khi tới đây; cột last_error không nhận nguyên văn body.
      // Tên biến là errorName (không phải token): giá trị chỉ là Error.name
      // đã sanitize, không phải secret nào — đặt tên đúng để rule
      // security-sensitive-value-in-http-response không đo nhầm nguồn taint.
      const errorName = errorToken(input.lastError);
      const result = await pool.query<{ event_id: string }>(
        `UPDATE staff_access.entitlement_outbox_events
            SET last_error = $2
          WHERE event_id = $1
         RETURNING event_id`,
        [input.eventId, errorName],
      );
      return result.rowCount === 1;
    },

    async replay(eventId: string): Promise<boolean> {
      // Đường manual duy nhất đưa một row DLQ quay lại hàng chờ.
      const result = await pool.query<{ event_id: string }>(
        `UPDATE staff_access.entitlement_outbox_events
            SET published_at = NULL, attempts = 0, last_error = NULL,
                settle_status = NULL, settled_at = NULL
          WHERE event_id = $1
         RETURNING event_id`,
        [eventId],
      );
      return result.rowCount === 1;
    },

    async markSettled(input: MarkSettledInput): Promise<boolean> {
      // Settlement reconciler pass: only writes settle_status from a consumer
      // receipt. Never touches published_at/attempts (publish ownership).
      const result = await pool.query<{ event_id: string }>(
        `UPDATE staff_access.entitlement_outbox_events
            SET settle_status = 'applied'
          WHERE event_id = $1
         RETURNING event_id`,
        [input.eventId],
      );
      return result.rowCount === 1;
    },
  };
}

export { errorToken };
