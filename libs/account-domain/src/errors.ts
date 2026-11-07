/**
 * Taxonomy lỗi của tầng domain `identity`.
 *
 * ⚠️ **Quy tắc bất di bất dịch: một domain error chỉ được mang `code` ổn định + `message`
 * tiếng Việt ngắn gọn.** Không field nào cho cookie, token, session identifier, handle,
 * `code_verifier`, secret hay bất kỳ giá trị nào đọc lại được từ nó.
 *
 * Lý do — invariant 9 (`01-architecture.md` §9): không log password, session cookie,
 * `code_verifier`, token hay assertion. Một error object đi thẳng ra log, ra response
 * BFF và ra audit; nó là nơi dễ rò chính vì nó mang theo "ngữ cảnh" của lỗi. Nếu error
 * được phép mang `sub` hay `handle` thì log lỗi trở thành kênh thu thập identifier
 * mà không có kiểm soát nào.
 *
 * Vì vậy type {@link DomainErrorCode} là `string` thuần và {@link DomainError} không
 * có chỗ để đặt payload tuỳ ý. Muốn thêm ngữ cảnh cho việc chẩn đoán thì thêm mã mới
 * vào taxonomy, không gắn dữ liệu lạnh vào mã cũ.
 */

/** Mã lỗi ổn định — contract với consumer, không đổi nghĩa theo thời gian. */
export type DomainErrorCode =
  | 'invalid_subject'
  | 'session_expired'
  | 'session_revoked'
  | 'reauthentication_required'
  | 'acr_insufficient'
  | 'account_deleted'
  | 'account_suspended'
  | 'invalid_transition';

/** Error domain: `code` ổn định + `message` tiếng Việt ngắn gọn. */
export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
}

/** Những lỗi không nhạy cảm theo nghĩa đen — không chứa dữ liệu định danh hay bí mật. */
export const DOMAIN_ERROR_MESSAGES: Record<DomainErrorCode, string> = {
  invalid_subject: 'Subject không hợp lệ.',
  session_expired: 'Phiên đã hết hạn.',
  session_revoked: 'Phiên đã bị thu hồi.',
  reauthentication_required: 'Cần xác thực lại trước khi tiếp tục.',
  acr_insufficient: 'Mức assurance (ACR) chưa đủ cho thao tác này.',
  account_deleted: 'Tài khoản đã bị xoá.',
  account_suspended: 'Tài khoản đang bị tạm khoá.',
  invalid_transition: 'Chuyển trạng thái không hợp lệ.',
};

/**
 * Dựng domain error.
 *
 * Constructor duy nhất của taxonomy: nó chỉ ghép `code` với message lấy từ
 * {@link DOMAIN_ERROR_MESSAGES}, nên **không có đường nào** để lọt dữ liệu tuỳ ý vào
 * message. Muốn đổi câu chữ thì sửa bảng, không sửa call site.
 *
 * @throws TypeError nếu `code` không có trong taxonomy.
 */
export function domainError(code: DomainErrorCode): DomainError {
  const message = DOMAIN_ERROR_MESSAGES[code];
  if (message === undefined) {
    throw new TypeError(`Domain error code không hợp lệ: ${String(code)}`);
  }
  return { code, message };
}

/**
 * Type guard: có phải object mang `code` thuộc taxonomy không.
 *
 * ⚠️ Phải dùng `Object.hasOwn`, không dùng `in`: `in` đi cả prototype chain, nên
 * `'toString' in DOMAIN_ERROR_MESSAGES` là `true` (kế thừa từ `Object.prototype`)
 * và guard sẽ nhận `{ code: 'toString' }` là domain error hợp lệ — trong khi
 * `domainError('toString' as DomainErrorCode)` lại ném `TypeError`. Hai hướng
 * ngược nhau trên cùng một taxonomy là cửa để caller lách kiểm taxonomy ở đầu
 * vào.
 */
export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(DOMAIN_ERROR_MESSAGES, code);
}
