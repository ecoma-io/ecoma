/**
 * Principal của `pact-broker-app` — context slot middleware authn gắn sau khi
 * phiên + access token đã qua verify (ADR-0031 §2).
 *
 * Cùng pattern `apps/backoffice/server/principal.ts`. Khác backoffice: principal
 * mang theo **access token của phiên** — BFF forward token này tới API trên
 * mỗi lần gọi broker (ADR-0031 §4: API là resource server, BFF không đổi token
 * thành token máy). Token nằm ở context của request, không bao giờ vào
 * response/log (SR-007).
 */

import { createError, type H3Event } from 'h3';

/** Khoá context — `_platform` không dùng tên này nên không va chạm. */
export const PRINCIPAL_CONTEXT_KEY = 'pactBrokerAppPrincipal';

/** Principal đã verify của một request có phiên hợp lệ. */
export interface PactBrokerAppPrincipal {
  /** `sub` của Account — đầu vào phân quyền phía API (membership). */
  readonly actorSub: string;
  /**
   * Access token hiện hành của phiên — forward thẳng tới `pact-broker-api`
   * dưới header `Authorization: Bearer`. KHÔNG log, KHÔNG trả response.
   */
  readonly accessToken: string;
}

/**
 * Đọc principal mà middleware authn gắn; thiếu ⇒ `401`.
 *
 * ⚠️ Middleware là đường duy nhất gắn principal, nên "principal vắng ở route"
 * có đúng một nghĩa: request không có phiên hợp lệ ⇒ 401 (không phải 503 —
 * "hệ thống hỏng" là các nhánh cấu hình/DB/JWKS, middleware đã phân loại trước).
 */
export function requirePrincipal(event: H3Event): PactBrokerAppPrincipal {
  const principal = (event.context as Record<string, unknown>)[PRINCIPAL_CONTEXT_KEY];
  if (typeof principal !== 'object' || principal === null) {
    throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
  }
  return principal as PactBrokerAppPrincipal;
}
