/**
 * Management contracts cho **staff directory** — API quản trị mà service
 * Staff Access (P1.4) publish cho BFF `backoffice` tiêu thụ (roadmap P1.2,
 * issue #426).
 *
 * Source of truth (docs/domains/staff-access/):
 * - `01-architecture.md` §3, §4.1: staff member liên kết đúng **một** Account
 *   ID (`sub`) — mapping 1:1, không tái phát hành/không tái sử dụng; `sub` là
 *   **reference** xuyên service, không FK; **email không phải khoá danh tính
 *   chính**.
 * - `01-architecture.md` §4.2 + [ADR-0002](../../domains/staff-access/adr/0002-revocation-latency-risk-class.md)
 *   §3: `staff status` là trục khác hẳn account status; hai trục không suy ra
 *   nhau.
 * - [ADR-0012](../../domains/staff-access/adr/0012-credential-contract-and-staff-subject-mapping.md)
 *   §4: ánh xạ `sub` → staff diễn ra server-side; `sub` của access token là
 *   Account ID dạng `sub_` + 32 ký tự base32.
 *
 * ⚠️ **Đây là contract (shape wire), không phải API HTTP.** Endpoint URL, method
 * và cơ chế mang credential thuộc implement P1.4; contract này ghim **trường
 * nào đi qua dây** và **ràng buộc hình thức** của chúng.
 *
 * ⚠️ **Không chứa dữ liệu hồ sơ danh tính.** Email, profile, credential, MFA là
 * dữ liệu của `account` — contract staff của Staff Access **không** nhận, không
 * trả. `FORBIDDEN_STAFF_PROFILE_FIELDS` là hàng phòng thủ thứ hai sau shape
 * TypeScript: validator chặn payload đã qua `JSON.parse` mà không còn ai giữ
 * type. Hiển thị tên staff dùng contract `GET /internal/account/profiles` của
 * `account` (`docs/applications/backoffice/01-architecture.md`) — không nhân bản qua
 * contract này.
 */

/**
 * Trần số bản ghi tối đa một trang list — mọi endpoint list của Staff Access
 * dùng trần này. Không có listing không giới hạn.
 */
export const STAFF_LIST_MAX_LIMIT = 100;

/** Giá trị `limit` mặc định khi caller không truyền. */
export const STAFF_LIST_DEFAULT_LIMIT = 50;

/**
 * Tập nhãn `staff status` **theo đề xuất** của `01-architecture.md` §4.2.
 *
 * ⚠️ **Tập nhãn CHƯA CHỐT** — điều đã chốt là sự tách trục với account status
 * và `terminated` là trạng thái cuối (`01` §4.2); từng nhãn cụ thể là đề xuất
 * và chờ quyết định ghi nhận (ADR tương ứng của Phase 1 Staff Access). Nếu ADR
 * sau đổi tập nhãn, union này đổi theo ADR đó — không tự nới lỏng ở caller.
 *
 * `terminated` là trạng thái terminal: khôi phục membership là **thao tác mới
 * có audit**, không phải chuyển về `active` im lặng (`01` §4.2).
 */
export type StaffStatus = 'active' | 'suspended' | 'terminated';

/** Danh sách nhãn status hợp lệ — nguồn cho type guard và test. */
export const STAFF_STATUSES = ['active', 'suspended', 'terminated'] as const;

/** Type guard cho {@link StaffStatus}. */
export function isStaffStatus(value: unknown): value is StaffStatus {
  return typeof value === 'string' && (STAFF_STATUSES as readonly string[]).includes(value);
}

/**
 * Nhóm trường hồ sơ danh tính mà contract staff **cấm** mang — bất kỳ payload
 * staff nào (request hay response) chứa một trong các trường này đều là rò dữ
 * liệu vượt ranh giới ownership (`01` §3: dữ liệu danh tính thuộc `account`).
 *
 * Đây là hàng phòng thủ thứ hai sau shape TypeScript — validator chạy trên
 * payload thật qua dây.
 */
export const FORBIDDEN_STAFF_PROFILE_FIELDS = [
  'email',
  'avatar_url',
  'profile',
  'locale',
  'timezone',
  'credential',
  'mfa',
  'passkey',
  'session',
] as const;

