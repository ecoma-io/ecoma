/**
 * SQL đọc dữ liệu authorization và dữ liệu read routes từ `db-backoffice`.
 *
 * Đường chạy thật của #99: {@link loadPrincipalAuthorization} đọc ảnh
 * assignment của principal (schema `backoffice` của workstream A), còn
 * {@link listStaff}, {@link listRoles}, {@link listPermissions} là payload
 * của 3 read route.
 *
 * ## Nguyên tắc kết nối
 *
 * ⚠️ Mọi query qua runtime role `ecoma_backoffice_runtime` (credential của
 * Hyperdrive binding) — grant của role này trên từng bảng là ranh giới
 * database của SR-010/invariant 11 (`0002_roles_and_grants.sql`). Một cột
 * `password`/`email` sinh ra sau này sẽ không có trong kết quả nếu nó không
 * đứng trong danh sách dưới đây — danh sách cột là **allowlist**, không phải
 * `SELECT *` (bài học `selectAccountStatus` của `account`).
 *
 * ⚠️ Tham số hoá toàn bộ (`$1`, ...) — không có string interpolation của giá
 * trị nào vào SQL.
 */

import type { GrantedAssignment } from '@ecoma-io/backoffice-domain';
import { isBackofficeStaffStatus } from '@ecoma-io/backoffice-domain';
import type { PoolClient } from 'pg';
import {
  fetchRoleCatalog,
  fetchStaffAssignments,
  fetchStaffDirectory,
} from './staff-access/client';
import type { StaffAccessClientConfig } from './staff-access/client';

/** Dữ liệu authorization của một principal — đúng shape mà `requirePermission` nhận. */
export interface PrincipalAuthorizationData {
  readonly assignments: readonly GrantedAssignment[];
}

/**
 * Đọc ảnh assignment của một staff từ DB thật.
 *
 * Câu lệnh gộp **một lượt** fetch: joins `staff` + `role_assignments` +
 * `role_permissions` để đọc cùng một mốc dữ liệu (một connection một lượt),
 * trả hàng của từng assignment kèm tập permission của role và staff status
 * đọc cùng lượt. Hàng mà permission rỗng (role trống) được gộp về
 * `assignment.permissions = []` — policy của `can()` deny nó ngay
 * (`permission_not_granted`).
 *
 * ⚠️ **Read-time filter đúng thiết kế §4.6 của `0001`**: hết hạn tự nhiên
 * (`valid_until <= now()`) là trạng thái **đọc ra** ở app layer, row vẫn còn
 * trên DB để audit — policy (workstream B) lọc nó và phân `assignment_expired`.
 * Module này **không** lọc `revoked_at`/`valid_until` trong SQL: lọc ở đây là
 * lặp logic của policy và làm mất đúng lý do `revoked`/`expired` khi row đã
 * bị ẩn. Vì vậy cột `revoked_at` và `valid_until` phải được chọn **nguyên trạng**
 * — policy mới là nơi quyết định.
 *
 * ⚠️ `staff.status` đọc cùng lượt fetch — invariant 5 (A24): "token validity
 * ≠ privilege currency" chỉ đúng khi ảnh status gắn với cùng lượt đọc dũ
 * liệu assignment.
 */
export interface AuthorizationProjection {
  readonly assignments: readonly GrantedAssignment[];
  /** Sync timestamp used as fetchedAt so can()'s stale computation stays meaningful. */
  readonly fetchedAt: Date;
  readonly source: 'staff-access';
}

/**
 * Projection loader — đọc authorization state từ Staff Access (assignments +
 * role catalog + staff status) và dựng cùng `GrantedAssignment[]` shape với
 * legacy loader. `fetchedAt` là mốc sync, không phải thời điểm row được tạo.
 *
 * ADR-0009: không sync-call mỗi request sang backoffice decision; đây là đọc
 * state đã đồng bộ (batch/event-based), không phải authorization-result contract.
 */
