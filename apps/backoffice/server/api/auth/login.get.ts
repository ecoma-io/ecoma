/**
 * `GET /api/auth/login` — bắt đầu luồng đăng nhập (ADR-0012 §1.1–1.2).
 *
 * BFF sinh `state` + PKCE `code_verifier`/`code_challenge` (S256), lưu
 * server-side gắn một cookie `__Host-backoffice-login` dùng một lần, rồi
 * `302` browser tới `GET {AUTH_ISSUER}/authorize` với bộ tham số đầy đủ.
 *
 * ## Vì sao tham số authorize nằm ở đây, không ở UI
 *
 * ADR-0012 §1: "UI không tự dựng authorize URL từ dữ liệu client; URL login
 * do BFF dựng từ cấu hình server" — `client_id`, `redirect_uri`, scope là
 * cấu hình deployment, không phải dữ liệu request. UI chỉ điều hướng tới
 * route này.
 *
 * ## Scope
 *
 * `openid offline_access` (ADR-0012 §6): `openid` để có ID token cho step-up
 * (`auth_time`); `offline_access` để có refresh token cho phiên dài hạn.
 * Không `profile` — không claim nào của MVP cần nó.
 *
 * ## Fail-closed
 *
 * - Cấu hình OIDC thiếu ⇒ `503` — luồng login không dựng được URL đúng
 *   contract; không có nhánh "điều hướng kèm cấu hình hỏng".
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

import { withBackofficePool } from '@ecoma-io/backoffice-infrastructure';

import {
  codeChallenge,
  createFlowValue,
  hashFlowIdentifier,
  insertLoginFlow,
  LOGIN_FLOW_TTL_SECONDS,
  loginFlowCookie,
} from '@ecoma-io/backoffice-application';
import { backofficeAuthConfig } from '../../auth/config';
import { poolBinding } from '../../db';

/** Scope xin từ `auth` — hằng số ghim ADR-0012 §6, không nhận từ query. */
const LOGIN_SCOPE = 'openid offline_access';

/**
 * `redirect_uri` của callback — thành phần **path cố định** của chính app
 * này (`/api/auth/callback`), ghép với origin của request.
 *
 * ⚠️ Redirect URI đăng ký ở `auth` phải là origin thật của deployment
 * (`https://…`); origin của request (`x-forwarded-proto`/`host`) là nguồn đúng
 * cho môi trường đã có TLS chặn đầu. Origin lạ ⇒ `auth` từ chối bằng
 * exact-match của `client_redirect_uris` — lớp chặn cuối thuộc `auth`, ở đây
 * chỉ dựng đúng chuỗi.
 */
function callbackRedirectUri(event: H3Event): string {
  const host = getHeader(event, 'host') ?? 'localhost';
  const proto = getHeader(event, 'x-forwarded-proto') ?? 'https';
  return `${proto}://${host}/api/auth/callback`;
}

export default defineEventHandler(async (event: H3Event) => {
  const config = backofficeAuthConfig(event);
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

  await withBackofficePool(binding, async (pool) => {
    const idHash = await hashFlowIdentifier(flowValue);
    await insertLoginFlow(pool, {
      idHash,
      state,
      codeVerifier,
      expiresAt: new Date(Date.now() + LOGIN_FLOW_TTL_SECONDS * 1000),
    });
  });

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
