/**
 * Management contracts cho **staff-role assignment** — gán role cho một staff
 * member, revoke, và list.
 *
 * Source of truth (docs/domains/staff-access/):
 * - `01-architecture.md` §4.5: một staff có thể có nhiều role; assignment có
 *   thể kèm **scope** và **hạn theo thời gian**; job title không tạo quyền —
 *   chỉ assignment tạo quyền; mọi assignment là privileged operation có audit.
 * - `01-architecture.md` §7 + SR-005: cấm self-assignment, self-elevation, và
 *   **cấp quyền vượt quá quyền của chính mình**.
 * - `01-architecture.md` §4.6: lịch sử assignment được giữ để audit còn truy
 *   vấn được — thu hồi là thao tác UPDATE có chủ đích, không DELETE.
 *
 * ⚠️ **SR-005 KHÔNG diễn đạt được trong wire contract.** "Không gán vượt quyền
 * của granter" là **enforcement rule server-side** (SR-005): contract chỉ chặn
 * hình dạng sai của payload, việc kiểm quyền granter diễn ra tại service khi
 * ghi (write-time check, SR-008 chống TOCTOU). Contract này cố ý không có
 * hàm/hằng nào "check quyền granter ở client" — một đường kiểm giả ở phía
 * client là an toàn giả (bypass bằng gọi thẳng API, invariant 2).
 */

/** Trần số bản ghi tối đa một trang list assignment. */
export const ASSIGNMENT_LIST_MAX_LIMIT = 100;

/** Giá trị `limit` mặc định khi caller không truyền. */
export const ASSIGNMENT_LIST_DEFAULT_LIMIT = 50;

/**
 * Scope của một assignment — **điểm mở có cấu trúc**, không phải chuỗi tự do.
 *
 * `01-architecture.md` §4.5 định nghĩa khái niệm "phạm vi" nhưng hình dạng dữ
 * liệu cụ thể còn mỏng trong tài liệu (schema hiện tại chỉ giữ `scope_label`
 * tối thiểu v1, migration 0001 ghi rõ "shape may grow"). Contract vì vậy ghim
 * **chỉ** trường bất biến đầu tiên:
 *
 * - `label`: nhãn phạm vi do nghiệp vụ đặt (`'global'` = toàn hệ thống v1).
 *
 * Trường cấu trúc sâu hơn (resource list, đơn vị tổ chức...) chỉ thêm được
 * khi tài liệu/ADR định nghĩa hình dạng — hợp đồng không tiên đoán. Validator
 * chặn mọi key ngoài `label` để shape không trôi mở lặng lẽ.
 */
export interface AssignmentScope {
  /** Nhãn phạm vi; `'global'` là giá trị mặc định v1 (migration 0001). */
  readonly label: string;
}

/** Một assignment trên wire — response shape (đã có audit fields). */
export interface StaffRoleAssignment {
  readonly id: string;
  /** Staff member được gán — định danh của Staff Access directory (không phải `sub`). */
  readonly staff_id: string;
  /** Role được gán — id trong role catalog. */
  readonly role_id: string;
  /** Phạm vi gán — tùy chọn; vắng = toàn hệ thống. */
  readonly scope?: AssignmentScope;
  /** Bắt đầu hiệu lực — ISO 8601. Vắng = từ thời điểm tạo. */
  readonly effective_from?: string;
  /**
   * Hạn hiệu lực tự nhiên — ISO 8601. `null`/vắng = không đặt hạn. Hết hạn là
   * read-time filter (migration 0001); row giữ lại để audit (§4.6).
   */
  readonly effective_until?: string | null;
  /** Staff member thực hiện gán (granter) — audit field §4.6/SR-013. Có thể null khi seed/bootstrap. */
  readonly granted_by?: string | null;
  readonly created_at: string;
  /**
   * Thời điểm **thu hồi có chủ đích** — `null` = còn hiệu lực (theo các trục
   * thời gian khác). Thu hồi là UPDATE có audit, không DELETE (§4.6).
   */
  readonly revoked_at?: string | null;
}

/** Request tạo assignment — đúng những gì caller được gửi, không audit field. */
export interface CreateAssignmentRequest {
  readonly staff_id: string;
  readonly role_id: string;
  readonly scope?: AssignmentScope;
  readonly effective_from?: string;
  readonly effective_until?: string | null;
}

/** Request revoke assignment — thu hồi có chủ đích, có audit server-side. */
export interface RevokeAssignmentRequest {
  readonly id: string;
}

