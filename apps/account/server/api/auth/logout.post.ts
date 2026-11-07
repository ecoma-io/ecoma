/**
 * `POST /api/auth/logout` — thu hồi session hiện tại và xoá cookie.
 *
 * ## CSRF bắt buộc
 *
 * Đây là state-changing op có session — đúng mục tiêu của CSRF. Bảo vệ double-
 * submit: cookie `__Host-account-csrf` (do verify phát hành) phải echo lại trong
 * header `x-ecoma-csrf`. Thiếu/không khớp → `403` trước khi chạm DB. Attacker
 * cross-site không đọc được cookie (`SameSite=Lax` + không có đường JS cross-site)
 * nên không dựng được header khớp.
 *
 * ## Logout luôn 204, kể cả khi không có session
 *
 * Idempotent: logout khi chưa đăng nhập vẫn 204 — không lộ "người này có session
 * hay không", và UX không cần phân biệt. Thu hồi DB chỉ chạy khi có cookie và
 * cookie khớp một session sống.
 */

import { createError, defineEventHandler, getCookie, getHeader, setResponseHeader } from 'h3';

import { accountHyperdrive } from '../../utils/bindings';
import { writeLog } from '../../utils/logger';
import { withRequestPool } from '../../utils/db';
import {
  clearCsrfCookie,
  clearSessionCookie,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfMatches,
  hashSessionIdentifier,
  loadSessionByHash,
  revokeSessionByRef,
  SESSION_COOKIE_NAME,
} from '../../lib/session';

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const cookieValue = getCookie(event, SESSION_COOKIE_NAME);
  const csrfCookieValue = getCookie(event, CSRF_COOKIE_NAME);
  const csrfHeader = getHeader(event, CSRF_HEADER_NAME);

  // Không có session cookie → không có gì để thu hồi; 204 idempotent. CSRF khi đó
  // là vô nghĩa (không có state để đổi) nên không chặn — route này không cấp quyền.
  if (cookieValue === undefined) {
    setResponseHeader(event, 'Set-Cookie', [clearSessionCookie(), clearCsrfCookie()]);
    event.node.res.statusCode = 204;
    return null;
  }

  // Có session cookie nhưng CSRF cookie bị thiếu: không còn double-submit token để
  // kiểm, nhưng session vẫn còn tồn tại và có thể nhận diện an toàn qua session
  // cookie — revoke server-side session để không bỏ sót logout. CSRF mismatch
  // chỉ áp khi CSRF cookie có mặt (double-submit đầy đủ).
  if (csrfCookieValue !== undefined && !csrfMatches(csrfCookieValue, csrfHeader)) {
    writeLog({ event: 'logout.rejected', status: 403, reason: 'csrf_mismatch' });
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }

  const config = useRuntimeConfig(event);
  const hyperdrive = accountHyperdrive(config);
  if (!hyperdrive) {
    writeLog({ event: 'logout.failed', status: 503, reason: 'binding_missing' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  try {
    await withRequestPool(hyperdrive, async (pool) => {
      const idHash = await hashSessionIdentifier(cookieValue);
      const session = await loadSessionByHash(pool, idHash);
      if (session === null) {
        // Cookie không khớp session nào: không có gì để thu hồi, vẫn 204.
        return;
      }
      await revokeSessionByRef(pool, session.session_ref);
      writeLog({ event: 'logout.done', status: 204, sub: session.user_sub ?? undefined });
    });
  } catch {
    writeLog({ event: 'logout.failed', status: 503, reason: 'db_unreachable' });
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable' });
  }

  // Cookie luôn được xoá ở mọi nhánh 204 — kể cả khi DB không có hàng khớp.
  setResponseHeader(event, 'Set-Cookie', [clearSessionCookie(), clearCsrfCookie()]);
  event.node.res.statusCode = 204;
  return null;
});
