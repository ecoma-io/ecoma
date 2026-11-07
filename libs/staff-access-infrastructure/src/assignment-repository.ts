import type { StaffAccessQueryable } from './postgres';

/**
 * Repository của `staff_access.role_assignments` — gán role cho staff member
 * (`01-architecture.md` §4.5), giữ lịch sử: thu hồi là UPDATE `revoked_at`
 * có chủ đích, không DELETE (§4.6).
 *
 * ⚠️ **SR-005 (cấm self-assignment/self-elevation) là enforcement của tầng
 * application + guard tầng database** (`0002`/schema trigger), không phải của
 * repo: repo không có logic "check quyền granter" — một đường kiểm giả ở đây
 * sẽ bị coi là đã enforce trong khi đường gọi thẳng DB vẫn lọt. Repo chỉ là
 * adapter của schema.
 *
 * Milestone A expose: read (theo staff/role), append-only write path dùng bởi
 * bootstrap/seed có audit. Grant UPDATE của runtime ở 0002 chỉ dành cho revoke
 * — module này không có hàm nào un-revoke hay kéo dài hạn (trigger `0002`
 * chặn runtime làm điều đó; repo không đặt tên hàm gợi ý ngược lại).
 */

/** Một hàng assignment như schema trả về. */
export interface AssignmentRow {
  readonly id: string;
  readonly staff_id: string;
  readonly role_id: string;
  /** JSONB scope — hình dạng dữ liệu do tầng application quyết (điểm mở §4.5). */
  readonly scope: unknown;
  readonly effective_from: string;
  readonly effective_until: string | null;
  readonly granted_by: string | null;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

/** Lấy một assignment theo id. */
export async function getAssignmentById(
  db: StaffAccessQueryable,
  id: string,
): Promise<AssignmentRow | null> {
  const rows = await db.unsafe<AssignmentRow>(
    `SELECT id, staff_id, role_id, scope, effective_from, effective_until,
            granted_by, created_at, revoked_at
       FROM staff_access.role_assignments
      WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Liệt kê assignment của một staff member, mới nhất trước — đường read cho audit và list API. */
export async function listAssignmentsForStaff(
  db: StaffAccessQueryable,
  staffId: string,
): Promise<readonly AssignmentRow[]> {
  return db.unsafe<AssignmentRow>(
    `SELECT id, staff_id, role_id, scope, effective_from, effective_until,
            granted_by, created_at, revoked_at
       FROM staff_access.role_assignments
      WHERE staff_id = $1
      ORDER BY created_at DESC, id DESC`,
    [staffId],
  );
}

/**
 * Tạo assignment — đường privileged có audit. `grantedBy` nullable: NULL cho
 * bootstrap/migrator-created rows; runtime wiring actor thuộc T-10 (verified
 * principal từ BFF, không từ request body). Schema không enforce actor cho
 * runtime insert; audit trail gap được track riêng (M1).
 */
export async function insertAssignment(
  db: StaffAccessQueryable,
  assignment: {
    readonly id: string;
    readonly staffId: string;
    readonly roleId: string;
    readonly scope: unknown;
    readonly effectiveFrom?: string;
    readonly effectiveUntil?: string | null;
    readonly grantedBy?: string | null;
  },
): Promise<void> {
  await db.unsafe(
    `INSERT INTO staff_access.role_assignments
       (id, staff_id, role_id, scope, effective_from, effective_until, granted_by)
     VALUES ($1, $2, $3, $4::jsonb,
             COALESCE($5::timestamptz, now()), $6::timestamptz, $7)`,
    [
      assignment.id,
      assignment.staffId,
      assignment.roleId,
      assignment.scope === undefined ? null : JSON.stringify(assignment.scope),
      assignment.effectiveFrom ?? null,
      assignment.effectiveUntil ?? null,
      assignment.grantedBy ?? null,
    ],
  );
}

/** Thu hồi có chủ đích — UPDATE `revoked_at` đúng nghĩa §4.6, trả số hàng bị đổi. */
export async function revokeAssignment(
  db: StaffAccessQueryable,
  id: string,
  revokedAt: string,
): Promise<number> {
  const rows = await db.unsafe<{ id: string }>(
    `UPDATE staff_access.role_assignments
        SET revoked_at = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [id, revokedAt],
  );
  return rows.length;
}
