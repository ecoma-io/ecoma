/**
 * `GET /api/auth/session` — trạng thái phiên **chỉ để hiển thị** của shell
 * (#182): `{ authenticated: boolean }`, luôn `200`.
 *
 * ## Vì sao route này tồn tại
 *
 * Shell cần biết render "Log in" hay "Log out". Hai đường sẵn có đều không dùng
 * được cho việc đó: `/api/me` nằm sau middleware authn — ở môi trường không có
 * cấu hình OIDC nó trả `503`, và Chromium ghi một console error cho **mỗi**
 * response lỗi, làm đỏ bộ test browser prototype (dưới đây) chỉ vì shell hỏi
 * trạng thái. Route này nằm **ngoài** ranh giới authn (`AUTH_PATHS` của
 * `server/middleware/authn.ts`, cùng nhóm với ba route auth flow): không cookie
 * ⇒ trả ngay `{ authenticated: false }` mà không chạm cấu hình, DB hay JWKS —
 * tức luôn `200`, không bao giờ sinh lỗi console.
 *
 * ## Phép đo mirrors middleware authn, quyết định không
 *
 * Khi có cookie, phép đo lặp đúng trình tự của middleware (`server/middleware/
 * authn.ts`): load phiên theo hash, kiểm còn sống, verify access token. Nhưng
 * route này **không** trượt idle expiry (`touchSession`) và **không** gắn
 * principal: nó không phải đường xác thực — chỉ đọc trạng thái. Mọi quyết định
 * vẫn do middleware authn ban hành trên từng route thật.
 *
 * ## Degraded ⇒ `false`, không bao giờ 5xx
 *
 * Khi không **kết luận được** (cấu hình vắng, DB không gọi được, JWKS không
 * fetch được — đúng các nhánh `503` của ADR-0011), route trả
 * `{ authenticated: false }` kèm **một** dòng log `session_probe.degraded`
 * mang reason. Đây là controlled degrade cho **bề mặt hiển thị**, cùng tinh
 * thần `me.get.ts` trả `displayName: null`: hiện "Log in" là đường phục hồi
 * đúng trong mọi trạng thái đó (kickoff thật sẽ 503 lớn nếu hạ tầng thật sự
 * sập), và **không có** dữ liệu hay quyết định quyền nào phụ thuộc boolean
 * này — mọi route được bảo vệ vẫn tự enforce qua middleware authn. Boolean
 * `false` ở đây nghĩa là "không xác nhận được phiên dùng được", không phải
 * "chắc chắn chưa đăng nhập" — khác biệt đó không lộ ra UI vì cả hai đều dẫn
 * tới cùng một affordance.
 *
 * ## Vì sao `Cache-Control: no-store`
 *
 * Response gắn với phiên hiện tại; một tầng cache giữ `{ authenticated: true }`
 * cho một phiên khác (hoặc giữ `false` sau login) là trạng thái shell sai.
 */

import { defineEventHandler, getCookie, setResponseHeader, type H3Event } from 'h3';

import {
  hashSessionIdentifier,
  isSessionLive,
  loadSessionByHash,
  SESSION_COOKIE_NAME,
  verifyAccessToken,
  withBackofficePool,
} from '@ecoma-io/backoffice-infrastructure';

import { backofficeAuthConfig } from '../../auth/config';
import { poolBinding } from '../../db';
import { writeLog } from '../../log';

/** Kết quả phép đo trên một phiên có cookie — cần cả hai nguồn cấu hình + DB. */
type ProbeOutcome = { readonly authenticated: boolean; readonly degradedReason?: string };

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  // 1. Cookie vắng ⇒ kết luận được ngay (ADR-0011 §1: server biết chắc chưa
  //    có ai xác thực) — không chạm cấu hình hay DB, không có lỗi nào để log.
  const cookieValue = getCookie(event, SESSION_COOKIE_NAME);
  if (cookieValue === undefined || cookieValue.length === 0) {
    return { authenticated: false };
  }

  const outcome: ProbeOutcome = await probeWithCookie(event, cookieValue);

  if (outcome.degradedReason !== undefined) {
    // ⚠️ Log không chứa giá trị cookie/token (SR-14): chỉ reason ổn định.
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
  const config = backofficeAuthConfig(event);
  if (config === null) {
    return { authenticated: false, degradedReason: 'auth_config_missing' };
  }

  const binding = poolBinding(event);
  if (binding === null) {
    return { authenticated: false, degradedReason: 'db_binding_missing' };
  }

  try {
    return await withBackofficePool(binding, async (pool) => {
      const idHash = await hashSessionIdentifier(cookieValue);
      const row = await loadSessionByHash(pool, idHash);
      const now = Date.now();
      if (row === null || !isSessionLive(row, now)) {
        // Phiên vắng/hết hạn/revoke: kết luận được ("không có phiên dùng được")
        // — không phải trạng thái degraded, không log.
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
    });
  } catch {
    // Lỗi driver (pg) — không nối message driver (connection string có thể nằm
    // trong message), cùng luật với middleware authn.
    return { authenticated: false, degradedReason: 'db_unreachable' };
  }
}
