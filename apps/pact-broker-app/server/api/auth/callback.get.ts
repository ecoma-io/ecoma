/**
 * `GET /api/auth/callback` — hoàn tất luồng đăng nhập (ADR-0031 §2).
 *
 * Chuỗi bước, mỗi bước fail đều **không tạo phiên**:
 *
 * 1. So khớp query (`code` + `state` đủ mặt) — thiếu ⇒ 400 (lỗi luồng, không
 *    phải trạng thái đăng nhập).
 * 2. Đọc cookie flow + **consume bằng DELETE** (single-use): rowCount 0 ⇒
 *    replay/lặp/hết hạn ⇒ 401. Hai callback đồng thời cùng cookie thì đúng
 *    một đi qua.
 * 3. Đổi code → token tại `POST {issuer}/token` (auth method `none`, kèm
 *    `code_verifier`, **không** `resource` — glue của `auth` tự quyết định
 *    audience). Lỗi từ token endpoint ⇒ 401 với lý do chung.
 * 4. Verify **access token** (ES256/`iss`/`aud`/`exp`) — token không vượt qua
 *    phép verify thì phiên không được tạo.
 * 5. INSERT phiên `bff_sessions` (idle 12h, absolute 7d) + cookie
 *    `__Host-pact-broker-session` + cookie CSRF, xoá cookie flow ⇒ 302 `/`.
 *
 * ## Khác backoffice ở bước ID token (ADR-0031 §2 — quyết định #205)
 *
 * ID token **không được verify** trong M1: portal không cần step-up evidence
 * (`auth_time`) và sub đã lấy từ access token đã verify. Response của `/token`
 * có thể mang `id_token` — bị bỏ qua, không lưu, không verify. Khi step-up
 * cần (M2+), thêm bước verify ID token là migration cột + một bước callback.
 *
 * ## Vì sao các bước 2–4 chung một trạng thái từ chối
 *
 * Phân biệt "cookie replay" với "code sai" là thông tin cho attacker dò luồng;
 * caller chỉ cần biết "đăng nhập không thành công, thử lại". Status 401 chung;
 * lý do mã cố định chỉ vào log server-side, không chứa giá trị nào từ request.
 *
 * ⚠️ Token không bao giờ vào log hay response (SR-007).
 */

import {
  createError,
  defineEventHandler,
  getCookie,
  getHeader,
  getQuery,
  sendRedirect,
  setResponseHeader,
  type H3Event,
} from 'h3';

import {
  clearLoginFlowCookie,
  consumeLoginFlow,
  hashFlowIdentifier,
  LOGIN_FLOW_COOKIE_NAME,
} from '../../auth/login-flow';
import {
  createCsrfToken,
  createPactBrokerAppPool,
  createSessionIdentifier,
  csrfCookie,
  hashSessionIdentifier,
  insertSession,
  sessionCookie,
  sessionDeadlines,
} from '../../auth/session';
import { verifyAccessToken } from '../../auth/verify';
import { pactBrokerAuthConfig } from '../../auth/config';
import { poolBinding } from '../../db';
import { writeLog } from '../../log';

/**
 * Response của `/token` — dữ liệu ngoài biên, kiểm hình dạng từng field trước
 * khi dùng.
 */
interface TokenEndpointResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
}

/**
 * `redirect_uri` — cùng công thức với login (một nguồn).
 *
 * ⚠️ Trust model (review #254): giá trị từ header chỉ đóng vai trò dựng chuỗi —
 * header giả chỉ dựng được URI **không khớp** exact-match `client_redirect_uris`
 * đã đăng ký của `auth`, và authorization code không bao giờ được phát hành cho
 * URI không khớp. Lớp chặn thật sự thuộc `auth`; nơi này không giữ allowlist
 * origin (cùng hợp đồng `apps/backoffice`).
 */
function callbackRedirectUri(event: H3Event): string {
  const host = getHeader(event, 'host') ?? 'localhost';
  const proto = getHeader(event, 'x-forwarded-proto') ?? 'https';
  return `${proto}://${host}/api/auth/callback`;
}

/**
 * Từ chối với mã lý do ổn định vào log — response chỉ là status, không có
 * message chi tiết (ADR-0031 §2: phân loại 400/401/503 là contract).
 */
function reject(event: H3Event, status: 400 | 401 | 503, reason: string): never {
  writeLog({ event: 'pact_broker_login.rejected', route: '/api/auth/callback', status, reason });
  throw createError({
    statusCode: status,
    statusMessage:
      status === 400 ? 'Bad Request' : status === 401 ? 'Unauthorized' : 'Service Unavailable',
  });
}

/**
 * Đổi code → token tại `POST {issuer}/token` — public client, auth method
 * `none`, PKCE `code_verifier` (RFC 6749 §4.1.3).
 *
 * ⚠️ Origin fetch là `internalOrigin ?? issuer`: trên local, issuer mang port
 * động của Traefik đúng cho browser nhưng container Node không tới được origin
 * đó — fetch đi qua origin nội bộ do cấu hình cấp. Path `/token` không đổi.
 *
 * @returns Response đã parse, hoặc `null` cho mọi nhánh thất bại — caller
 *   phân loại chung một lý do.
 */
