/**
 * `GET /api/auth/session` — trạng thái phiên **chỉ để hiển thị** của shell:
 * `{ authenticated: boolean }`, luôn `200`.
 *
 * Cùng đường `apps/backoffice/server/api/auth/session.get.ts` (deliberate
 * duplication; cùng lý do tồn tại — shell cần biết render "Log in" hay "Log
 * out" mà không sinh console error ở môi trường chưa cấu hình OIDC).
 *
 * Route này nằm **ngoài** ranh giới authn (`AUTH_PATHS` của middleware):
 * không cookie ⇒ trả ngay `{ authenticated: false }` mà không chạm cấu hình,
 * DB hay JWKS — luôn `200`, không bao giờ sinh lỗi console.
 *
 * ## Phép đo mirrors middleware authn, quyết định không
 *
 * Khi có cookie, phép đo lặp đúng trình tự của middleware: load phiên theo
 * hash, kiểm còn sống, verify access token. Nhưng route này **không** trượt
 * idle expiry và **không** gắn principal — không phải đường xác thực. Mọi
 * quyết định vẫn do middleware authn ban hành trên từng route thật.
 *
 * ## Degraded ⇒ `false`, không bao giờ 5xx
 *
 * Khi không **kết luận được** (cấu hình vắng, DB không gọi được, JWKS không
 * fetch được), route trả `{ authenticated: false }` kèm **một** dòng log
 * `session_probe.degraded` mang reason. Không có dữ liệu hay quyết định quyền
 * nào phụ thuộc boolean này. `false` nghĩa là "không xác nhận được phiên dùng
 * được", không phải "chắc chắn chưa đăng nhập" — cả hai đều dẫn tới cùng một
 * affordance (hiển thị "Log in").
 */

import { defineEventHandler, getCookie, setResponseHeader, type H3Event } from 'h3';

import {
  createPactBrokerAppPool,
  hashSessionIdentifier,
  isSessionLive,
  loadSessionByHash,
  SESSION_COOKIE_NAME,
} from '../../auth/session';
import { verifyAccessToken } from '../../auth/verify';
import { pactBrokerAuthConfig } from '../../auth/config';
import { poolBinding } from '../../db';
import { writeLog } from '../../log';

/** Kết quả phép đo trên một phiên có cookie — cần cả hai nguồn cấu hình + DB. */
type ProbeOutcome = { readonly authenticated: boolean; readonly degradedReason?: string };

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  // 1. Cookie vắng ⇒ kết luận được ngay — không chạm cấu hình hay DB.
  const cookieValue = getCookie(event, SESSION_COOKIE_NAME);
  if (cookieValue === undefined || cookieValue.length === 0) {
    return { authenticated: false };
  }

  const outcome = await probeWithCookie(event, cookieValue);

  if (outcome.degradedReason !== undefined) {
    // ⚠️ Log không chứa giá trị cookie/token (SR-007): chỉ reason ổn định.
    writeLog({
      event: 'session_probe.degraded',
      route: '/api/auth/session',
      method: 'GET',
      status: 200,
      reason: outcome.degradedReason,
    });
  }

  return { authenticated: outcome.authenticated };
});

/**
 * Phép đo khi có cookie — mirrors trình tự của middleware authn, mỗi nhánh
 * không kết luận được trả `degradedReason` thay vì 503.
 */
async function probeWithCookie(event: H3Event, cookieValue: string): Promise<ProbeOutcome> {
  const config = pactBrokerAuthConfig(event);
  if (config === null) {
    return { authenticated: false, degradedReason: 'auth_config_missing' };
  }

  const binding = poolBinding(event);
  if (binding === null) {
    return { authenticated: false, degradedReason: 'db_binding_missing' };
  }

  try {
    const pool = createPactBrokerAppPool(binding.connectionString);
    try {
      const idHash = await hashSessionIdentifier(cookieValue);
      const row = await loadSessionByHash(pool, idHash);
      const now = Date.now();
      if (row === null || !isSessionLive(row, now)) {
        // Phiên vắng/hết hạn/revoke: kết luận được — không phải degraded.
        return { authenticated: false };
      }

      const verification = await verifyAccessToken(row.access_token, config);
      if (verification.outcome === 'unavailable') {
        return { authenticated: false, degradedReason: 'jwks_unavailable' };
      }
      if (verification.outcome === 'invalid') {
        return { authenticated: false };
      }

      return { authenticated: true };
    } finally {
      void pool.end().catch(() => undefined);
    }
  } catch {
    // Lỗi driver (pg) — không nối message driver (connection string có thể
    // nằm trong message), cùng luật với middleware authn.
    return { authenticated: false, degradedReason: 'db_unreachable' };
  }
}
