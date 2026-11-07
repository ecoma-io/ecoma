import { OAuthProtocolError } from './errors';

/**
 * Loại client. `confidential` bắt buộc xác thực ở `/token` (SR-004);
 * `public` thì không — và đó là lý do `public` buộc phải có PKCE.
 */
export type ClientType = 'confidential' | 'public';

/** Mức rủi ro dùng để `auth` gợi ý giao diện consent — KHÔNG phải quyết định bảo mật. */
export type RiskLevel = 'low' | 'elevated' | 'high';

export function isActiveClient(client: { isActive: boolean }): boolean {
  return client.isActive;
}

/**
 * Client bị vô hiệu hoá KHÔNG được dùng, kể cả khi nó truyền đúng
 * `redirect_uri`. Đây là điều kiện kiểm ở `/authorize` TRƯỚC khi xét bất kỳ
 * thứ gì khác — client bị thu hồi không được đẩy người dùng vào consent.
 */
export function assertUsableClient(client: { isActive: boolean }): void {
  if (!client.isActive) {
    throw OAuthProtocolError.directInvalidRequest('client khong hoat dong');
  }
}

/**
 * Quyết định consent là BẮT BUỘC hay không.
 *
 * ⚠️ Consent và grant là HAI THỨ KHÁC NHAU (FR-005, §3.4). Một lần user đã
 * đồng ý KHÔNG có nghĩa là mọi lần sau đều không cần hỏi — grant có thể hết
 * hạn, scope có thể đổi, và sau khi account bị suspend rồi reactivate thì
 * grant KHÔNG hồi sinh (FR-022): user phải consent lại.
 *
 * Vì vậy hàm này nhận cả `existingGrant` lẫn `requestedScope`, và trả
 * `consent_required` khi grant KHÔNG bao phủ trọn vẹn scope được yêu cầu.
 */
export function needsConsent(params: {
  existingGrant: { scopes: readonly string[]; isActive: boolean } | undefined;
  requestedScope: readonly string[];
}): boolean {
  const { existingGrant, requestedScope } = params;
  if (!existingGrant || !existingGrant.isActive) {
    return true;
  }
  const granted = new Set(existingGrant.scopes);
  // Yêu cầu ÍT HƠN grant hiện có vẫn cần hỏi: user chỉ đồng ý những gì đã
  // thấy, và việc client hạ scope xuống không phải lý do để bỏ qua consent.
  return !requestedScope.every((scope) => granted.has(scope));
}

/**
 * Kiểm tra grant còn hiệu lực VÀ đủ scope — điều kiện 4 trong bốn điều kiện
 * phải thoả trước khi cấp code (FR-009q).
 *
 * ⚠️ Điều kiện này được kiểm HAI LẦN: một lần ở bước push (để quyết định
 * `consent_required` vs thẳng `ready_to_complete`) và lại ở `/authorize/complete`
 * ngay trước lúc cấp code. Lần thứ hai là chốt chặn cuối — grant có thể hỏng
 * giữa hai thời điểm, và hành vi đúng khi đó là `access_denied`.
 */
export function assertGrantCoversScope(
  grant: { isActive: boolean; scopes: readonly string[] } | undefined,
  requestedScope: readonly string[],
): void {
  if (!grant || !grant.isActive) {
    throw OAuthProtocolError.accessDenied('grant khong con hieu luc');
  }
  const granted = new Set(grant.scopes);
  const missing = requestedScope.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw OAuthProtocolError.accessDenied('grant khong du scope');
  }
}

/**
 * Mức rủi ro cho consent UI.
 *
 * Đây là thông tin TRÌNH BÀY, không phải control bảo mật: quyết định có cấp
 * token hay không đã do bốn điều kiện ở trên quyết định rồi. Không dùng hàm
 * này để chặn.
 */
export function assessRiskLevel(params: {
  isNewClient: boolean;
  isNewScope: boolean;
  isAuthenticationFresh: boolean;
}): RiskLevel {
  const points =
    (params.isNewClient ? 1 : 0) +
    (params.isNewScope ? 1 : 0) +
    (!params.isAuthenticationFresh ? 1 : 0);
  if (points >= 2) {
    return 'high';
  }
  return points === 1 ? 'elevated' : 'low';
}
