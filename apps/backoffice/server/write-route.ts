/**
 * Khung chung của ba write route BFF (`POST /api/staff`,
 * `POST /api/staff/:id/assignments`, `POST /api/assignments/revoke`) — issue
 * #191, bề mặt operator của đường ghi staff-access (#44).
 *
 * ## Ranh giới authorization: BFF không quyết định quyền
 *
 * ADR-0023 Quyết định 2: verdict permission là việc của `staff-access`,
 * enforce server-side trên **từng request** qua `requireWritePermission` —
 * BFF **không** tạo nguồn quyết định thứ hai. Route này chỉ:
 *
 * 1. **Principal từ phiên đã verify** — `requirePrincipal`: middleware authn
 *    đã verify session + token trước mọi `/api/**`, và principal vắng ⇒ `401`
 *    (ADR-0011 §1 — caller chưa đăng nhập). Actor **không bao giờ** từ
 *    body/header do client kiểm soát (SR-001/T-10).
 * 2. **CSRF double-submit** — cookie `__Host-backoffice-csrf` phải echo trong
 *    header `x-ecoma-csrf` (cùng luật `logout.post.ts`). Khác logout, một
 *    write request sai CSRF là **từ chối** (403) — không có nhánh no-op.
 *
 * Actor đi vào envelope HMAC (`actorSub`), nơi `staff-access` phân giải staff
 * và enforce permission; thiếu quyền ở staff-access ⇒ 403 + hàng audit
 * `denied` đã commit — kết quả đó được forward **nguyên vẹn** tới UI (ADR-0011
 * §4: 403 là denial quyền, không phải lỗi hạ tầng).
 */

import { createError, getCookie, getHeader, setResponseHeader, type H3Event } from 'h3';

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@ecoma-io/backoffice-infrastructure';

import { writeLog } from './log';
import { requirePrincipal } from './principal';

/**
 * Kiểm phiên + CSRF của một write request và trả actor của phiên. Ném
 * `H3Error` với mã đúng khi từ chối — route ghi không có nhánh "cho qua".
 *
 * - Principal vắng ⇒ `401` (middleware authn là đường duy nhất gắn nó).
 * - CSRF cookie có mặt nhưng header không echo ⇒ `403`. Cookie CSRF vắng ⇒
 *   vẫn kiểm: không có cặp double-submit là không có bằng chứng request đến
 *   từ chính app — khác logout (nơi no-op an toàn), write phải fail closed.
 */
export function requireWriteActor(event: H3Event): { readonly actorSub: string } {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const principal = requirePrincipal(event);

  const csrfCookieValue = getCookie(event, CSRF_COOKIE_NAME);
  const csrfHeader = getHeader(event, CSRF_HEADER_NAME);
  if (csrfCookieValue === undefined || csrfCookieValue !== csrfHeader) {
    writeLog({
      event: 'backoffice_write.rejected',
      route: event.path ?? '',
      status: 403,
      reason: 'csrf_mismatch',
    });
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }

  return { actorSub: principal.actorSub };
}
