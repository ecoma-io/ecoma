/**
 * Principal của `remote-cache-app` — context slot middleware authn gắn sau khi
 * phiên + access token đã qua verify (ADR-0035, theo ADR-0031 §2).
 *
 * Cùng pattern `apps/pact-broker-app/server/principal.ts` (deliberate
 * duplication — module boundary cấm import chéo). Principal mang **actor sub**
 * — `sub` của Account, dùng làm actor của chữ ký HMAC khi BFF gọi control plane
 * `remote-cache-api` (ADR-0034: human principal control-plane authorization).
 * Token không forward ra ngoài: control plane xác thực bằng HMAC
 * `INTERNAL_AUTH_SECRET`, không bằng Bearer token.
 */

import { createError, type H3Event } from 'h3';

/** Khoá context — không dùng tên này nên không va chạm. */
export const PRINCIPAL_CONTEXT_KEY = 'remoteCacheAppPrincipal';

/** Principal đã verify của một request có phiên hợp lệ. */
export interface RemoteCacheAppPrincipal {
  /**
   * `sub` của Account — actor của chữ ký HMAC khi BFF gọi control plane
   * (ADR-0034). KHÔNG log giá trị token; sub là opaque identifier, không bí mật.
   */
  readonly actorSub: string;
}

/**
 * Đọc principal mà middleware authn gắn; thiếu ⇒ `401`.
 *
 * ⚠️ Middleware là đường duy nhất gắn principal, nên "principal vắng ở route"
 * có đúng một nghĩa: request không có phiên hợp lệ ⇒ 401 (không phải 503 —
 * "hệ thống hỏng" là các nhánh cấu hình/DB/JWKS, middleware đã phân loại trước).
 */
export function requirePrincipal(event: H3Event): RemoteCacheAppPrincipal {
  const principal = (event.context as Record<string, unknown>)[PRINCIPAL_CONTEXT_KEY];
  if (typeof principal !== 'object' || principal === null) {
    throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
  }
  return principal as RemoteCacheAppPrincipal;
}
