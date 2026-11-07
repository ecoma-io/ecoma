import type { RemoteCacheQueryable } from './postgres';

/**
 * Repository cua bang `remote_cache.tenants` — tenant cua bounded context
 * `remote-cache` (ADR-0015).
 *
 * ⚠️ **SQL la ban chep cua schema** (cung nguyen tac voi
 * `staff-access-infrastructure`): ten cot va constraint khop dung migration
 * `apps/remote-cache/db/migrations/0001_control_plane.sql`. Lech ten chi lo ra
 * khi chay voi schema that.
 *
 * ⚠️ **Tenant nay KHAC tenant cua pact-broker** (glossary §2.4, ADR-0015):
 * cung gia tri id khong bao gio nghia cung entity tren hai context — khong
 * FK, khong join cheo schema.
 */

/** Mot hang tenant nhu schema tra ve. */
export interface TenantRow {
  readonly id: string;
  readonly name: string;
  /** active/suspended/deleted — CHECK `tenant_status_check` o schema. */
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Lay tenant theo id. */
export async function getTenantById(
  db: RemoteCacheQueryable,
  id: string,
): Promise<TenantRow | null> {
  const rows = await db.unsafe<TenantRow>(
    `SELECT id, name, status, created_at, updated_at
       FROM remote_cache.tenants
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
