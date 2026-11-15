/**
 * Middleware authn của `pact-broker-app` — ADR-0031 §2/§3: verify phiên +
 * access token, gắn principal vào `event.context` **trước mọi server route**,
 * và enforce CSRF double-submit trên mutation.
 *
 * Cùng đường `apps/backoffice/server/middleware/authn.ts` (deliberate
 * duplication — module boundary cấm import chéo). Khác backoffice ở CSRF:
 * ADR-0031 §3 đặt phép kiểm vào **middleware** (mọi mutation của app này đi
 * qua broker proxy), backoffice đặt ở từng route.
 *
 * ## Ranh giới chặn — `/api/**` là resource-server surface
 *
 * Middleware chỉ verify trên route của server: mọi path dưới `/api/`. Trang
 * Vue, static asset, `/health`, `/ready` đi qua tự do — chúng không tiêu thụ
 * principal. `/ready` chỉ đọc cấu hình broker (baseUrl), không dữ liệu phiên.
 *
 * ## Đường đi của một request có phiên
 *
 * 1. Đọc cookie `__Host-pact-broker-session` — vắng ⇒ **401**.
 * 2. Load phiên từ `db-pact-broker-app` theo hash — hàng không sống (hết hạn
 *    idle, hết absolute, revoked) ⇒ **401**. Lỗi DB ⇒ **503**.
 * 3. Verify access token của phiên offline (ES256/`iss`/`aud`/`exp` —
 *    `server/auth/verify.ts`): `invalid` ⇒ gia hạn thử **một lần** từ refresh
 *    token đã lưu (#258 — `server/auth/refresh.ts`, single-flight theo phiên);
 *    `unavailable` ⇒ **503** — JWKS không fetch được.
 * 4. CSRF double-submit cho **mutation** (`POST`/`PUT`/`PATCH`/`DELETE` —
 *    ADR-0031 §3) chạy **mọi nhánh sẽ gắn principal** — cả nhánh token hợp lệ
 *    lẫn nhánh `renewed` (token hết hạn không phải lối đi vòng qua CSRF —
 *    security review #258): cookie `__Host-pact-broker-csrf` và header
 *    `x-ecoma-csrf` thiếu một trong hai ⇒ **401** (không chứng minh được là
 *    cùng client đã xác thực); có mặt nhưng không khớp ⇒ **403** (nỗ lực giả
 *    mạo).
 * 5. Trượt idle expiry (sliding), gắn principal `{ actorSub, accessToken }`.
 *
 * ## Fail-closed khi cấu hình thiếu
 *
 * Thiếu cấu hình OIDC ⇒ **503**: không verify được bất kỳ token nào — không
 * có nhánh nào coi "chưa cấu hình" là "cho phép".
 *
 * ## Ngoại lệ path trong `/api/**`
 *
 * `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout`,
 * `/api/auth/session` — luồng xác thực và probe hiển thị. Logout **tự** kiểm
 * CSRF theo luật riêng (idempotent 204; CSRF mismatch ⇒ 403).
 *
 * ⚠️ So khớp path phải **tách query string**: `event.path` của h3 1.15 gồm cả
 * query, và callback luôn mang `?code=…&state=…` (đối chiếu ở
 * `apps/backoffice/server/middleware/authn.ts`).
 *
 * ⚠️ Token **không bao giờ** vào log hay response (SR-007): mọi nhánh từ chối
 * chỉ trả mã status.
 */

import {
  createError,
  defineEventHandler,
  getCookie,
  getHeader,
  setResponseHeader,
  type H3Event,
} from 'h3';

import type { Pool } from 'pg';

import {
  clearSessionCookie,
  createPactBrokerAppPool,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfMatches,
  hashSessionIdentifier,
  isSessionLive,
  loadSessionByHash,
  revokeSessionByHash,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_SECONDS,
  touchSession,
} from '../auth/session';

import { verifyAccessToken } from '../auth/verify';
import { pactBrokerAuthConfig } from '../auth/config';
import { renewSessionTokensOnce } from '../auth/refresh';
import { poolBinding } from '../db';
import { writeLog } from '../log';
import { PRINCIPAL_CONTEXT_KEY, type PactBrokerAppPrincipal } from '../principal';

