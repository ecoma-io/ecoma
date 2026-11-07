import type { StaffAccessQueryable } from './postgres';

/**
 * Repository của `staff_access.roles` + `staff_access.role_permissions` —
 * role là tập permission có tên (`01-architecture.md` §4.4), không có bypass
 * role; nội dung role đọc qua JOIN với permission catalog.
 *
 * Milestone A chỉ có đường **read** (role + permission id của nó). Tạo/sửa
 * role là governance action — seed qua migration bằng migrator (ADR-0004),
 * không qua repo runtime.
 */

/** Một hàng role như schema trả về. */
export interface RoleRow {
  readonly id: string;
  readonly name: string;
  /** `system` = seed bằng migration; `custom` = tạo qua API — v1 tắt (ADR-0004). */
  readonly kind: string;
  /** `active | retired` — retired là terminal (insert-then-retire). */
  readonly status: string;
  readonly created_at: string;
}

/** Danh sách permission id gắn với một role, theo thứ tự catalog. */
export async function listRolePermissionIds(
  db: StaffAccessQueryable,
  roleId: string,
): Promise<readonly string[]> {
  const rows = await db.unsafe<{ permission_id: string }>(
    `SELECT rp.permission_id
       FROM staff_access.role_permissions rp
       JOIN staff_access.permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1
        AND p.status = 'active'
      ORDER BY rp.permission_id`,
    [roleId],
  );
  return rows.map((row) => row.permission_id);
}

/** Lấy một role theo id. */
export async function getRoleById(db: StaffAccessQueryable, id: string): Promise<RoleRow | null> {
  const rows = await db.unsafe<RoleRow>(
    `SELECT id, name, kind, status, created_at
       FROM staff_access.roles
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Liệt kê role còn active (read path của catalog role). */
export async function listActiveRoles(db: StaffAccessQueryable): Promise<readonly RoleRow[]> {
  return db.unsafe<RoleRow>(
    `SELECT id, name, kind, status, created_at
       FROM staff_access.roles
      WHERE status = 'active'
      ORDER BY id`,
  );
}

/**
 * Tập permission hiện hành của một staff member — hợp của các assignment còn
 * hiệu lực (chưa revoke, trong hạn). Đúng một câu SQL: `valid_until` là
 * read-time filter (`01` §4.6), `revoked_at` là thu hồi có chủ đích; bảng
 * `staff` được JOIN để staff `suspended`/`terminated` tự cắt tập quyền mà
 * không cần đường JS riêng (`01` §6: token validity ≠ privilege currency —
 * check đọc trạng thái hiện hành).
 */
export async function listEffectivePermissionIdsForStaff(
  db: StaffAccessQueryable,
  staffId: string,
): Promise<readonly string[]> {
  const rows = await db.unsafe<{ permission_id: string }>(
    `SELECT DISTINCT rp.permission_id
       FROM staff_access.role_assignments ra
       JOIN staff_access.staff s ON s.id = ra.staff_id
       JOIN staff_access.roles r ON r.id = ra.role_id
       JOIN staff_access.role_permissions rp ON rp.role_id = r.id
       JOIN staff_access.permissions p ON p.id = rp.permission_id
      WHERE ra.staff_id = $1
        AND ra.revoked_at IS NULL
        AND (ra.effective_from IS NULL OR ra.effective_from <= now())
        AND (ra.effective_until IS NULL OR ra.effective_until >= now())
        AND r.status = 'active'
        AND p.status = 'active'
        AND s.status = 'active'
      ORDER BY rp.permission_id`,
    [staffId],
  );
  return rows.map((row) => row.permission_id);
}
