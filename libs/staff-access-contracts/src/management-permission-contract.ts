/**
 * Management contracts cho **permission catalog** — đọc danh mục permission và
 * shape governance (governance write happens server-side qua migration; shape
 * ở đây phục vụ read API + ghi nhận vòng đời).
 *
 * Source of truth (docs/domains/staff-access/):
 * - `01-architecture.md` §4.3: permission là định danh một hành động trên một
 *   resource domain; catalog thuộc sở hữu của Staff Access; thêm/đổi/bỏ một
 *   permission là **governance action có audit**; tài liệu không phát minh
 *   permission cụ thể nào.
 * - [ADR-0010](../../domains/staff-access/adr/0010-permission-naming-and-read-catalog.md):
 *   tên permission dạng `domain.action` (dot-style); `id` bằng đúng chuỗi
 *   `<domain>.<action>`, hai nửa lưu riêng ở hai cột; `UNIQUE (domain, action)`.
 * - ADR-0010: **retired là terminal** — một permission đã retire không quay lại
 *   `active` bằng UPDATE im lặng; đưa lại phải là seed migration mới được review.
 * - invariant 10 / SR-020: catalog là nguồn sự thật duy nhất của permission;
 *   resource-owning backend không tự phát minh permission ngoài catalog.
 *
 * ⚠️ Contract này **không chứa bất kỳ permission cụ thể nào** — seed catalog
 * (`staff.read`, `role.read`, `permission.read`) thuộc migration 0003 và các
 * seed sau; hợp đồng chỉ ghim hình dạng định danh.
 */

/** Trần số bản ghi tối đa một trang list permission. */
export const PERMISSION_LIST_MAX_LIMIT = 200;

/** Giá trị `limit` mặc định khi caller không truyền. */
export const PERMISSION_LIST_DEFAULT_LIMIT = 100;

/** Vòng đời permission — `retired` là terminal per ADR-0010 (insert-then-retire). */
export type PermissionStatus = 'active' | 'retired';

export const PERMISSION_STATUSES = ['active', 'retired'] as const;

/** Type guard cho {@link PermissionStatus}. */
export function isPermissionStatus(value: unknown): value is PermissionStatus {
  return typeof value === 'string' && (PERMISSION_STATUSES as readonly string[]).includes(value);
}

/**
 * Nhóm trường mà một permission entry **cấm** mang trên wire: permission là
 * một định danh trong catalog, không mang verdict, không mang role/assignment
 * nào sử dụng nó, và không mang wildcard (§4.4 cấm permission bao trùm).
 */
export const FORBIDDEN_PERMISSION_FIELDS = [
  'verdict',
  'decision',
  'allowed',
  'denied',
  'wildcard',
  'roles',
  'assignments',
  'risk_class',
] as const;

/** Một permission trên wire. */
export interface Permission {
  /**
   * Định danh đầy đủ, bằng đúng chuỗi `<domain>.<action>` (dot-style per
   * ADR-0010) — ví dụ hình dạng: `delivery.redrive`. Contract KHÔNG liệt kê
   * giá trị hợp lệ; nội dung catalog thuộc migration seed.
   */
  readonly id: string;
  /** Nửa domain của định danh — phải khớp nửa đầu của `id` trước dấu chấm. */
  readonly domain: string;
  /** Nửa action của định danh — phải khớp nửa sau của `id` trước dấu chấm. */
  readonly action: string;
  /** `retired` là terminal per ADR-0010. */
  readonly status: PermissionStatus;
  readonly created_at: string;
}

/** Lý do từ chối một payload permission. */
export type PermissionContractRejectionReason =
  | 'invalid_payload'
  | 'invalid_entry'
  | 'invalid_id_format'
  | 'id_parts_mismatch'
  | 'forbidden_field'
  | 'invalid_status'
  | 'oversized_page';

/** Kết quả validate một permission entry. */
export type PermissionEntryValidation = PermissionContractValidation<Permission>;

/** Kết quả validate response list permission. */
export type PermissionListValidation = PermissionContractValidation<PermissionListResponse>;

/** Shape tổng quát của validation result trong lib này. */
export type PermissionContractValidation<T> =
  | { readonly ok: true; readonly payload: T }
  | {
      readonly ok: false;
      readonly reason: PermissionContractRejectionReason;
      readonly detail: string;
    };

/** Response của list permission. */
export interface PermissionListResponse {
  readonly permissions: readonly Permission[];
  /** `null` = hết dữ liệu. Không `total_count`. */
  readonly next_cursor: string | null;
}

/**
 * Kiểm tra `id` permission có đúng hình `domain.action` không — có đúng một
 * dấu chấm, hai nửa đều không rỗng, và **không chứa wildcard** (`*`).
 *
 * ⚠️ Kiểm **hình dạng**, không kiểm nội dung: ADR-0010 cấm phát minh permission
 * từ tài liệu, và contract không giữ danh sách domain/action hợp lệ. Riêng
 * wildcard bị chặn vì ADR-0010 phương án 4 loại permission bao trùm tường
 * minh — một id mang `*` là đường bypass đúng thứ §4.4/SR-016 cấm.
 */
