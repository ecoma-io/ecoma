/**
 * Management contracts cho **role catalog** — đọc danh mục role và shape
 * assignment-safe mà assignment/entitlement consumer dùng.
 *
 * Source of truth (docs/domains/staff-access/):
 * - `01-architecture.md` §4.4: role là một tập permission có tên; **không có
 *   unrestricted `isAdmin` bypass role**; role hierarchy không dùng (ADR-0007).
 * - [ADR-0004](../../domains/staff-access/adr/0004-custom-role-administration.md):
 *   custom role administration **không bật** ở giai đoạn này — chỉ system-defined
 *   role.
 * - `01-architecture.md` §4.4: **nội dung của từng system-defined role chưa
 *   chốt** — nó phải xuất phát từ permission catalog thực tế. Contract này vì
 *   vậy KHÔNG seed/khai tên hay nội dung role system nào.
 *
 * ⚠️ **Đây là contract (shape wire), không phải API HTTP.** Endpoint URL và
 * method thuộc implement P1.4.
 */

/** Trần số bản ghi tối đa một trang list role. */
export const ROLE_LIST_MAX_LIMIT = 100;

/** Giá trị `limit` mặc định khi caller không truyền. */
export const ROLE_LIST_DEFAULT_LIMIT = 50;

/** Loại role theo nguồn phát hành — `system` do migration seed, `custom` do API (v1 tắt). */
export type RoleKind = 'system' | 'custom';

/** Vòng đời role — `retired` là terminal, tương tự permission retired (insert-then-retire). */
export type RoleStatus = 'active' | 'retired';

export const ROLE_KINDS = ['system', 'custom'] as const;
export const ROLE_STATUSES = ['active', 'retired'] as const;

/** Type guard cho {@link RoleKind}. */
export function isRoleKind(value: unknown): value is RoleKind {
  return typeof value === 'string' && (ROLE_KINDS as readonly string[]).includes(value);
}

/** Type guard cho {@link RoleStatus}. */
export function isRoleStatus(value: unknown): value is RoleStatus {
  return typeof value === 'string' && (ROLE_STATUSES as readonly string[]).includes(value);
}

/**
 * Nhóm trường mà một role entry **cấm** mang trên wire: nội dung nhúng và cờ
 * bypass. Role chỉ được truyền tập permission qua **permission id** — nhúng
 * object permission hay cờ `is_admin`/bypass là tái hiện đúng thứ mà §4.4 +
 * SR-016 cấm (mọi role là tập hữu hạn qua catalog, mọi đường qua enforcement
 * như nhau).
 */
export const FORBIDDEN_ROLE_FIELDS = [
  'is_admin',
  'admin',
  'bypass',
  'wildcard',
  'permission_objects',
  'embedded_permissions',
  'inherits',
  'parent_role',
  'children',
] as const;

/** Một role trên wire — shape assignment-safe: chỉ định danh, không nội dung nhúng. */
export interface StaffRole {
  readonly id: string;
  readonly name: string;
  /** `system` = seed bằng migration; `custom` = tạo qua API — **v1 tắt** (ADR-0004). */
  readonly kind: RoleKind;
  /**
   * Permission id (`<domain>.<action>`) mà role chứa — **tham chiếu catalog**,
   * không phải object permission. Mỗi id phải tồn tại trong permission catalog
   * (invariant 10); contract không kiểm chéo catalog, đó là việc của service.
   */
  readonly permissions: readonly string[];
  readonly status: RoleStatus;
  readonly created_at: string;
}

/** Lý do từ chối một payload role. */
export type RoleContractRejectionReason =
  | 'invalid_payload'
  | 'invalid_entry'
  | 'forbidden_field'
  | 'invalid_kind'
  | 'invalid_status'
  | 'oversized_page';

/** Kết quả validate một role entry. */
export type RoleEntryValidation = RoleContractValidation<StaffRole>;

/** Kết quả validate response list role. */
export type RoleListValidation = RoleContractValidation<RoleListResponse>;

/** Shape tổng quát của validation result trong lib này. */
export type RoleContractValidation<T> =
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly reason: RoleContractRejectionReason; readonly detail: string };

