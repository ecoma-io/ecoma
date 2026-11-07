import type { StaffAccessQueryable } from './postgres';

/**
 * Repository của `staff_access.permissions` — permission catalog, sealed
 * (invariant 10 / SR-020): runtime role chỉ có SELECT (grant 0002); seed và
 * retire là governance action qua migration bằng migrator.
 *
 * Milestone A chỉ có đường **read**. Không có đường INSERT/UPDATE nào ở repo
 * này — thêm đường ghi ở đây là tự mở catalog cho runtime, đúng thứ mà grant
 * tầng database đã chặn.
 */

/** Một hàng permission như schema trả về. */
export interface PermissionRow {
  /** Định danh đầy đủ `<domain>.<action>` — bằng đúng chuỗi của catalog (ADR-0010). */
  readonly id: string;
  readonly domain: string;
  readonly action: string;
  /** `active | retired` — retired là terminal (ADR-0010). */
  readonly status: string;
  readonly created_at: string;
}

/** Lấy một permission theo định danh đầy đủ. */
export async function getPermissionById(
  db: StaffAccessQueryable,
  id: string,
): Promise<PermissionRow | null> {
  const rows = await db.unsafe<PermissionRow>(
    `SELECT id, domain, action, status, created_at
       FROM staff_access.permissions
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Liệt kê permission còn active trong catalog. */
export async function listActivePermissions(
  db: StaffAccessQueryable,
): Promise<readonly PermissionRow[]> {
  return db.unsafe<PermissionRow>(
    `SELECT id, domain, action, status, created_at
       FROM staff_access.permissions
      WHERE status = 'active'
      ORDER BY id`,
  );
}
