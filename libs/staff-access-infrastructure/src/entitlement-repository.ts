import {
  entitlementEvent,
  type EntitlementEvent,
  type EntitlementEventType,
} from '@ecoma-io/staff-access-contracts';
import type { StaffAccessQueryable, StaffAccessTransaction } from './postgres';

export type { EntitlementEvent };

/**
 * Chuẩn hoá giá trị `timestamptz` của driver về ISO 8601 string.
 *
 * `postgres.js` parse OID 1184 thành `Date`, nên kiểu khai báo trên row không
 * phải sự thật runtime; envelope {@link EntitlementEvent} của contract đòi ISO
 * string có offset hoặc `Z` (issue #252).
 */
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Repository của `staff_access.entitlements` + `staff_access.entitlement_outbox_events`
 * — read model gốc của tính khả dụng sản phẩm (ADR-0009: entitlement ≠
 * authorization; entry chỉ mang product availability, KHÔNG verdict/permission/role)
 * và outbox của event entitlement (P2.1, issue #437).
 *
 * ⚠️ **`revision` tăng đơn điệu theo `(staff_id, product)`** — trigger
 * `entitlements_revision_monotonic` của schema bảo đảm +1 trên mỗi lần đổi
 * trạng thái; repo KHÔNG nhận `revision` từ caller. Consumer so revision
 * (compare-and-drop) thay vì so `occurred_at` — hợp đồng của event/read model
 * (`entitlement-read-contract.ts` của contracts).
 *
 * ⚠️ **Invariant A8 (issue #437): mọi đường ghi entitlement sinh event CÙNG
 * transaction.** {@link upsertEntitlement} nhận **chỉ** {@link StaffAccessTransaction}
 * — một đường gọi nhầm với client (state commit mà event không) không biên dịch.
 * Event được dựng qua builder `entitlementEvent()` của contract đã lock (P1.2);
 * revision của event = revision của state change cùng lần; producer bị contract
 * ghim `'staff-access'`. Cơ chế relay/queue KHÔNG nằm ở đây — P2.2.
 */

/**
 * Một hàng entitlement như schema trả về.
 *
 * ⚠️ Kiểu khai báo ở đây **không đáng tin cho cột `timestamptz`**: `postgres.js`
 * parse OID 1184 thành `Date`, không phải `string`. `revision` thì đúng là
 * string — `bigint` về string từ driver. Caller phải chuẩn hoá `occurred_at` về
 * ISO 8601 string trước khi đưa vào contract wire hoặc event (issue #252).
 */
export interface EntitlementRow {
  readonly staff_id: string;
  readonly product: string;
  /** `entitled | revoked` — revoked là trạng thái ghi nhận, không xoá entry. */
  readonly status: string;
  readonly revision: string;
  /** `timestamptz` — xem cảnh báo ở JSDoc của interface. */
  readonly occurred_at: Date | string;
}

/**
 * Đổi trạng thái entitlement cho một cặp (staff, product) và ghi event outbox
 * **cùng transaction** — invariant A8 của P2.1 (issue #437).
 *
 * Hai INSERT/UPDATE trong một tx trên một {@link StaffAccessTransaction}:
 *
 * 1. `INSERT ... ON CONFLICT DO UPDATE ... RETURNING revision, occurred_at`:
 *    hai request đồng thời cho cùng cặp được PostgreSQL trọng tài bằng UNIQUE
 *    `(staff_id, product)` — không có read-then-write nào có thể rớt revision.
 *    Trigger của schema tính revision kế tiếp; `RETURNING` cho đúng revision
 *    sau bump và mốc hiệu lực `now()` duy nhất của lần ghi — envelope event
 *    dùng đúng hai giá trị đó, không sinh phía JS rồi lệch với database.
 * 2. INSERT outbox với `event_id` do caller sinh (`gen_random_uuid()` của
 *    app layer — database chỉ default khi không truyền; truyền tường minh là
 *    idempotency key của producer, theo pattern `account_outbox_events`).
 *
 * @param eventId — UUIDv4 mới cho lần phát này; lặp lại `eventId` cũ trên cùng
 *   cặp chết ở PK của outbox (đúng ý: hai lần gọi là hai lần đổi state, không
 *   bao giờ là cùng event).
 * @returns Envelope {@link EntitlementEvent} vừa ghi — revision và occurred_at
 *   khớp hàng database vừa commit.
 */
export async function upsertEntitlement(
  db: StaffAccessTransaction,
  entry: {
    readonly staffId: string;
    readonly product: string;
    readonly status: 'entitled' | 'revoked';
  },
  eventId: string,
): Promise<EntitlementEvent> {
  // Revision (bigint) về string từ driver — Number() an toàn trên dải
  // MAX_SAFE_INTEGER mà contract validate. `occurred_at` là `timestamptz` nên
  // driver trả `Date`: kiểu khai báo không đáng tin, phải chuẩn hoá trước khi
  // dựng event (issue #252).
  const rows = await db.unsafe<{ revision: string; occurred_at: Date | string }>(
    `INSERT INTO staff_access.entitlements (staff_id, product, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (staff_id, product)
     DO UPDATE SET status = EXCLUDED.status,
                   occurred_at = now(),
                   -- revision giữ nguyên giá trị cũ ở bước SET: EXCLUDED.revision
                   -- là default 1 (INSERT không truyền revision) và trigger
                   -- monotonic sẽ bump từ OLD — giữ NEW < OLD ở đây là làm lần
                   -- upsert thứ hai của cùng cặp chết ở guard (bug round 3,
                   -- 41070536326).
                   revision = staff_access.entitlements.revision
     RETURNING revision, occurred_at`,
    [entry.staffId, entry.product, entry.status],
  );
  const row = rows[0];
  if (row === undefined) {
    // ON CONFLICT arbiter khóa tràn: chỉ xảy ra khi staff_id không tồn tại
    // (FK vi phạm) hoặc product ngoài CHECK — database đã ném trước, dòng này
    // là lưới cho driver bất thường.
    throw new Error('entitlement upsert returned no row; state change did not happen');
  }
  const revision = Number(row.revision);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error(`entitlement revision is not a positive integer: ${row.revision}`);
  }
  const type: EntitlementEventType =
    entry.status === 'entitled' ? 'entitlement.granted' : 'entitlement.revoked';
  const event = entitlementEvent({
    eventId,
    type,
    staffId: entry.staffId,
    product: entry.product as EntitlementEvent['product'],
    revision,
    occurredAt: iso(row.occurred_at),
  });

  // Cùng transaction, đúng invariant A8: ném ở đây rollback cả hai đường ghi.
  await db.unsafe(
    `INSERT INTO staff_access.entitlement_outbox_events
       (event_id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
     VALUES ($1, 'entitlement', $2, $3, $4::jsonb, $5::timestamptz)`,
    [
      event.event_id,
      `${event.staff_id}/${event.product}`,
      event.type,
      JSON.stringify(event),
      event.occurred_at,
    ],
  );
  return event;
}

/** Đọc trạng thái hiện hành của một cặp (staff, product) — đường đọc, không cần transaction. */
export async function getEntitlement(
  db: StaffAccessQueryable,
  staffId: string,
  product: string,
): Promise<EntitlementRow | null> {
  const rows = await db.unsafe<EntitlementRow>(
    `SELECT staff_id, product, status, revision, occurred_at
       FROM staff_access.entitlements
      WHERE staff_id = $1 AND product = $2`,
    [staffId, product],
  );
  return rows[0] ?? null;
}

/**
 * Đọc toàn bộ entitlement của một staff — đường cho đồng bộ consumer khi cần
 * re-sync (batch/event-based per ADR-0009; không có sync-call per request).
 */
export async function listEntitlementsForStaff(
  db: StaffAccessQueryable,
  staffId: string,
): Promise<readonly EntitlementRow[]> {
  return db.unsafe<EntitlementRow>(
    `SELECT staff_id, product, status, revision, occurred_at
       FROM staff_access.entitlements
      WHERE staff_id = $1
      ORDER BY product`,
    [staffId],
  );
}

/** Consumer settle acknowledgement: set settled_at cho outbox row (idempotent).
 *  Trả true khi row tồn tại (bất kể đã settle trước đó hay vừa settle lần đầu);
 *  false chỉ khi event_id không tồn tại. Idempotent: gọi lại trên row đã settle
 *  vẫn trả true và không ghi đè settled_at gốc (COALESCE). */
export async function settleOutboxEvent(
  db: StaffAccessQueryable,
  eventId: string,
  settledAt: string,
): Promise<boolean> {
  const rows = await db.unsafe<{ event_id: string }>(
    `UPDATE staff_access.entitlement_outbox_events
        SET settled_at = COALESCE(settled_at, $2::timestamptz)
      WHERE event_id = $1
     RETURNING event_id`,
    [eventId, settledAt],
  );
  return rows.length === 1;
}