/** Response của get/list role. */
export interface RoleListResponse {
  readonly roles: readonly StaffRole[];
  /** `null` = hết dữ liệu. Không `total_count` — không dùng list để đếm. */
  readonly next_cursor: string | null;
}

/**
 * Kiểm tra một role entry có đúng hình contract không — cấm trường bypass/nội
 * dung nhúng trước, rồi kiểm shape từng trường.
 *
 * ⚠️ Không nối **giá trị** trường bị cấm vào `detail`; chỉ nêu tên trường.
 */
export function validateStaffRole(value: unknown): RoleEntryValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Role entry must be an object.' };
  }
  const record = value as Record<string, unknown>;

  for (const field of FORBIDDEN_ROLE_FIELDS) {
    if (field in record) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Role entry carries a forbidden field: ${field}.`,
      };
    }
  }

  const requiredKeys = ['id', 'name', 'kind', 'permissions', 'status', 'created_at'];
  const keys = Object.keys(record);
  for (const key of requiredKeys) {
    if (!keys.includes(key)) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `Role entry is missing required field: ${key}.`,
      };
    }
  }
  for (const key of keys) {
    if (!requiredKeys.includes(key)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Role entry carries a field outside the contract: ${key}.`,
      };
    }
  }

  if (typeof record.id !== 'string' || record.id.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'id must be a non-empty string.' };
  }
  if (typeof record.name !== 'string' || record.name.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'name must be a non-empty string.' };
  }
  if (!isRoleKind(record.kind)) {
    return { ok: false, reason: 'invalid_kind', detail: 'kind must be "system" or "custom".' };
  }
  if (
    !Array.isArray(record.permissions) ||
    record.permissions.some((p) => typeof p !== 'string' || p.length === 0)
  ) {
    return {
      ok: false,
      reason: 'invalid_entry',
      detail: 'permissions must be an array of non-empty permission id strings.',
    };
  }
  if (!isRoleStatus(record.status)) {
    return { ok: false, reason: 'invalid_status', detail: 'status must be "active" or "retired".' };
  }
  if (typeof record.created_at !== 'string' || record.created_at.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'created_at must be a non-empty string.' };
  }

  return {
    ok: true,
    payload: {
      id: record.id,
      name: record.name,
      kind: record.kind,
      permissions: record.permissions as readonly string[],
      status: record.status,
      created_at: record.created_at,
    },
  };
}

/**
 * Validate response list/get role.
 *
 * ⚠️ **Write path không có ở đây** — v1 chỉ system-defined role, được seed qua
 * migration có review (ADR-0004). Contract này cố ý KHÔNG định nghĩa request
 * tạo/sửa role: khi custom role administration bật (ADR-0004 kích hoạt lại),
 * contract write ra đời cùng ADR đó, không thêm vào đây lặng lẽ.
 */
export function validateRoleListResponse(payload: unknown): RoleListValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== 'roles' && key !== 'next_cursor') {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `Response contains a field outside the contract: ${key}.`,
      };
    }
  }

  if (!Array.isArray(record.roles)) {
    return { ok: false, reason: 'invalid_payload', detail: 'roles must be an array.' };
  }

  if (record.roles.length > ROLE_LIST_MAX_LIMIT) {
    return {
      ok: false,
      reason: 'oversized_page',
      detail: `roles page exceeds the ceiling of ${ROLE_LIST_MAX_LIMIT} entries.`,
    };
  }

  if (
    record.next_cursor !== null &&
    (typeof record.next_cursor !== 'string' || record.next_cursor.length === 0)
  ) {
    return {
      ok: false,
      reason: 'invalid_payload',
      detail: 'next_cursor must be null or a non-empty string.',
    };
  }

  const roles: StaffRole[] = [];
  for (const entry of record.roles) {
    const result = validateStaffRole(entry);
    if (!result.ok) {
      return result;
    }
    roles.push(result.payload);
  }

  return {
    ok: true,
    payload: { roles, next_cursor: record.next_cursor as string | null },
  };
}

/**
 * Dựng response list role hợp lệ — một chỗ dựng duy nhất.
 */
export function roleListResponse(
  roles: readonly StaffRole[],
  nextCursor: string | null,
): RoleListResponse {
  return { roles, next_cursor: nextCursor };
}
