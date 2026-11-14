/**
 * `POST /api/auth/logout` — logout cục bộ (ADR-0031 §3): hủy phiên
 * server-side + gọi `POST {issuer}/revocation` cho access + refresh token
 * (RFC 7009) + xoá cookie.
 *
 * Cùng đường `apps/backoffice/server/api/auth/logout.post.ts` (deliberate
 * duplication — module boundary cấm import chéo).
 *
 * ## CSRF bắt buộc
 *
 * State-changing op có session — double-submit: cookie `__Host-pact-broker-csrf`
 * phải echo trong header `x-ecoma-csrf`. Thiếu/không khớp ⇒ `403` trước khi
 * chạm DB.
 *
 * ## Logout luôn 204, kể cả khi không có phiên
 *
 * Idempotent: logout khi chưa đăng nhập vẫn 204 — không lộ "người này có phiên
 * hay không". Thu hồi chỉ chạy khi có cookie và cookie khớp một phiên sống.
 *
 * ## Revocation là best-effort, phiên là nguồn sự thật
 *
 * Gọi `/revocation` của `auth` trước khi hủy phiên; lỗi network từ `auth`
 * **không** chặn logout: phiên đã hủy là session cookie chết ngay, token còn
 * sót tự hết hạn theo TTL của nó. Log `revocation_failed` để điều tra — quan
 * sát, không phải serving-path dependency.
 *
 * ⚠️ Token không vào log (SR-007) — revocation gửi token trong **body** của
 * POST (RFC 7009 §2.1), không trong URL (invariant 27).
 */

import { createError, defineEventHandler, getCookie, getHeader, setResponseHeader } from 'h3';

import {
  clearCsrfCookie,
  clearSessionCookie,
  createPactBrokerAppPool,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfMatches,
  hashSessionIdentifier,
  loadSessionByHash,
  revokeSessionByHash,
  SESSION_COOKIE_NAME,
} from '../../auth/session';
import { pactBrokerAuthConfig } from '../../auth/config';
import { poolBinding } from '../../db';
import { writeLog } from '../../log';

/**
 * Gọi `POST {issuer}/revocation` — RFC 7009, public client `client_id` trong
 * body. Best-effort: `true` khi `auth` nhận (2xx), `false` cho mọi nhánh khác.
 */
async function revokeAtAuth(issuer: string, clientId: string, token: string): Promise<boolean> {
  try {
    const body = new URLSearchParams({ token, client_id: clientId });
    const response = await fetch(new URL('/revocation', issuer).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    // Trả literal, không `return response.ok`: giá trị trả về của hàm này là
    // BOOLEAN metadata HTTP, không mang bit nào của token.
    if (response.ok) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const cookieValue = getCookie(event, SESSION_COOKIE_NAME);
  const csrfCookieValue = getCookie(event, CSRF_COOKIE_NAME);
  const csrfHeader = getHeader(event, CSRF_HEADER_NAME);

  // Không có session cookie → không có gì để thu hồi; 204 idempotent. CSRF
  // khi đó vô nghĩa (không có state để đổi) nên không chặn.
  if (cookieValue === undefined) {
    setResponseHeader(event, 'Set-Cookie', [clearSessionCookie(), clearCsrfCookie()]);
    event.node.res.statusCode = 204;
    return null;
  }

  // CSRF mismatch chỉ áp khi CSRF cookie có mặt (double-submit đầy đủ); CSRF
  // cookie thiếu mà session còn ⇒ vẫn revoke server-side (không bỏ sót logout)
  // — cùng quyết định với `logout.post.ts` của `backoffice`/`account`.
  if (csrfCookieValue !== undefined && !csrfMatches(csrfCookieValue, csrfHeader)) {
    writeLog({
      event: 'pact_broker_logout.rejected',
      route: '/api/auth/logout',
      status: 403,
      reason: 'csrf_mismatch',
    });
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }

  const config = pactBrokerAuthConfig(event);
  const binding = poolBinding(event);
  if (config === null || binding === null) {
    // Không revoke được phía `auth` cũng không hủy được phiên phía mình ⇒
    // 503 — logout "nửa vời" (chỉ xoá cookie) là bỏ phiên sống lại đằng sau.
    writeLog({
      event: 'pact_broker_logout.failed',
      route: '/api/auth/logout',
      status: 503,
      reason: 'config_or_db_missing',
    });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    const pool = createPactBrokerAppPool(binding.connectionString);
    try {
      const idHash = await hashSessionIdentifier(cookieValue);
      const session = await loadSessionByHash(pool, idHash);
      if (session !== null && session.revoked_at === null) {
        // Revocation best-effort trước, hủy phiên là bước có thẩm quyền.
        const revokedAccess = await revokeAtAuth(
          config.internalOrigin ?? config.issuer,
          config.clientId,
          session.access_token,
        );
        if (session.refresh_token !== null) {
          await revokeAtAuth(
            config.internalOrigin ?? config.issuer,
            config.clientId,
            session.refresh_token,
          );
        }
        if (!revokedAccess) {
          writeLog({
            event: 'pact_broker_logout.revocation_failed',
            route: '/api/auth/logout',
            status: 204,
            reason: 'auth_unreachable',
          });
        }
        await revokeSessionByHash(pool, idHash);
        writeLog({
          event: 'pact_broker_logout.done',
          route: '/api/auth/logout',
          status: 204,
          sub: session.account_sub,
        });
      }
    } finally {
      void pool.end().catch(() => undefined);
    }
  } catch {
    writeLog({
      event: 'pact_broker_logout.failed',
      route: '/api/auth/logout',
      status: 503,
      reason: 'db_unreachable',
    });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  // Cookie luôn được xoá ở mọi nhánh 204 — kể cả khi DB không có hàng khớp.
  setResponseHeader(event, 'Set-Cookie', [clearSessionCookie(), clearCsrfCookie()]);
  event.node.res.statusCode = 204;
  return null;
});