/** Lý do từ chối một payload assignment. */
export type AssignmentContractRejectionReason =
  | 'invalid_payload'
  | 'invalid_entry'
  | 'forbidden_field'
  | 'invalid_scope'
  | 'invalid_time_range'
  | 'oversized_page';

/** Shape tổng quát của validation result trong lib này. */
export type AssignmentContractValidation<T> =
  | { readonly ok: true; readonly payload: T }
  | {
      readonly ok: false;
      readonly reason: AssignmentContractRejectionReason;
      readonly detail: string;
    };

/** Kết quả validate request tạo assignment. */
export type CreateAssignmentValidation = AssignmentContractValidation<CreateAssignmentRequest>;

/** Kết quả validate request revoke assignment. */
export type RevokeAssignmentValidation = AssignmentContractValidation<RevokeAssignmentRequest>;

/** Kết quả validate response list assignment. */
export type AssignmentListValidation = AssignmentContractValidation<AssignmentListResponse>;

/** Response list assignment. */
export interface AssignmentListResponse {
  readonly assignments: readonly StaffRoleAssignment[];
  /** `null` = hết dữ liệu. Không `total_count`. */
  readonly next_cursor: string | null;
}

const ASSIGNMENT_ENTRY_KEYS = [
  'id',
  'staff_id',
  'role_id',
  'scope',
  'effective_from',
  'effective_until',
  'granted_by',
  'created_at',
  'revoked_at',
] as const;

const CREATE_REQUEST_KEYS = [
  'staff_id',
  'role_id',
  'scope',
  'effective_from',
  'effective_until',
] as const;

/** Kiểm tra timestamp ISO 8601 hình thức (chuỗi, parse được, có múi giờ rõ). */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  // Bắt buộc mốc thời gian tuyệt đối (Z hoặc offset) — timestamp wire không
  // mang múi giờ địa phương mơ hồ.
  return /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
}

/** Kiểm tra một `AssignmentScope` có đúng hình `{ label }` không. */
function isAssignmentScope(value: unknown): value is AssignmentScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 1 &&
    keys[0] === 'label' &&
    typeof record.label === 'string' &&
    record.label.length > 0
  );
}

/**
 * Kiểm tra hai mốc thời gian của assignment không vô nghĩa: `effective_until`
 * phải sau `effective_from` khi cả hai có mặt. Đây là ràng buộc **hình thức**
 * của payload (giống CHECK của migration 0001), không phải policy hiệu lực —
 * policy là việc của service lúc đọc.
 */
function isSaneTimeRange(effectiveFrom: unknown, effectiveUntil: unknown): boolean {
  if (effectiveFrom === undefined || effectiveUntil === undefined || effectiveUntil === null) {
    return true;
  }
  return Date.parse(effectiveFrom as string) < Date.parse(effectiveUntil as string);
}