async function exchangeCode(
  fetchOrigin: string,
  clientId: string,
  redirectUri: string,
  code: string,
  codeVerifier: string,
): Promise<TokenEndpointResponse | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  let response: Response;
  try {
    response = await fetch(new URL('/token', fetchOrigin).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const parsed = (await response.json().catch(() => null)) as TokenEndpointResponse | null;
  return parsed;
}

export default defineEventHandler(async (event: H3Event): Promise<void> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const config = pactBrokerAuthConfig(event);
  if (config === null) {
    reject(event, 503, 'no_config');
  }

  // 1. Query đủ mặt.
  const query = getQuery(event);
  const code = typeof query.code === 'string' ? query.code : '';
  const state = typeof query.state === 'string' ? query.state : '';
  if (code.length === 0 || state.length === 0) {
    reject(event, 400, 'missing_query');
  }

  // 2. Cookie flow + consume single-use.
  const flowCookie = getCookie(event, LOGIN_FLOW_COOKIE_NAME);
  if (flowCookie === undefined || flowCookie.length === 0) {
    reject(event, 401, 'no_flow_cookie');
  }

  const binding = poolBinding(event);
  if (binding === null) {
    reject(event, 503, 'no_db');
  }

  // Một pool cho toàn bộ callback (review #254): consume flow và INSERT phiên
  // dùng chung pool — hai pool riêng chỉ tốn thêm setup mà không mua gì; pool
  // sống đúng scope handler này, `end()` trong `finally`.
  // ⚠️ Consume TRƯỚC exchange là chủ đích, không đổi (single-use: rowCount 0 ⇒
  // replay/lặp/hết hạn ⇒ 401). Hệ quả được chấp nhận: insert phiên thất bại
  // (503) thì hàng flow đã mất — người dùng login lại từ đầu; đổi thành
  // "insert trước, consume sau" mở cửa replay của luồng đang dở, tệ hơn.
  // Khai báo ở scope ngoài vì TS không narrow `reject(...)` là `never` qua
  // nhánh `consumed === null` trong cùng scope `try`.
  const pool = createPactBrokerAppPool(binding.connectionString);
  let sessionValue = '';
  let csrfValue = '';
  let verifiedSub = '';
  try {
    let consumed: { codeVerifier: string } | null;
    try {
      const flowIdHash = await hashFlowIdentifier(flowCookie as string);
      consumed = await consumeLoginFlow(pool, flowIdHash, state);
    } catch {
      consumed = null;
    }
    if (consumed === null) {
      // Hàng không tồn tại / `state` sai / hết hạn / DB lỗi — chung một từ chối.
      reject(event, 401, 'flow_not_consumable');
    }

    // 3. Đổi code → token — fetch origin nội bộ khi cấu hình (local), issuer
    // khi không (production).
    const tokens = await exchangeCode(
      config.internalOrigin ?? config.issuer,
      config.clientId,
      callbackRedirectUri(event),
      code,
      consumed.codeVerifier,
    );
    const accessToken =
      typeof tokens?.access_token === 'string' && tokens.access_token.length > 0
        ? tokens.access_token
        : null;
    if (accessToken === null) {
      reject(event, 401, 'exchange_failed');
    }
    // Refresh token được lưu dự phòng cho đường refresh của #258 (chưa hiện
    // thực ở M1 — session.ts chỉ có sliding/absolute, không có rotation). Đường
    // refresh khi hiện thực phải kèm rotation và guard UPDATE của migration
    // đã cho phép đổi cột này; cho tới lúc đó giá trị nằm bất động trong DB.
    const refreshToken =
      typeof tokens?.refresh_token === 'string' && tokens.refresh_token.length > 0
        ? tokens.refresh_token
        : null;

    // 4. Verify access token — không lưu token chưa verify.
    const verified = await verifyAccessToken(accessToken as string, config);
    if (verified.outcome === 'unavailable') {
      reject(event, 503, 'jwks_unavailable');
    }
    if (verified.outcome === 'invalid') {
      reject(event, 401, 'access_token_invalid');
    }

    // 5. Tạo phiên — idle TTL là mốc `expires_at` ghi DB; absolute enforce ở
    // `isSessionLive` tính từ `created_at` (cột default `now()` của DB).
    // ⚠️ ID token của response bị bỏ qua — ADR-0031 §2 quyết định không verify
    // trong M1 (xem JSDoc của file).
    sessionValue = createSessionIdentifier();
    csrfValue = createCsrfToken();
    const deadlines = sessionDeadlines(Date.now());
    const idHash = await hashSessionIdentifier(sessionValue);
    await insertSession(pool, {
      idHash,
      accountSub: verified.sub,
      accessToken: accessToken as string,
      refreshToken,
      expiresAt: new Date(deadlines.idleExpiresAtMs),
    });
    verifiedSub = verified.sub;
  } catch (error) {
    // Lỗi nghiệp vụ đã reject() sẵn (H3Error); insert phiên/DB lỗi thật ⇒ 503
    // chung — không nối message của driver (connection string có thể nằm trong
    // message).
    if (
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      throw error;
    }
    reject(event, 503, 'session_store_unavailable');
  } finally {
    void pool.end().catch(() => undefined);
  }

  writeLog({
    event: 'pact_broker_login.done',
    route: '/api/auth/callback',
    status: 302,
    sub: verifiedSub,
  });

  setResponseHeader(event, 'Set-Cookie', [
    sessionCookie(sessionValue),
    csrfCookie(csrfValue),
    clearLoginFlowCookie(),
  ]);
  return sendRedirect(event, '/', 302);
});
