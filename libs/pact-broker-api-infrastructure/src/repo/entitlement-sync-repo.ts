/**
 * Repository của `pact.entitlement_sync_state` — revision entitlement event lớn
 * nhất đã áp dụng cho mỗi cặp (staff_id, product) (roadmap P3.2).
 *
 * ⚠️ Không có FK sang database khác (one-service-one-database), `staff_id` là
 * tham chiếu opaque của Staff Access directory (không phải `sub`).
 */

import type { Pool } from 'pg';

/** Một hàng entitlement_sync_state như schema trả về. */
export interface EntitlementSyncStateRow {
  readonly staff_id: string;
  readonly product: string;
  /** `revision` về dạng string từ pg driver — Number() an toàn dưới MAX_SAFE_INTEGER. */
  readonly revision: string;
  /** Provenance (nullable). */
  readonly entitlement_event_id: string | null;
  readonly entitlement_revision: string | null;
  readonly source: string | null;
}

/**
 * Port đọc/ghi revision đã áp dụng — dùng bởi application use case
 * `provisionEntitlementMembership`.
 */
export class PgEntitlementSyncRepo {
  constructor(private readonly pool: Pool) {}

  /**
   * Revision lớn nhất đã áp dụng cho cặp (staff_id, product), hoặc `null` nếu
   * chưa thấy event nào.
   */
  async readRevision(staffId: string, product: string): Promise<number | null> {
    const { rows } = await this.pool.query<EntitlementSyncStateRow>(
      `SELECT staff_id, product, revision, entitlement_event_id, entitlement_revision, source
         FROM pact.entitlement_sync_state
        WHERE staff_id = $1 AND product = $2`,
      [staffId, product],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const revision = Number(row.revision);
    if (!Number.isInteger(revision) || revision < 0) {
      throw new Error(`entitlement sync revision is not a non-negative integer: ${row.revision}`);
    }
    return revision;
  }

  /**
   * CAS ghi revision đã áp dụng cho cặp (staff_id, product). Trả về `true` nếu
   * revision tiến lên (applied), `false` nếu duplicate/stale (không ghi).
   * Atomic: một statement `INSERT ... ON CONFLICT ... WHERE revision <
   * EXCLUDED.revision RETURNING`.
   */
  async writeRevision(
    staffId: string,
    product: string,
    revision: number,
    provenance?: {
      readonly eventId?: string;
      readonly source?: 'entitlement' | 'bootstrap' | 'admin';
    },
  ): Promise<boolean> {
    if (!Number.isInteger(revision) || revision < 1 || revision > Number.MAX_SAFE_INTEGER) {
      throw new Error(`entitlement sync revision must be a positive safe integer: ${revision}`);
    }
    const { rows } = await this.pool.query<{ revision: string }>(
      `INSERT INTO pact.entitlement_sync_state
         (staff_id, product, revision, updated_at, entitlement_event_id, entitlement_revision, source)
       VALUES ($1, $2, $3, now(), $4, $3, $5)
       ON CONFLICT (staff_id, product)
       DO UPDATE SET revision = EXCLUDED.revision,
                     updated_at = now(),
                     entitlement_event_id = COALESCE(EXCLUDED.entitlement_event_id, pact.entitlement_sync_state.entitlement_event_id),
                     entitlement_revision = COALESCE(EXCLUDED.entitlement_revision, pact.entitlement_sync_state.entitlement_revision),
                     source = COALESCE(EXCLUDED.source, pact.entitlement_sync_state.source)
       WHERE pact.entitlement_sync_state.revision < EXCLUDED.revision
       RETURNING revision`,
      [staffId, product, revision, provenance?.eventId ?? null, provenance?.source ?? null],
    );
    return rows.length > 0;
  }
}