/** Một bản ghi staff trên wire. */
export interface StaffMember {
  /**
   * Định danh staff do Staff Access sở hữu — tham chiếu nội bộ của directory,
   * KHÔNG phải `sub` của account và KHÔNG phải email. Consumer giữ id này cho
   * mọi thao tác quản trị; ánh xạ id ↔ `sub` là việc của service Staff Access
   * (ADR-0012 §4, mapping server-side).
   */
  readonly id: string;
  /**
   * Account ID (`sub`) của staff member — **reference** opaque tới `account`,
   * dạng `sub_` + 32 ký tự base32 (ADR-0012 §4, CHECK `staff_sub_account_id_format_check`
   * của migration 0004). Không email, không profile data — hiển thị hồ sơ đi
   * qua contract riêng của `account`.
   */
  readonly sub: string;
  /** Trạng thái membership — tập nhãn theo đề xuất §4.2, chưa chốt (xem {@link StaffStatus}). */
  readonly status: StaffStatus;
  /**
   * Tên hiển thị nghiệp vụ do Staff Access giữ cho sổ staff (do người có quyền
   * đặt khi tạo/update) — **không** phải dữ liệu đồng bộ từ `account` và không
   * thay thế displayName của hồ sơ account (vốn đi qua contract profiles).
   */
  readonly display_name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Response của get/list staff — một trang có cursor. */
export interface StaffListResponse {
  readonly staff: readonly StaffMember[];
  /**
   * Cursor để lấy trang tiếp theo — `null` tức hết dữ liệu. Contract KHÔNG
   * trả tổng số bản ghi (`total_count`): consumer không được dùng contract
   * list để đếm sổ staff.
   */
  readonly next_cursor: string | null;
}

/** Lý do từ chối một payload staff (request hay response). */
export type StaffContractRejectionReason =
  | 'invalid_payload'
  | 'invalid_entry'
  | 'forbidden_field'
  | 'invalid_status'
  | 'invalid_sub'
  | 'oversized_page'
  | 'invalid_pagination';

/** Kết quả validate — discriminated union, cùng hình với account-contracts. */
export type StaffContractValidation<T> =
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly reason: StaffContractRejectionReason; readonly detail: string };

/** Kết quả validate response list/get. */
export type StaffListValidation = StaffContractValidation<StaffListResponse>;

/**
 * Kiểm tra `sub` có đúng hình Account ID hay không — prefix `sub_` + đúng 32
 * ký tự base32 viết thường.
 *
 * Ghim cùng hình với producer thật (`isBackofficeAccountId` của
 * `libs/backoffice-domain`, 32 ký tự) mà không import implementation chéo
 * scope — constraint module-boundary cấm scope này import `scope:backoffice`
 * implementation; contract tự khai ràng buộc hình thức của chính nó.
 */
export function isStaffSubFormat(value: unknown): value is string {
  return typeof value === 'string' && /^sub_[a-z2-7]{32}$/u.test(value);
}

/**
 * Kiểm tra một bản ghi staff có đúng hình contract không — cấm trường hồ sơ
 * trước, rồi kiểm shape từng trường.
 *
 * ⚠️ Không nối **giá trị** trường bị cấm vào `detail`; chỉ nêu tên trường.
 */