export async function loadPrincipalAuthorizationProjection(
  config: StaffAccessClientConfig,
  actorSub: string,
): Promise<AuthorizationProjection | null> {
  const directory = await fetchStaffDirectory(config);
  if (!directory.ok) return null;
  const staff = directory.staff.find((member) => member.sub === actorSub);
  if (staff === undefined)
    return { assignments: [], fetchedAt: new Date(), source: 'staff-access' };

  const [assignmentsResult, rolesResult] = await Promise.all([
    fetchStaffAssignments(config, staff.id),
    fetchRoleCatalog(config),
  ]);
  if (!assignmentsResult.ok || !rolesResult.ok) return null;

  const rolePermissions = new Map<string, readonly string[]>();
  for (const role of rolesResult.roles) {
    rolePermissions.set(role.id, role.permissions);
  }

  const fetchedAt = new Date();
  const assignments: GrantedAssignment[] = assignmentsResult.assignments.map((assignment) => ({
    permissions: rolePermissions.get(assignment.role_id) ?? [],
    validUntil:
      assignment.effective_until === undefined || assignment.effective_until === null
        ? null
        : new Date(assignment.effective_until),
    revokedAt:
      assignment.revoked_at === undefined || assignment.revoked_at === null
        ? null
        : new Date(assignment.revoked_at),
    fetchedAt,
    staffStatus: isBackofficeStaffStatus(staff.status) ? staff.status : 'terminated',
  }));

  return { assignments, fetchedAt, source: 'staff-access' };
}

export async function loadPrincipalAuthorization(
  client: PoolClient,
  actorSub: string,
): Promise<PrincipalAuthorizationData> {
  const result = await client.query<{
    // `permissions` string[] do `role_permissions` join; concatenation 1:N.
    permissions: string[];
    valid_until: string | null;
    revoked_at: string | null;
    fetched_at: string;
    staff_status: string;
  }>(
    `
    SELECT
      COALESCE(
        ARRAY_AGG(rp.permission_id) FILTER (WHERE rp.permission_id IS NOT NULL),
        '{}'
      ) AS permissions,
      ra.valid_until AS valid_until,
      ra.revoked_at  AS revoked_at,
      ra.created_at  AS fetched_at,
      s.status       AS staff_status
    FROM backoffice.staff s
    LEFT JOIN backoffice.role_assignments ra ON ra.staff_sub = s.sub
    LEFT JOIN backoffice.role_permissions rp ON rp.role_id = ra.role_id
    WHERE s.sub = $1
    GROUP BY ra.created_at, ra.valid_until, ra.revoked_at, s.status
  `,
    [actorSub],
  );

  // Principal không có staff row — caller coi như tập assignment rỗng:
  // denied-by-default bởi `can()` (không allow "không tìm thấy staff").
  const assignments: GrantedAssignment[] = result.rows.map((row) => ({
    permissions: row.permissions,
    validUntil: row.valid_until === null ? null : new Date(row.valid_until),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
    fetchedAt: new Date(row.fetched_at),
    // Nhãn lạ (viết tay DB hay lỗi migration) KHÔNG được coi là `active`:
    // `isBackofficeStaffStatus` bảo đảm nhãn chỉ nhận tập ba:
    staffStatus: isBackofficeStaffStatus(row.staff_status) ? row.staff_status : 'terminated',
  }));

  return { assignments };
}

/** Một staff row như read route trả — đúng những gì bảng có, không UI format. */
export interface StaffRow {
  readonly sub: string;
  readonly status: string;
}

/**
 * Liệt kê staff directory (read route `GET /api/staff`).
 *
 * ⚠️ Cột là allowlist: `sub` + `status` — không email (schema 0001 cũng không
 * có), không created_at/updated_at (không format, không UI field nào ở PR này).
 */
export async function listStaff(client: PoolClient): Promise<StaffRow[]> {
  const result = await client.query<{ sub: string; status: string }>(
    `SELECT sub, status FROM backoffice.staff ORDER BY sub`,
  );
  return result.rows;
}

/** Một role row như read route trả. */
export interface RoleRow {
  readonly id: string;
  readonly isSystem: boolean;
}

/**
 * Liệt kê role catalog (read route `GET /api/roles`).
 *
 * `is_system` map về camelCase ở tầng JS, không ở SQL alias dài.
 */
export async function listRoles(client: PoolClient): Promise<RoleRow[]> {
  const result = await client.query<{ id: string; is_system: boolean }>(
    `SELECT id, is_system FROM backoffice.roles ORDER BY id`,
  );
  return result.rows.map((row) => ({ id: row.id, isSystem: row.is_system }));
}

/**
 * Liệt kê permission catalog (read route `GET /api/permissions`).
 *
 * ⚠️ Có thể trả cả row `retired`: catalog là sealed history (retired là
 * terminal) và viewer có `permission.read` được coi là đủ tin để thấy chúng.
 * Lọc `retired` ở UI là quyết định hiển thị, không phải quyết định ở API.
 */
export async function listPermissions(client: PoolClient): Promise<
  {
    readonly id: string;
    readonly domain: string;
    readonly action: string;
    readonly status: string;
  }[]
> {
  const result = await client.query<{
    id: string;
    domain: string;
    action: string;
    status: string;
  }>(`SELECT id, domain, action, status FROM backoffice.permissions ORDER BY id`);
  return result.rows;
}
