/**
 * Taxonomy lỗi của tầng domain `backoffice`.
 *
 * Source of truth (pattern): `libs/account-domain/src/errors.ts` — một domain
 * error chỉ mang `code` ổn định + `message` tiếng Việt ngắn gọn, không field nào
 * cho identifier/token/secret hay payload tuỳ ý.
 *
 * Ràng buộc nguồn ở phía `backoffice`:
 * - invariant 7 (`docs/domains/staff-access/domain-model.md` §9): audit record
 *   KHÔNG chứa token/secret/PII.
 * - invariant 35 (`docs/architecture/01-architecture.md` §9): không bí mật đứng cạnh
 *   actor/target/action.
 *
 * Một error object đi thẳng ra log, ra response BFF và ra authorization audit —
 * nó là nơi dễ rò chính vì nó mang theo "ngữ cảnh" của lỗi. Cho phép mang `sub`
 * hay payload trong error message là biến log thành kênh thu thập identifier
 * không có kiểm soát.
 *
 * Vì vậy type {@link BackofficeDomainErrorCode} là union đóng và
 * {@link BackofficeDomainError} không có chỗ cho payload. Muốn thêm ngữ cảnh
 * cho việc chẩn đoán thì thêm mã mới vào taxonomy, không gắn dữ liệu vào mã cũ.
 */

/** Mã lỗi ổn định — contract với consumer, không đổi nghĩa theo thời gian. */
export type BackofficeDomainErrorCode =
  | 'invalid_account_id'
  | 'invalid_staff_status'
  | 'staff_terminated'
  | 'staff_suspended'
  | 'staff_not_found'
  | 'role_not_found'
  | 'permission_not_in_catalog'
  | 'invalid_assignment_window'
  | 'invalid_transition';

/**
 * Message tiếng Việt của từng mã, viết tắt trong bảng để factory đọc từ
 * một nguồn duy nhất — không có đường nào để call site tự ghép câu chữ.
 */
export const BACKOFFICE_DOMAIN_ERROR_MESSAGES: Record<BackofficeDomainErrorCode, string> = {
  invalid_account_id: 'Account ID không hợp lệ.',
  invalid_staff_status: 'Staff status không hợp lệ.',
  staff_terminated: 'Staff membership đã bị chấm dứt.',
  staff_suspended: 'Staff membership đang bị tạm dừng.',
  staff_not_found: 'Không tìm thấy staff entry.',
  role_not_found: 'Không tìm thấy role.',
  permission_not_in_catalog: 'Permission không có trong catalog.',
  invalid_assignment_window: 'Cửa sổ hiệu lực của assignment không hợp lệ.',
  invalid_transition: 'Chuyển trạng thái không hợp lệ.',
};

/** Error domain: `code` ổn định + `message` tiếng Việt ngắn gọn. */
export interface BackofficeDomainError {
  readonly code: BackofficeDomainErrorCode;
  readonly message: string;
}

/**
 * Dựng domain error. Constructor duy nhất của taxonomy: chỉ ghép `code` với
 * message lấy từ {@link BACKOFFICE_DOMAIN_ERROR_MESSAGES}, không có chỗ nào
 * lọt dữ liệu call site.
 * @throws TypeError nếu `code` không có trong taxonomy.
 */
export function backofficeDomainError(code: BackofficeDomainErrorCode): BackofficeDomainError {
  // `Object.hasOwn` thay vì chỉ số mảng thẳng: `BACKOFFICE_DOMAIN_ERROR_MESSAGES['toString']`
  // lookup tiện chỗ kế thừa từ `Object.prototype` (một function thay vì `undefined`)
  // — factory khi đó sẽ discard `code` unchanged thay vì ném. Guard ở dưới
  // (`isBackofficeDomainError`) đã dùng `Object.hasOwn`; factory phải ăn khớp các
  // hướng đó để cùng một `code` lạ bị từ chối từ cả hai phía.
  const message = Object.hasOwn(BACKOFFICE_DOMAIN_ERROR_MESSAGES, code)
    ? BACKOFFICE_DOMAIN_ERROR_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    throw new TypeError(`Backoffice domain error code không hợp lệ: ${String(code)}`);
  }
  return { code, message };
}

/**
 * Type guard: có phải object mang `code` thuộc taxonomy không.
 *
 * Dùng `Object.hasOwn`, không dùng `in`: `in` đi cả prototype chain, nên
 * `'toString' in BACKOFFICE_DOMAIN_ERROR_MESSAGES` là `true` (kế thừa từ
 * `Object.prototype`) và guard sẽ nhận `{ code: 'toString' }` là domain error
 * hợp lệ — trong khi
 * `backofficeDomainError('toString' as BackofficeDomainErrorCode)` lại ném
 * `TypeError`. Hai hướng ngược nhau trên cùng taxonomy là cửa lách kiểm đầu vào.
 */
export function isBackofficeDomainError(value: unknown): value is BackofficeDomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(BACKOFFICE_DOMAIN_ERROR_MESSAGES, code);
}
