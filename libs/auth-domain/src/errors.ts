/**
 * Error taxonomy của protocol OAuth 2.0/OIDC.
 *
 * Mỗi lỗi ở đây mang MÃ (`code`) theo RFC 6749 §4.1.2.1 / §5.2 và `status`
 * HTTP — hai thứ khác nhau, và việc gộp chúng là nguồn lỗi thường gặp: một
 * lỗi protocol có thể đúng mã nhưng sai status, và bên nhận token sẽ hành xử
 * sai.
 *
 * ⚠️ Phân biệt bắt buộc giữa hai lớp lỗi, vì chúng dẫn tới hai hành vi khác
 * nhau hoàn toàn:
 *
 * 1. Lỗi **có thể chuyển hướng** (`REDIRECTABLE`): chỉ xảy ra khi `auth` đã
 *    xác thực được `client_id` và `redirect_uri` khớp exact với bản đăng ký.
 *    Khi đó `auth` redirect tới `redirect_uri` kèm `error`/`error_description`.
 * 2. Lỗi **phải trả trực tiếp** (`DIRECT`): xảy ra khi `redirect_uri` CHƯA
 *    được xác nhận là hợp lệ, hoặc khi request vốn không phải protocol
 *    (`/token`). Redirect tới một URI chưa xác minh chính là open redirect —
 *    đó là T-04 trong threat model.
 *
 * Vì vậy `OAuthProtocolError.redirectable` là thuộc tính bắt buộc, không
 * phải chi tiết trình bày: handler chỉ được redirect khi cờ này đúng.
 */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  | 'temporarily_unavailable';

/**
 * Lỗi protocol. `redirectable = false` nghĩa là handler PHẢI trả JSON trực
 * tiếp, tuyệt đối không redirect.
 */
export class OAuthProtocolError extends Error {
  readonly code: OAuthErrorCode;
  readonly httpStatus: number;
  readonly redirectable: boolean;
  /**
   * Mô tả để đưa vào audit/log. KHÔNG bao giờ chứa `code_verifier`, token,
   * client secret hay bất kỳ giá trị bí mật nào (SR-001) — và cũng không
   * chứa handle X/Y/Z, vì handle đi trong URL và sẽ lọt vào `Referer`.
   */
  readonly detail: string | undefined;

  constructor(
    code: OAuthErrorCode,
    httpStatus: number,
    options: { redirectable?: boolean; detail?: string; cause?: unknown } = {},
  ) {
    // `message` phải đọc được khi debug. Đặt mã vào message rồi chôn `detail`
    // ở property riêng nghĩa là stack trace chỉ có `invalid_request` — mọi lần
    // đọc log phải mở object lên mới biết lỗi là gì.
    super(options.detail === undefined ? code : `${code}: ${options.detail}`, {
      cause: options.cause,
    });
    this.name = 'OAuthProtocolError';
    this.code = code;
    this.httpStatus = httpStatus;
    // Mặc định KHÔNG redirect: mọi lỗi phải được chọn điển hìnha là redirect
    // là thả lỏng mặc định, và handler sẽ trở thành open redirect.
    this.redirectable = options.redirectable ?? false;
    this.detail = options.detail;
  }

  static invalidRequest(detail?: string): OAuthProtocolError {
    return new OAuthProtocolError('invalid_request', 400, {
      redirectable: true,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static directInvalidRequest(detail?: string): OAuthProtocolError {
    return new OAuthProtocolError('invalid_request', 400, {
      redirectable: false,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static invalidScope(detail?: string): OAuthProtocolError {
    return new OAuthProtocolError('invalid_scope', 400, {
      redirectable: true,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static directInvalidScope(detail?: string): OAuthProtocolError {
    return new OAuthProtocolError('invalid_scope', 400, {
      redirectable: false,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static invalidClient(detail?: string): OAuthProtocolError {
    return new OAuthProtocolError('invalid_client', 401, {
      redirectable: false,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static invalidGrant(detail?: string): OAuthProtocolError {
    return new OAuthProtocolError('invalid_grant', 400, {
      redirectable: true,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static directInvalidGrant(detail?: string): OAuthProtocolError {
    return new OAuthProtocolError('invalid_grant', 400, {
      redirectable: false,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static accessDenied(detail?: string): OAuthProtocolError {
    return new OAuthProtocolError('access_denied', 400, {
      redirectable: true,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  static serverError(cause?: unknown): OAuthProtocolError {
    return new OAuthProtocolError('server_error', 500, {
      redirectable: true,
      detail: 'internal error',
      cause,
    });
  }

  /**
   * `temporarily_unavailable` — dùng khi phụ thuộc ngoài (Account, database)
   * lỗi tạm thời. Tách khỏi `server_error` vì nó NÊN được client retry, còn
   * `server_error` thì không.
   */
  static temporarilyUnavailable(cause?: unknown): OAuthProtocolError {
    return new OAuthProtocolError('temporarily_unavailable', 503, {
      redirectable: true,
      detail: 'dependency unavailable',
      cause,
    });
  }
}

/**
 * Lỗi cấu hình/thiếu secret. KHÁC `server_error`: đây là lỗi fail-fast lúc
 * khởi động hoặc lúc dựng dependency, và nó phải làm Worker **không phát
 * hành token** thay vì hạ cấp. Không bao giờ phát hành token bằng khoá tạm
 * sinh lúc startup.
 */
export class AuthConfigurationError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'AuthConfigurationError';
  }
}