/**
 * Prefix của resource-server surface — thứ middleware authn chặn. Ngoài prefix
 * này (trang Vue, asset, `/health`, `/ready`) request đi qua tự do.
 */
const API_PREFIX = '/api/';

/**
 * Các path auth middleware authn **không** chặn — luồng xác thực + probe
 * hiển thị. Danh sách đóng và tường minh: route `/api/**` mới không nằm ở đây
 * là bị chặn — deny-by-default. So khớp **pathname** (đã tách query).
 */
const AUTH_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/logout',
  '/api/auth/session',
]);

/** Method cần CSRF double-submit — mọi method đổi state. */
const CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Kiểm CSRF double-submit cho **mutation** (ADR-0031 §3): cookie
 * `__Host-pact-broker-csrf` và header `x-ecoma-csrf` thiếu một trong hai ⇒
 * **401** (không chứng minh được là cùng client đã xác thực); có mặt nhưng
 * không khớp ⇒ **403** (nỗ lực giả mạo).
 *
 * Chạy cho **mọi** request sắp gắn principal — kể cả nhánh `renewed` (token
 * mới): việc token hết hạn không được biến thành một lối đi vòng qua CSRF
 * (security review #258).
 */
function enforceCsrf(event: H3Event): void {
  if (!CSRF_METHODS.has(event.method)) {
    return;
  }
  const csrfCookieValue = getCookie(event, CSRF_COOKIE_NAME);
  const csrfHeader = getHeader(event, CSRF_HEADER_NAME);
  if (csrfCookieValue === undefined || csrfHeader === undefined) {
    throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
  }
  if (!csrfMatches(csrfCookieValue, csrfHeader)) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
  }
}

/**
 * Huỷ phiên server-side và xoá cookie — exception-safe (security review #258):
 * revoke DB hỏng (driver lỗi) không được bọc thành 503 để cookie còn nguyên
 * trên client. Luôn thử xoá cookie và ghi `reuse_detected_revoke_failed` khi
 * revoke không thành — request vẫn kết thúc 401 ở caller.
 */
async function revokeSessionAndClearCookie(
  pool: Pool,
  idHash: string,
  event: H3Event,
  pathname: string,
  sub: string,
): Promise<void> {
  try {
    await revokeSessionByHash(pool, idHash);
  } catch {
    writeLog({
      event: 'pact_broker_session.reuse_detected_revoke_failed',
      route: pathname,
      status: 401,
      sub,
    });
  }
  setResponseHeader(event, 'Set-Cookie', clearSessionCookie());
}

