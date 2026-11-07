/**
 * Middleware authn của `backoffice` — ADR-0012 §1.5: verify phiên + access
 * token, gắn principal vào `event.context` **trước mọi server route**.
 *
 * ## Ranh giới chặn — `/api/**` là resource-server surface
 *
 * Middleware chỉ verify trên **route của server**: mọi path dưới `/api/`.
 * Trang Vue, static asset, `/health`, `/ready` đi qua tự do — chúng không
 * tiêu thụ principal và không trả dữ liệu backend nào (dữ liệu UI đến từ
 * adapter, gated riêng bởi `NITRO_PUBLIC_BACKOFFICE_DATA_MODE`).
 * Đánh đổi được ghi tường minh: khi UI bắt đọc dữ liệu thật qua server route
 * (J3), chính ranh giới này ép mỗi lần đọc mang phiên — một route quên gọi
 * `requirePrincipal` vẫn được middleware che. Bề mặt không phải `/api/**`
 * **không** được thêm vào ranh giới này để "bảo vệ thêm": một trang muốn
 * server-gate là một quyết định review riêng, không phải tác dụng phụ.
 *
 * ## Đường đi của một request có phiên
 *
 * 1. Đọc cookie `__Host-backoffice-session` — vắng ⇒ **401** (ADR-0011 §1:
 *    caller chưa đăng nhập). Không có nhánh nào coi "vắng" là "cho qua".
 * 2. Load phiên từ `db-backoffice` theo hash — hàng không sống (hết hạn idle,
 *    hết absolute, revoked) ⇒ **401**. Lỗi DB ⇒ **503** (không verify được
 *    lúc này).
 * 3. Verify access token của phiên offline (ES256/`iss`/`aud`/`exp` —
 *    `server/auth/verify.ts`):
 *    - `invalid` ⇒ **401** — token của phiên không còn hợp lệ ⇒ phiên này
 *      không đáng tin nữa; caller phải đăng nhập lại.
 *    - `unavailable` ⇒ **503** — JWKS không fetch được.
 * 4. Trượt idle expiry (sliding), gắn principal vào context — route chạy như
 *    bình thường.
 *
 * ## Vì sao middleware thay vì check trong từng route
 *
 * Cùng lý do `server/middleware/internal-auth.ts` của `account`: mặc định
 * **closed**. Route mới thêm vào app tự động được bảo vệ; một route quên gọi
 * hàm check là mặc định open. Mọi route `/api/**` đều đi qua đây — trừ danh
 * sách auth-path dưới đây.
 *
 * ## Vì sao principal vắng ở route là `401` chứ không phải `503`
 *
 * Khi middleware này chạy, "thiếu principal ở context" có đúng một nghĩa:
 * request không có phiên hợp lệ — middleware là đường duy nhất gắn principal.
 * Trước PR J2, nghĩa đó mơ hồ ("hệ thống chưa dựng đường xác thực") nên
 * ADR-0010 tạm dùng `503`; flip về `401` trong PR wire authn là đúng quy tắc
 * chuyển tiếp ADR-0011 §3 — flip nằm ở `requirePrincipal`
 * (`server/principal.ts`) cùng PR này.
 *
 * ## Fail-closed khi cấu hình thiếu
 *
 * Thiếu cấu hình OIDC (`backofficeAuthConfig` trả `null`) ⇒ **503**: không có
 * cấu hình là không verify được bất kỳ token nào — đó là "không trả lời được",
 * không phải "caller sai" (cùng nguyên tắc `no_secret` của
 * `internal-auth.ts` — không có nhánh nào coi "chưa cấu hình" là "cho phép").
 *
 * ## Ngoại lệ path trong `/api/**`
 *
 * `/api/auth/login`, `/api/auth/callback`, `/api/auth/logout` — chính là
 * luồng xác thực; chặn chúng là chặn đăng nhập. Logout **tự** kiểm phiên
 * theo luật riêng (idempotent 204).
 *
 * ⚠️ So khớp path phải **tách query string**: `event.path` của h3 1.15
 * **gồm cả query** (đối chiếu ở `apps/account/server/middleware/internal-auth.ts`
 * — `GET /api/auth/callback?code=…&state=…` là dạng thường trực của callback,
 * so khớp nguyên chuỗi là so khớp không bao giờ trùng ⇒ luồng đăng nhập chết).
 *
 * ⚠️ Token **không bao giờ** vào log (SR-014): mọi nhánh từ chối ở đây chỉ
 * trả mã status, không ghi giá trị cookie/token/message driver vào response
 * hay log.
 */

