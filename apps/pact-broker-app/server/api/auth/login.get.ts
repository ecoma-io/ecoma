/**
 * `GET /api/auth/login` — bắt đầu luồng đăng nhập (ADR-0031 §2).
 *
 * BFF sinh `state` + PKCE `code_verifier`/`code_challenge` (S256), lưu
 * server-side gắn một cookie `__Host-pact-broker-login` dùng một lần, rồi
 * `302` browser tới `GET {AUTH_ISSUER}/authorize` với bộ tham số đầy đủ.
 *
 * Cùng đường `apps/backoffice/server/api/auth/login.get.ts` (deliberate
 * duplication — module boundary cấm import chéo).
 *
 * ## Vì sao tham số authorize nằm ở đây, không ở UI
 *
 * ADR-0031 §2: UI không tự dựng authorize URL từ dữ liệu client — `client_id`,
 * `redirect_uri`, scope là cấu hình deployment. UI chỉ điều hướng tới route này.
 *
 * ## Scope
 *
 * `openid offline_access` (ADR-0031 §2): `openid` bắt buộc bởi luồng OIDC;
 * `offline_access` để có refresh token cho phiên dài hạn. Không `profile` —
 * portal không hiển thị claim nào ngoài trạng thái đăng nhập.
 *
 * ## Fail-closed
 *
 * - Cấu hình OIDC thiếu ⇒ `503` — luồng login không dựng được URL đúng
 *   contract.
 * - Binding DB vắng ⇒ `503` — không lưu được luồng thì callback không thể
 *   verify cookie/`state` ⇒ không mở luồng cho qua.
 */

import {
  createError,
  defineEventHandler,
  getHeader,
  sendRedirect,
  setResponseHeader,
  type H3Event,
} from 'h3';

import {
  codeChallenge,
  createFlowValue,
  hashFlowIdentifier,
  insertLoginFlow,
  LOGIN_FLOW_TTL_SECONDS,
  loginFlowCookie,
} from '../../auth/login-flow';
import { createPactBrokerAppPool } from '../../auth/session';
import { pactBrokerAuthConfig } from '../../auth/config';
import { poolBinding } from '../../db';

/** Scope xin từ `auth` — hằng số ghim ADR-0031 §2, không nhận từ query. */
const LOGIN_SCOPE = 'openid offline_access';

/**
 * `redirect_uri` của callback — path cố định `/api/auth/callback` ghép với
 * origin của request (`x-forwarded-proto`/`host`). Origin lạ ⇒ `auth` từ chối
 * bằng exact-match của `client_redirect_uris` — lớp chặn cuối thuộc `auth`.
 *
 * ⚠️ Trust model (review #254): giá trị từ header chỉ dựng chuỗi — header giả
 * chỉ dựng được URI không khớp exact-match `client_redirect_uris` của `auth`,
 * nên authorization code không bao giờ về tay attacker qua đường này; lớp chặn
 * cuối thuộc `auth` (cùng hợp đồng `apps/backoffice`).
 */
function callbackRedirectUri(event: H3Event): string {
  const host = getHeader(event, 'host') ?? 'localhost';
  const proto = getHeader(event, 'x-forwarded-proto') ?? 'https';
  return `${proto}://${host}/api/auth/callback`;
}

export default defineEventHandler(async (event: H3Event) => {
  const config = pactBrokerAuthConfig(event);
  if (config === null) {
    throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
  }

  const binding = poolBinding(event);
  if (binding === null) {
    throw createError({ statusCode: 503, statusMessage: 'authorization unavailable' });
  }

  const flowValue = createFlowValue();
  const state = createFlowValue();
  const codeVerifier = createFlowValue();

  const pool = createPactBrokerAppPool(binding.connectionString);
  try {
    const idHash = await hashFlowIdentifier(flowValue);
    await insertLoginFlow(pool, {
      idHash,
      state,
      codeVerifier,
      expiresAt: new Date(Date.now() + LOGIN_FLOW_TTL_SECONDS * 1000),
    });
  } finally {
    void pool.end().catch(() => undefined);
  }

  // ⚠️ Không gửi `resource`: glue của `auth` tự chèn resource khớp audience
  // đã đăng ký của client — client không có quyền chọn resource.
  const authorizeUrl = new URL('/authorize', config.issuer);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', config.clientId);
  authorizeUrl.searchParams.set('redirect_uri', callbackRedirectUri(event));
  authorizeUrl.searchParams.set('scope', LOGIN_SCOPE);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', await codeChallenge(codeVerifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  setResponseHeader(event, 'Cache-Control', 'no-store');
  setResponseHeader(event, 'Set-Cookie', loginFlowCookie(flowValue));
  return sendRedirect(event, authorizeUrl.toString(), 302);
});