export function isPermissionIdFormat(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.includes('*')) return false;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return false;
  if (value.indexOf('.', dot + 1) !== -1) return false;
  return true;
}

/**
 * Kiểm tra một permission entry: id phải đúng hình `domain.action`, hai cột
 * `domain`/`action` phải khớp đúng hai nửa của `id` (ADR-0010: `id` bằng đúng
 * chuỗi ghép hai cột — lệch nửa là định danh mơ hồ, chặn ở validator thay vì
 * tin cả hai phía cùng đúng).
 */
export function validatePermission(value: unknown): PermissionEntryValidation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Permission entry must be an object.' };
  }
  const record = value as Record<string, unknown>;

  for (const field of FORBIDDEN_PERMISSION_FIELDS) {
    if (field in record) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Permission entry carries a forbidden field: ${field}.`,
      };
    }
  }

  const requiredKeys = ['id', 'domain', 'action', 'status', 'created_at'];
  const keys = Object.keys(record);
  for (const key of requiredKeys) {
    if (!keys.includes(key)) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `Permission entry is missing required field: ${key}.`,
      };
    }
  }
  for (const key of keys) {
    if (!requiredKeys.includes(key)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Permission entry carries a field outside the contract: ${key}.`,
      };
    }
  }

  if (!isPermissionIdFormat(record.id)) {
    return {
      ok: false,
      reason: 'invalid_id_format',
      detail: 'id must be exactly "<domain>.<action>" with a single dot and non-empty halves.',
    };
  }
  const dot = (record.id as string).indexOf('.');
  const idDomain = (record.id as string).slice(0, dot);
  const idAction = (record.id as string).slice(dot + 1);
  if (record.domain !== idDomain || record.action !== idAction) {
    return {
      ok: false,
      reason: 'id_parts_mismatch',
      detail: 'domain/action columns must equal the two halves of id (ADR-0010).',
    };
  }
  if (typeof record.domain !== 'string' || typeof record.action !== 'string') {
    return {
      ok: false,
      reason: 'invalid_entry',
      detail: 'domain and action must be strings.',
    };
  }
  if (!isPermissionStatus(record.status)) {
    return {
      ok: false,
      reason: 'invalid_status',
      detail: 'status must be "active" or "retired".',
    };
  }
  if (typeof record.created_at !== 'string' || record.created_at.length === 0) {
    return {
      ok: false,
      reason: 'invalid_entry',
      detail: 'created_at must be a non-empty string.',
    };
  }

  return {
    ok: true,
    payload: {
      id: record.id,
      domain: record.domain,
      action: record.action,
      status: record.status,
      created_at: record.created_at,
    },
  };
}

/**
 * Validate response list permission.
 *
 * ⚠️ **Write path của catalog không có ở đây.** Ghi catalog là governance
 * action có audit, diễn ra qua seed migration được review (ADR-0010, invariant
 * 10); runtime không có API insert/update permission trong giai đoạn này. Khi
 * governance API thật sự cần, nó ra đời cùng ADR/contract riêng — không thêm
 * vào đây lặng lẽ.
 */
export function validatePermissionListResponse(payload: unknown): PermissionListValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== 'permissions' && key !== 'next_cursor') {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `Response contains a field outside the contract: ${key}.`,
      };
    }
  }

  if (!Array.isArray(record.permissions)) {
    return { ok: false, reason: 'invalid_payload', detail: 'permissions must be an array.' };
  }

  if (record.permissions.length > PERMISSION_LIST_MAX_LIMIT) {
    return {
      ok: false,
      reason: 'oversized_page',
      detail: `permissions page exceeds the ceiling of ${PERMISSION_LIST_MAX_LIMIT} entries.`,
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

  const permissions: Permission[] = [];
  for (const entry of record.permissions) {
    const result = validatePermission(entry);
    if (!result.ok) {
      return result;
    }
    permissions.push(result.payload);
  }

  return {
    ok: true,
    payload: { permissions, next_cursor: record.next_cursor as string | null },
  };
}

/**
 * Dựng một permission entry hợp lệ từ hai nửa — hàm này **ghim** invariant
 * `id = domain + '.' + action` tại đúng một chỗ, nên không thể dựng entry với
 * hai nửa lệch khỏi id.
 */
export function permissionEntry(
  domain: string,
  action: string,
  status: PermissionStatus,
  createdAt: string,
): Permission {
  return { id: `${domain}.${action}`, domain, action, status, created_at: createdAt };
}

/**
 * Dựng response list permission hợp lệ — một chỗ dựng duy nhất.
 */
export function permissionListResponse(
  permissions: readonly Permission[],
  nextCursor: string | null,
): PermissionListResponse {
  return { permissions, next_cursor: nextCursor };
}
