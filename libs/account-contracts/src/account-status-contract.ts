/**
 * Contract `GET /internal/account/status?sub=` — provider `account`, consumer `auth`
 * (`docs/applications/account/01-architecture.md` §5).
 *
 * ⚠️ **Đây là contract nhạy cảm nhất của cả hệ thống** vì nó cho phép service hỏi trạng
 * thái của bất kỳ `sub` nào. Rủi ro không chỉ là đọc hồ sơ: nếu contract này trả về
 * *bằng chứng* (email, profile, token) thì nó biến thành đường xác thực giả, và nếu nó
 * phân biệt được "tồn tại" với "không tồn tại" theo cách lộ ra ngoài thì nó trở thành
 * đường dò danh sách người dùng.
 *
 * Vì vậy response chỉ có **một** trường `status`, và `not_found` là một trong bốn giá
 * trị hợp lệ thay vì một lỗi riêng — hai thứ đó khác nhau về mặt hành vi (thêm status
 * trong body = thêm oracle đo danh tính).
 */

/** Bốn giá trị trạng thái mà contract được phép trả. */
export type AccountStatusResponseValue = 'active' | 'suspended' | 'deleted' | 'not_found';

/** Danh sách giá trị hợp lệ. */
export const ACCOUNT_STATUS_RESPONSE_VALUES = [
  'active',
  'suspended',
  'deleted',
  'not_found',
] as const;

/**
 * Thân response — **đúng một trường**.
 *
 * FR-011b: không email, không tên, không profile, không bất kỳ trường định danh nào.
 */
export interface AccountStatusResponse {
  readonly status: AccountStatusResponseValue;
}

/**
 * Nhóm trường định danh mà validator phải chặn nếu lọt vào response.
 *
 * Đây là hàng phòng thủ thứ hai sau `AccountStatusResponse` chỉ có một field: type
 * TypeScript chỉ bắt được lỗi ở call site có type, còn validator bắt được payload đã đi
 * qua `JSON.parse` mà không còn ai giữ type.
 */
export const FORBIDDEN_ACCOUNT_STATUS_FIELDS = [
  'email',
  'display_name',
  'name',
  'avatar_url',
  'profile',
  'locale',
  'timezone',
  'created_at',
  'authn_level',
  'account_session_ref',
  'session',
  'roles',
  'permissions',
] as const;

/** Lý do từ chối response. */
export type AccountStatusRejectionReason = 'invalid_payload' | 'forbidden_field' | 'unknown_status';

/** Kết quả validate — discriminated union. */
export type AccountStatusValidation =
  | { readonly ok: true; readonly payload: AccountStatusResponse }
  | { readonly ok: false; readonly reason: AccountStatusRejectionReason; readonly detail: string };

/** Kiểm tra giá trị có thuộc tập trạng thái hợp lệ không. */
export function isAccountStatusResponseValue(value: unknown): value is AccountStatusResponseValue {
  return (
    typeof value === 'string' &&
    (ACCOUNT_STATUS_RESPONSE_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Validate response của `GET /internal/account/status`.
 *
 * Chặn trường định danh trước rồi mới kiểm trạng thái, để một response mang cả trạng
 * thái lẫn hồ sơ luôn bị báo là `forbidden_field` — đúng loại lỗi mà audit và sửa code
 * đang nhìn.
 *
 * ⚠️ Không nối **giá trị** trường bị cấm vào `detail`; chỉ nêu tên trường.
 */
export function validateAccountStatusResponse(payload: unknown): AccountStatusValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid_payload', detail: 'Response phải là object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const field of FORBIDDEN_ACCOUNT_STATUS_FIELDS) {
    if (field in record) {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Response chứa trường định danh bị cấm: ${field}.`,
      };
    }
  }

  // Chỉ còn đúng một field hợp lệ là `status`; field lạ bất kỳ đều là rủi ro rò dữ liệu,
  // nên bị chặn thay vì bị bỏ qua âm thầm.
  for (const key of Object.keys(record)) {
    if (key !== 'status') {
      return {
        ok: false,
        reason: 'forbidden_field',
        detail: `Response chứa trường ngoài contract: ${key}.`,
      };
    }
  }

  if (!isAccountStatusResponseValue(record.status)) {
    return {
      ok: false,
      reason: 'unknown_status',
      detail: `status không thuộc tập hợp: ${String(record.status)}`,
    };
  }

  return { ok: true, payload: { status: record.status } };
}

/**
 * Dựng response hợp lệ từ trạng thái trong DB.
 *
 * Hàm này tồn tại để **buộc** mọi response đi qua một chỗ, nên không có cách nào dựng
 * response bằng tay mang theo hồ sơ. `not_found` là trạng thái hợp lệ, không phải lỗi.
 */
export function accountStatusResponse(status: AccountStatusResponseValue): AccountStatusResponse {
  return { status };
}