import { createError, defineEventHandler, getCookie, type H3Event } from 'h3';
import type { Pool } from 'pg';

import {
  hashSessionIdentifier,
  isSessionLive,
  loadSessionByHash,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_SECONDS,
  touchSession,
  verifyAccessToken,
  withBackofficePool,
} from '@ecoma-io/backoffice-infrastructure';

import { backofficeAuthConfig } from '../auth/config';
import { poolBinding } from '../db';
import { PRINCIPAL_CONTEXT_KEY, type VerifiedPrincipal } from '../principal';

/**
 * Prefix của resource-server surface — thứ middleware authn chặn.
 *
 * Ngoài prefix này (trang Vue, asset, `/health`, `/ready`) request đi qua tự
 * do; xem JSDoc của file vì sao ranh giới là `/api/**` thay vì mọi path.
 */
const API_PREFIX = '/api/';

/**
 * Các path auth middleware authn **không** chặn — chính là luồng xác thực.
 *
 * ⚠️ So khớp **pathname** (đã tách query): `event.path` gồm query string,
 * và callback luôn mang `?code=…&state=…`. Danh sách đóng và tường minh: một
 * route `/api/**` mới sinh ra **không** nằm trong danh sách này là bị chặn —
 * an toàn theo hướng deny-by-default. Thêm path vào đây là một quyết định có
 * review, không phải tiện tay.
 */
const AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/callback', '/api/auth/logout']);

/**
 * Nguồn connection string PostgreSQL của request — dùng hàm chung `poolBinding`
 * của `server/db.ts` (Hyperdrive trước, runtime Node local sau). Trước đây
 * logic này nhân bản tại đây và ở callback với độ phủ đầy đủ, còn khung
 * `withReadEnforcement` lại thiếu nhánh Node — nhân bản lệch là read route
 * chết 503 trên local (bug thật, đã gom về một hàm).
 */

export default defineEventHandler(async (event: H3Event): Promise<void> => {
  // Tách query trước khi so: `event.path` gồm cả query string (h3 1.15), còn
  // allowlist là pathname. `new URL` với base nội bộ: `event.path` luôn bắt
  // đầu bằng `/` nên luôn parse được; host trong base không có ý nghĩa gì với
  // pathname. Phân rã dot-segment của `URL` (`/api/../x` → `/x`) chỉ làm path
  // RỜI ranh giới — router của Nitro không chuẩn hoá nên không có route nào
  // khớp; chiều ngược lại (path thường mà router khớp route `/api/**`) bất khả
  // vì router khớp literal.
  const { pathname } = new URL(event.path, 'http://backoffice.invalid');
  if (!pathname.startsWith(API_PREFIX) || AUTH_PATHS.has(pathname)) {
    return;
  }

  // Cấu hình thiếu ⇒ 503 fail-closed (không có nhánh "cho qua").
  const config = backofficeAuthConfig(event);
  if (config === null) {
    throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
  }

  // 1. Cookie vắng ⇒ 401 — chưa đăng nhập, ADR-0011 §1.
  const cookieValue = getCookie(event, SESSION_COOKIE_NAME);
  if (cookieValue === undefined || cookieValue.length === 0) {
    throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
  }

  // 2. Nguồn DB — không có ⇒ không đọc được phiên ⇒ 503.
  const binding = poolBinding(event);
  if (binding === null) {
    throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
  }

  // 3–4. Load phiên, verify token, trượt idle, gắn principal.
  let principal: VerifiedPrincipal | null = null;
  try {
    await withBackofficePool(binding, async (pool: Pool) => {
      const idHash = await hashSessionIdentifier(cookieValue);
      const row = await loadSessionByHash(pool, idHash);
      const now = Date.now();
      if (row === null || !isSessionLive(row, now)) {
        return;
      }

      const verification = await verifyAccessToken(row.access_token, config);
      if (verification.outcome === 'unavailable') {
        throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
      }
      if (verification.outcome === 'invalid') {
        return;
      }

      await touchSession(pool, idHash, now + SESSION_IDLE_SECONDS * 1000);
      principal = { actorSub: row.account_sub };
    });
  } catch (error) {
    // `H3Error` từ nhánh 503 trong callback giữ nguyên; lỗi driver (pg) bọc
    // thành 503 — không nối message driver (connection string có thể nằm
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
    // Phiên vắng / chết / token invalid ⇒ 401 — một lý do chung, không lộ
    // nhánh nào cụ thể cho caller.
    throw createError({ statusCode: 401, statusMessage: 'unauthorized' });
  }
  event.context[PRINCIPAL_CONTEXT_KEY] = principal;
});