export default defineEventHandler(async (event: H3Event): Promise<void> => {
  // Tách query trước khi so: `event.path` gồm cả query string, allowlist là
  // pathname. Phân rã dot-segment của `URL` chỉ làm path RỜI ranh giới —
  // router của Nitro không chuẩn hoá nên không route nào khớp.
  const { pathname } = new URL(event.path, 'http://pact-broker-app.invalid');
  if (!pathname.startsWith(API_PREFIX) || AUTH_PATHS.has(pathname)) {
    return;
  }

  // Cấu hình thiếu ⇒ 503 fail-closed (không có nhánh "cho qua").
  const config = pactBrokerAuthConfig(event);
  if (config === null) {
    throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
  }

  // 1. Cookie vắng ⇒ 401 — chưa đăng nhập.
  const cookieValue = getCookie(event, SESSION_COOKIE_NAME);
  if (cookieValue === undefined || cookieValue.length === 0) {
    throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
  }

  // 2. Nguồn DB — không có ⇒ không đọc được phiên ⇒ 503.
  const binding = poolBinding(event);
  if (binding === null) {
    throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
  }

  // 3–5. Load phiên, verify token, CSRF cho mutation, trượt idle, gắn principal.
  let principal: PactBrokerAppPrincipal | null = null;
  try {
    const pool = createPactBrokerAppPool(binding.connectionString);
    try {
      const idHash = await hashSessionIdentifier(cookieValue);
      const row = await loadSessionByHash(pool, idHash);
      const now = Date.now();
      if (row !== null && isSessionLive(row, now)) {
        const verification = await verifyAccessToken(row.access_token, config);
        if (verification.outcome === 'unavailable') {
          throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
        }
        if (verification.outcome === 'invalid') {
          if (row.refresh_token !== null) {
            const renewed = await renewSessionTokensOnce(pool, idHash, config, row.refresh_token);
            if (renewed.outcome === 'renewed') {
              // `sub` của access token mới — phải khớp hàng phiên (refresh của
              // auth giữ nguyên subject); dùng sub đã verify là fail-closed.
              if (renewed.sub === row.account_sub) {
                // CSRF kiểm TRƯỚC khi gắn principal — nhánh renewed không được
                // bỏ qua double-submit (security review #258). Throw ở đây đi
                // 401/403 ra ngoài, token đã persist nhưng không dùng.
                enforceCsrf(event);
                try {
                  await touchSession(pool, idHash, now + SESSION_IDLE_SECONDS * 1000);
                } catch {
                  // Token mới đã persist; trượt idle hỏng không được biến một lần
                  // gia hạn thành công thành 503 — request kế đi nhánh verify
                  // thành công và tự trượt idle. Ghi lại để phiên hết hạn sớm
                  // hơn dự kiến không mất dấu vết.
                  writeLog({
                    event: 'pact_broker_session.idle_touch_failed',
                    route: pathname,
                    status: 200,
                    sub: row.account_sub,
                  });
                }
                writeLog({
                  event: 'pact_broker_session.renewed',
                  route: pathname,
                  status: 200,
                  sub: row.account_sub,
                });
                principal = { actorSub: renewed.sub, accessToken: renewed.accessToken };
              } else {
                // Sub lệch hàng phiên: token MỚI đã persist ở refresh — fail
                // closed bằng cách huỷ phiên (cùng đường exception-safe của
                // invalid_grant), không chỉ log (security review #258).
                await revokeSessionAndClearCookie(pool, idHash, event, pathname, row.account_sub);
                writeLog({
                  event: 'pact_broker_session.renewal_sub_mismatch',
                  route: pathname,
                  status: 401,
                  sub: row.account_sub,
                });
              }
            } else if (renewed.outcome === 'unavailable') {
              // Không gia hạn được LÚC NÀY (mạng/timeout/JWKS) ⇒ 503 — khác
              // "token sai": không âm thầm coi là phiên hợp lệ cũng không ép
              // đăng nhập lại vì một cú lỗi hạ tầng.
              throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
            } else if (renewed.outcome === 'invalid_grant') {
              // Reuse detected / grant family chết ⇒ huỷ phiên server-side và
              // ép đăng nhập lại; không retry. Cookie được xoá kèm 401 — revoke
              // hỏng vẫn xoá cookie (exception-safe, security review #258).
              await revokeSessionAndClearCookie(pool, idHash, event, pathname, row.account_sub);
              writeLog({
                event: 'pact_broker_session.reuse_detected',
                route: pathname,
                status: 401,
                sub: row.account_sub,
              });
            } else {
              // `failed` — refresh token revoked/contract hỏng/DB lỗi ⇒ 401 như
              // phiên chết; một lý do chung, không loop (cùng quyết định #244).
              writeLog({
                event: 'pact_broker_session.renewal_failed',
                route: pathname,
                status: 401,
                sub: row.account_sub,
              });
            }
          }
        } else {
          // Token hợp lệ: CSRF cho mutation trước khi trượt idle/gắn principal.
          enforceCsrf(event);
          await touchSession(pool, idHash, now + SESSION_IDLE_SECONDS * 1000);
          principal = { actorSub: row.account_sub, accessToken: row.access_token };
        }
      }
    } finally {
      void pool.end().catch(() => undefined);
    }
  } catch (error) {
    // `H3Error` từ các nhánh 401/403/503 trong thân giữ nguyên; lỗi driver (pg)
    // bọc thành 503 — không nối message driver (connection string có thể nằm
    // trong message).
    if (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
  }

  if (principal === null) {
    // Phiên vắng / chết / token invalid ⇒ 401 — một lý do chung.
    throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
  }
  event.context[PRINCIPAL_CONTEXT_KEY] = principal;
});
