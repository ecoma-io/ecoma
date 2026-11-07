/**
 * Contract consent và connected applications — provider `auth`, consumer `account`
 * (`docs/applications/auth/01-architecture.md` §5.1.7).
 *
 * Trước đây nhóm type này là khai báo cục bộ của shim
 * `@ecoma-io/identity-auth-contracts` (`internal-contracts.ts`, đã xoá ở issue #324),
 * được canh bởi một allowlist test; nay chúng có bản canonical riêng tại đây.
 */

/**
 * Payload `POST /internal/consent/context`.
 *
 * ⚠️ KHÔNG có `sub`: `account` đã được xác minh ở `/authorize/complete` và
 * transaction đã gắn subject. Trả `sub` trong context là tiết lộ dữ liệu định
 * danh không cần thiết, và mở đường cho client dùng nhầm nó làm bằng chứng.
 */
export interface ConsentContextRequest {
  handle: string;
  account_session_ref: string;
}

export interface ConsentContextResponse {
  client_name: string;
  scope: string[];
  /** Thông tin TRÌNH BÀY cho consent UI — KHÔNG phải control bảo mật. */
  risk_level: 'low' | 'elevated' | 'high';
}

/** Quyết định consent. `deny` là kết quả hợp lệ, không phải lỗi. */
export type ConsentDecision = 'approve' | 'deny';

/**
 * Payload `POST /internal/consent/decide`.
 *
 * ⚠️ Ba trường. `account` KHÔNG được gửi `client_id`, `redirect_uri`, `scope`,
 * `state`, `nonce` hay `code_verifier` — kể cả ở bước này. Không có bước nào
 * trong đoạn này để caller đưa tham số authorization vào.
 */
export interface ConsentDecideRequest {
  handle: string;
  decision: ConsentDecision;
  account_session_ref: string;
}

export interface ConsentDecideResponse {
  outcome: 'approved' | 'denied';
  continue_url: string;
}

/**
 * Payload `POST /internal/connected-applications` — liệt kê grant hiện hành
 * của một subject (FR-009 Connected applications; hướng `account → auth`).
 *
 * ⚠️ **Không có token, không có handle nào ở đây**: caller là `account` sau khi
 * đã xác minh session của user (envelope HMAC mang theo subject). `sub` là
 * trường duy nhất quyết định phạm vi dữ liệu — trả grant của sub khác là lỗi
 * ownership, không phải lỗi shape.
 */
export interface ConnectedApplicationsRequest {
  sub: string;
}

/**
 * Một grant hiện hành trong response danh sách.
 *
 * ⚠️ **`id` là `oauth_grants.id` dạng công khai của contract này** — account
 * không tự sinh định danh, và revoke của account echo đúng id này về. Auth là
 * bên tra cứu id → grant; account không suy ra gì từ hình dạng của nó.
 */
export interface ConnectedApplicationGrant {
  id: string;
  client_id: string;
  client_name: string;
  granted_at: number;
  scopes: string[];
}

export interface ConnectedApplicationsResponse {
  applications: ConnectedApplicationGrant[];
}

/**
 * Payload `POST /internal/connected-applications/revoke` — thu hồi quyền của
 * một app cho subject (Connected applications của account, FR-017a/§6.4).
 *
 * ⚠️ `sub` bắt buộc bên cạnh `grant_id`: route của auth chỉ thu hồi grant
 * thuộc về subject này — một `grant_id` của người khác là `404`, không bao giờ
 * là một thu hồi thành công.
 */
export interface ConnectedApplicationRevokeRequest {
  sub: string;
  grant_id: string;
}

export interface ConnectedApplicationRevokeResponse {
  outcome: 'revoked';
}