export function validateStaffMember(value: unknown): StaffContractValidation<StaffMember> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Staff entry must be an object.' };
  }
  const record = value as Record<string, unknown>;

  for (const field of FORBIDDEN_STAFF_PROFILE_FIELDS) {
    if (field in record) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Staff entry carries a forbidden identity field: ${field}.`,
      };
    }
  }

  const requiredKeys = ['id', 'sub', 'status', 'display_name', 'created_at', 'updated_at'];
  const keys = Object.keys(record);
  for (const key of requiredKeys) {
    // `undefined` cũng là thiếu: object literal trong caller có thể mang key
    // mà không có giá trị, và contract phải báo "missing" chứ không nhảy
    // xuống kiểm tra hình thật của field đó.
    if (!keys.includes(key) || record[key] === undefined) {
      return {
        ok: false,
        reason: 'invalid_entry',
        detail: `Staff entry is missing required field: ${key}.`,
      };
    }
  }
  for (const key of keys) {
    if (!requiredKeys.includes(key)) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Staff entry carries a field outside the contract: ${key}.`,
      };
    }
  }

  if (typeof record.id !== 'string' || record.id.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'id must be a non-empty string.' };
  }
  if (!isStaffSubFormat(record.sub)) {
    return {
      ok: false,
      reason: 'invalid_sub',
      detail: 'sub must be an Account ID: sub_ prefix + 32 lowercase base32 characters.',
    };
  }
  if (!isStaffStatus(record.status)) {
    return {
      ok: false,
      reason: 'invalid_status',
      detail: 'status is not a valid staff status label.',
    };
  }
  if (
    typeof record.display_name !== 'string' ||
    record.display_name.length === 0 ||
    record.display_name.length > STAFF_DISPLAY_NAME_MAX_LENGTH
  ) {
    return {
      ok: false,
      reason: 'invalid_entry',
      detail: `display_name must be 1..${STAFF_DISPLAY_NAME_MAX_LENGTH} characters.`,
    };
  }
  if (typeof record.created_at !== 'string' || record.created_at.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'created_at must be a non-empty string.' };
  }
  if (typeof record.updated_at !== 'string' || record.updated_at.length === 0) {
    return { ok: false, reason: 'invalid_entry', detail: 'updated_at must be a non-empty string.' };
  }

  return {
    ok: true,
    payload: {
      id: record.id,
      sub: record.sub,
      status: record.status,
      display_name: record.display_name,
      created_at: record.created_at,
      updated_at: record.updated_at,
    },
  };
}

/** Trần độ dài `display_name` của sổ staff — mirror app-level cap 200. */
export const STAFF_DISPLAY_NAME_MAX_LENGTH = 200;

/**
 * Validate response list/get staff.
 *
 * Chặn trần trang trước từng entry: một response vượt trần là server phá
 * contract, consumer không tin cả trang.
 */
export function validateStaffListResponse(payload: unknown): StaffListValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response must be an object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== 'staff' && key !== 'next_cursor') {
      return {
        ok: false,
        reason: 'invalid_payload',
        detail: `Response contains a field outside the contract: ${key}.`,
      };
    }
  }

  if (!Array.isArray(record.staff)) {
    return { ok: false, reason: 'invalid_payload', detail: 'staff must be an array.' };
  }

  if (record.staff.length > STAFF_LIST_MAX_LIMIT) {
    return {
      ok: false,
      reason: 'oversized_page',
      detail: `staff page exceeds the ceiling of ${STAFF_LIST_MAX_LIMIT} entries.`,
    };
  }

  if (
    record.next_cursor !== null &&
    (typeof record.next_cursor !== 'string' || record.next_cursor.length === 0)
  ) {
    return {
      ok: false,
      reason: 'invalid_pagination',
      detail: 'next_cursor must be null or a non-empty string.',
    };
  }

  const staff: StaffMember[] = [];
  for (const entry of record.staff) {
    const result = validateStaffMember(entry);
    if (!result.ok) {
      return result;
    }
    staff.push(result.payload);
  }

  return {
    ok: true,
    payload: { staff, next_cursor: record.next_cursor as string | null },
  };
}

/**
 * Kiểm tra tham số phân trang của một request list — `limit` trong [1, MAX],
 * `cursor` chuỗi rỗng hoặc vắng là trang đầu.
 */
export function validateStaffListRequest(params: {
  readonly limit?: unknown;
  readonly cursor?: unknown;
}): StaffContractValidation<{ readonly limit: number; readonly cursor: string | null }> {
  const { limit, cursor } = params;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > STAFF_LIST_MAX_LIMIT)
  ) {
    return {
      ok: false,
      reason: 'invalid_pagination',
      detail: `limit must be an integer in [1, ${STAFF_LIST_MAX_LIMIT}].`,
    };
  }
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    return {
      ok: false,
      reason: 'invalid_pagination',
      detail: 'cursor must be an empty string, null, or a non-empty cursor token.',
    };
  }
  return {
    ok: true,
    payload: {
      limit: limit === undefined ? STAFF_LIST_DEFAULT_LIMIT : limit,
      cursor: cursor === undefined || cursor === '' ? null : cursor,
    },
  };
}

/**
 * Dựng response list hợp lệ từ các bản ghi — một chỗ dựng duy nhất để không
 * có đường ghép response bằng tay lọt trường ngoài contract.
 */
export function staffListResponse(
  staff: readonly StaffMember[],
  nextCursor: string | null,
): StaffListResponse {
  return { staff, next_cursor: nextCursor };
}