function rejectForbidden(
  record: Record<string, unknown>,
  allowed: readonly string[],
): AssignmentContractValidation<never> | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Assignment payload carries a field outside the contract: ${key}.`,
      };
    }
  }
  return null;
}

/**
 * Validate request tạo assignment.
 *
 * ⚠️ KHÔNG kiểm quyền granter ở đây — SR-005 là enforcement server-side
 * (xem doc đầu file).
 */
export function validateCreateAssignmentRequest(payload: unknown): CreateAssignmentValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Request must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  const forbidden = rejectForbidden(record, CREATE_REQUEST_KEYS);
  if (forbidden) return forbidden;

  for (const key of ['staff_id', 'role_id']) {
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `${key} must be a non-empty string.`,
      };
    }
  }

  if (record.scope !== undefined && !isAssignmentScope(record.scope)) {
    return {
      ok: false,
      reason: 'invalid_scope',
      detail: 'scope must be { label: string } — deeper structure is not pinned by the contract.',
    };
  }

  for (const key of ['effective_from', 'effective_until']) {
    if (record[key] !== undefined && record[key] !== null && !isIsoTimestamp(record[key])) {
      return {
        ok: false,
        reason: 'invalid_time_range',
        detail: `${key} must be an ISO 8601 timestamp with an explicit offset or Z.`,
      };
    }
  }

  if (!isSaneTimeRange(record.effective_from, record.effective_until)) {
    return {
      ok: false,
      reason: 'invalid_time_range',
      detail: 'effective_until must be after effective_from.',
    };
  }

  return {
    ok: true,
    payload: {
      staff_id: record.staff_id as string,
      role_id: record.role_id as string,
      ...(record.scope !== undefined ? { scope: record.scope as AssignmentScope } : {}),
      ...(record.effective_from !== undefined
        ? { effective_from: record.effective_from as string }
        : {}),
      ...(record.effective_until !== undefined
        ? { effective_until: record.effective_until as string | null }
        : {}),
    },
  };
}

/**
 * Validate request revoke assignment — chỉ cần id. Việc ghi `revoked_at` và
 * audit thuộc service.
 */
export function validateRevokeAssignmentRequest(payload: unknown): RevokeAssignmentValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Request must be an object.' };
  }
  const record = payload as Record<string, unknown>;
  const forbidden = rejectForbidden(record, ['id']);
  if (forbidden) return forbidden;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'id must be a non-empty string.' };
  }
  return { ok: true, payload: { id: record.id } };
}

/** Kiểm tra một assignment entry (response shape) có đúng hình contract không. */
export function validateStaffRoleAssignment(
  value: unknown,
): AssignmentContractValidation<StaffRoleAssignment> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Assignment entry must be an object.' };
  }
  const record = value as Record<string, unknown>;

  const forbidden = rejectForbidden(record, ASSIGNMENT_ENTRY_KEYS);
  if (forbidden) return forbidden;

  for (const key of ['id', 'staff_id', 'role_id', 'created_at']) {
    if (!Object.keys(record).includes(key)) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `Assignment entry is missing required field: ${key}.`,
      };
    }
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `${key} must be a non-empty string.`,
      };
    }
  }

  if (record.scope !== undefined && !isAssignmentScope(record.scope)) {
    return {
      ok: false,
      reason: 'invalid_scope',
      detail: 'scope must be { label: string }.',
    };
  }

  for (const key of ['effective_from', 'effective_until', 'granted_by', 'revoked_at']) {
    if (record[key] === undefined || record[key] === null) continue;
    if (key === 'granted_by') {
      if (typeof record[key] !== 'string' || (record[key] as string).length === 0) {
        return {
          ok: false,
          reason: 'invalid_entry',
          detail: 'granted_by must be a non-empty string when present.',
        };
      }
      continue;
    }
    if (!isIsoTimestamp(record[key])) {
      return {
        ok: false,
        reason: 'invalid_time_range',
        detail: `${key} must be an ISO 8601 timestamp with an explicit offset or Z.`,
      };
    }
  }

  if (!isSaneTimeRange(record.effective_from, record.effective_until)) {
    return {
      ok: false,
      reason: 'invalid_time_range',
      detail: 'effective_until must be after effective_from.',
    };
  }

  return {
    ok: true,
    payload: {
      id: record.id as string,
      staff_id: record.staff_id as string,
      role_id: record.role_id as string,
      ...(record.scope !== undefined ? { scope: record.scope as AssignmentScope } : {}),
      ...(record.effective_from !== undefined
        ? { effective_from: record.effective_from as string }
        : {}),
      ...(record.effective_until !== undefined
        ? { effective_until: record.effective_until as string | null }
        : {}),
      ...(record.granted_by !== undefined
        ? { granted_by: record.granted_by as string | null }
        : {}),
      created_at: record.created_at as string,
      ...(record.revoked_at !== undefined
        ? { revoked_at: record.revoked_at as string | null }
        : {}),
    },
  };
}

/** Validate response list assignment. */
export function validateAssignmentListResponse(payload: unknown): AssignmentListValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  const forbidden = rejectForbidden(record, ['assignments', 'next_cursor']);
  if (forbidden) return forbidden;

  if (!Array.isArray(record.assignments)) {
    return { ok: false, reason: 'invalid_payload', detail: 'assignments must be an array.' };
  }

  if (record.assignments.length > ASSIGNMENT_LIST_MAX_LIMIT) {
    return {
      ok: false,
      reason: 'oversized_page',
      detail: `assignments page exceeds the ceiling of ${ASSIGNMENT_LIST_MAX_LIMIT} entries.`,
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

  const assignments: StaffRoleAssignment[] = [];
  for (const entry of record.assignments) {
    const result = validateStaffRoleAssignment(entry);
    if (!result.ok) {
      return result;
    }
    assignments.push(result.payload);
  }

  return {
    ok: true,
    payload: { assignments, next_cursor: record.next_cursor as string | null },
  };
}

/**
 * Dựng response list assignment hợp lệ — một chỗ dựng duy nhất.
 */
export function assignmentListResponse(
  assignments: readonly StaffRoleAssignment[],
  nextCursor: string | null,
): AssignmentListResponse {
  return { assignments, next_cursor: nextCursor };
}
