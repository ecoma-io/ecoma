/**
 * Hợp đồng nội bộ `POST /authorization/verdict` — `staff-access` trả verdict
 * permission **theo từng request** cho một caller khác bounded context.
 *
 * Source of truth:
 * - [ADR-0033](../../../docs/domains/staff-access/adr/0033-permission-verdict-contract.md)
 *   Quyết định 3: hình dạng request/response, `actor_staff_id` do chính
 *   `staff-access` phân giải, `correlation_id` do caller sinh cho audit.
 * - ADR-0009 (supersede-in-part bởi ADR-0033 ở đúng hợp đồng này): envelope
 *   HMAC canonical là lớp xác thực duy nhất; không có đường nào khác.
 * - ADR-0023 Quyết định 6: hàng audit `denied`/`success` commit **trước** khi
 *   trả lời, `action`/`target` NOT NULL, truy được bằng `correlation_id`.
 *
 * ⚠️ Vì sao hình dạng sống ở `apps/staff-access/src/` chứ không ở
 * `@ecoma-io/staff-access-contracts`: consumer hiện tại (`apps/account`) chưa
 * khai lib contracts của provider trong `package.json`, và thêm nó đòi sửa
 * `pnpm-lock.yaml` — ngoài scope lock của #227. Đây là gap đã biết, không phải
 * đích đến: khi `account` được phép phụ thuộc lib đó, module này chuyển vào
 * `libs/staff-access-contracts` và bản mirror phía `account` bị xoá.
 *
 * ⚠️ Verdict **không** phải một trường của permission entry: catalog vẫn là
 * định danh thuần (`FORBIDDEN_PERMISSION_FIELDS` của
 * `management-permission-contract`). Đây là endpoint riêng, đúng lý do
 * ADR-0009 tách "kết quả authorization" khỏi "danh mục permission".
 */

import { isPermissionIdFormat } from '@ecoma-io/staff-access-contracts';

/** Path của endpoint — caller dựng URL và ký trên chính path này. */
export const AUTHORIZATION_VERDICT_PATH = '/authorization/verdict';

/**
 * Trần độ dài `correlation_id`. Không phải giới hạn của database (cột `text`):
 * đây là chặn payload rác trên một đường nội bộ, và giữ hàng audit dễ đọc.
 */
export const VERDICT_CORRELATION_ID_MAX_LENGTH = 128;

/** Hai verdict của phép kiểm — danh sách đóng, không có `unknown`/`error` lẫn vào. */
export type PermissionVerdict = 'allowed' | 'denied';

/** Body của request. */
export interface PermissionVerdictRequest {
  /** Định danh permission đầy đủ `<domain>.<action>` (ADR-0010). */
  readonly permission: string;
  /** Correlation ID xuyên service do caller sinh — đi vào hàng audit. */
  readonly correlation_id: string;
}

/** Response 200. */
export interface PermissionVerdictResponse {
  readonly verdict: PermissionVerdict;
  /**
   * Staff identity do `staff-access` phân giải từ `sub` trong envelope — caller
   * không bao giờ tự khai giá trị này.
   */
  readonly actor_staff_id: string;
}

/** Kết quả validate body request. */
export type PermissionVerdictRequestValidation =
  | { readonly ok: true; readonly request: PermissionVerdictRequest }
  | { readonly ok: false; readonly detail: string };

/**
 * Validate body request: đúng hai khoá, không thừa; `permission` đúng hình
 * `domain.action` (dùng chung validator của contracts để luật đặt tên chỉ có
 * một nguồn); `correlation_id` là chuỗi khác rỗng, không vượt trần.
 *
 * `detail` chỉ nêu **luật** bị vi phạm, không nêu giá trị caller gửi — body
 * nội bộ vẫn là dữ liệu bên ngoài với route này.
 */
export function validatePermissionVerdictRequest(
  payload: unknown,
): PermissionVerdictRequestValidation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, detail: 'Request body must be a JSON object.' };
  }
  const record = payload as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key !== 'permission' && key !== 'correlation_id') {
      return {
        ok: false,
        detail: `Request body carries a field outside the contract: ${key}.`,
      };
    }
  }

  if (!isPermissionIdFormat(record.permission)) {
    return {
      ok: false,
      detail: 'permission must be exactly "<domain>.<action>" with a single dot and no wildcard.',
    };
  }

  if (
    typeof record.correlation_id !== 'string' ||
    record.correlation_id.length === 0 ||
    record.correlation_id.length > VERDICT_CORRELATION_ID_MAX_LENGTH
  ) {
    return {
      ok: false,
      detail: `correlation_id must be a non-empty string of at most ${VERDICT_CORRELATION_ID_MAX_LENGTH} characters.`,
    };
  }

  return {
    ok: true,
    request: { permission: record.permission, correlation_id: record.correlation_id },
  };
}

/** Dựng response — một chỗ dựng duy nhất, để hình dạng wire không ghép tay ở route. */
export function permissionVerdictResponse(
  verdict: PermissionVerdict,
  actorStaffId: string,
): PermissionVerdictResponse {
  return { verdict, actor_staff_id: actorStaffId };
}
