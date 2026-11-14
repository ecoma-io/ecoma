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
 *    `server/auth/verify.ts`): `invalid` ⇒ **401** (caller phải đăng nhập
 *    lại); `unavailable` ⇒ **503** (JWKS không fetch được).
 * 4. CSRF double-submit cho **mutation** (`POST`/`PUT`/`PATCH`/`DELETE` —
 *    ADR-0031 §3): cookie `__Host-pact-broker-csrf` và header `x-ecoma-csrf`
 *    thiếu một trong hai ⇒ **401** (không chứng minh được là cùng client đã
 *    xác thực); có mặt nhưng không khớp ⇒ **403** (nỗ lực giả mạo).
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

import { createError, defineEventHandler, getCookie, getHeader, type H3Event } from 'h3';

import {
  createPactBrokerAppPool,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  csrfMatches,
  hashSessionIdentifier,
  isSessionLive,
  loadSessionByHash,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_SECONDS,
  touchSession,
} from '../auth/session';
import { verifyAccessToken } from '../auth/verify';
import { pactBrokerAuthConfig } from '../auth/config';
import { poolBinding } from '../db';
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
        if (verification.outcome === 'verified') {
          if (CSRF_METHODS.has(event.method) && pathname !== '/api/auth/logout') {
            const csrfCookieValue = getCookie(event, CSRF_COOKIE_NAME);
            const csrfHeader = getHeader(event, CSRF_HEADER_NAME);
            if (csrfCookieValue === undefined || csrfHeader === undefined) {
              // Thiếu một trong hai mảnh double-submit ⇒ không chứng minh được
              // request xuất phát từ client đã xác thực ⇒ 401 (ADR-0031 §3).
              throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
            }
            if (!csrfMatches(csrfCookieValue, csrfHeader)) {
              // Có cả hai mảnh nhưng không khớp ⇒ nỗ lực giả mạo ⇒ 403.
              throw createError({ statusCode: 403, statusMessage: 'Forbidden' });
            }
          }

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
