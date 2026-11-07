/**
 * `GET /api/auth/callback` — hoàn tất luồng đăng nhập (ADR-0012 §1.3–1.4).
 *
 * Chuỗi bước, mỗi bước fail đều **không tạo phiên**:
 *
 * 1. So khớp query (`code` + `state` đủ mặt) — thiếu ⇒ 400, không nhầm với
 *    401 (đây là lỗi luồng, không phải trạng thái đăng nhập).
 * 2. Đọc cookie flow + **consume bằng DELETE** (single-use): rowCount 0 ⇒
 *    replay/lặp/hết hạn ⇒ 401. Không có nhánh "đọc rồi xoá sau" — hai callback
 *    đồng thời cùng cookie thì đúng một đi qua.
 * 3. Đổi code → token tại `POST {issuer}/token` (auth method `none`, kèm
 *    `code_verifier`). Lỗi từ token endpoint ⇒ 401 với lý do chung — kể cả
 *    `invalid_grant` (code dùng lại; code CAS của `auth` là lớp chặn thứ ba,
 *    sau cookie và `state`).
 * 4. Verify **access token** (ES256/`iss`/`aud`/`exp`) — token không vượt qua
 *    phép verify thì phiên không được tạo (không bao giờ lưu token chưa
 *    verify).
 * 5. Verify **ID token** để lấy `auth_time` (step-up ADR-0012 §3): chữ ký,
 *    `iss`, `aud` = `client_id`, `exp`, và `sub` khớp access token. ID token
 *    hỏng ⇒ 401 — phiên step-up không được dựng trên bằng chứng chưa verify.
 * 6. INSERT phiên `bff_sessions` (idle 12h, absolute 7d) + cookie
 *    `__Host-backoffice-session` + cookie CSRF, xoá cookie flow ⇒ 302 về `/`.
 *
 * ## Vì sao các bước 2–5 chung một trạng thái từ chối
 *
 * Phân biệt "cookie replay" với "code sai" hay "ID token hỏng" là thông tin
 * cho attacker dò luồng; caller của luồng chỉ cần biết "đăng nhập không thành
 * công, thử lại". Status 401 chung; lý do mã cố định chỉ đi vào log
 * server-side (`writeLog`), không chứa giá trị nào từ request.
 *
 * ⚠️ Token không bao giờ vào log hay response (SR-014).
 */

import {
  createError,
  defineEventHandler,
  getCookie,
  getHeader,
  getQuery,
  sendRedirect,
  setResponseHeader,
} from 'h3';
import { jwtVerify } from 'jose';
import type { H3Event } from 'h3';

import {
  accountClientConfig,
  createCsrfToken,
  createSessionIdentifier,
  csrfCookie,
  fetchAccountProfiles,
  hashSessionIdentifier,
  insertSession,
  jwksResolver,
  sessionCookie,
  sessionDeadlines,
  verifyAccessToken,
  withBackofficePool,
} from '@ecoma-io/backoffice-infrastructure';

import { backofficeAuthConfig, type BackofficeAuthConfig } from '../../auth/config';
import {
  clearLoginFlowCookie,
  consumeLoginFlow,
  hashFlowIdentifier,
  LOGIN_FLOW_COOKIE_NAME,
  needsDisplayName,
} from '@ecoma-io/backoffice-application';
import { poolBinding, readWorkerEnv } from '../../db';
import { writeLog } from '../../log';

/**
 * Scope đã xin ở login (`openid offline_access`) ⇒ response của `/token` luôn
 * có `id_token` và `refresh_token`. Kiểm hình dạng giá trị trước khi dùng —
 * response là dữ liệu ngoài biên.
 */
interface TokenEndpointResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly id_token?: unknown;
}

/**
 * Nguồn connection string PostgreSQL của request — dùng hàm chung `poolBinding`
 * của `server/db.ts` (một thứ tự nguồn cho toàn app). Trước đây logic này nhân
 * bản tại đây và ở middleware authn, còn khung `withReadEnforcement` lại thiếu
 * nhánh Node — nhân bản lệch là read route chết 503 trên local (bug thật).
 */

/** `redirect_uri` — cùng công thức với login (một nguồn). */
function callbackRedirectUri(event: H3Event): string {
  const host = getHeader(event, 'host') ?? 'localhost';
  const proto = getHeader(event, 'x-forwarded-proto') ?? 'https';
  return `${proto}://${host}/api/auth/callback`;
}

/**
 * Từ chối với mã lý do ổn định vào log — response chỉ là status, không có
 * message chi tiết (ADR-0012 §2: phân loại 401/503 là contract, message chỉ
 * vào log server không chứa token).
 */
function reject(event: H3Event, status: 400 | 401 | 503, reason: string): never {
  writeLog({ event: 'backoffice_login.rejected', route: '/api/auth/callback', status, reason });
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
 * ⚠️ Không gửi `resource`: glue của `auth` tự chèn `resource=<AUTH_AUDIENCE>`
 * vào authorize params và `defaultResource` quyết định audience của token
 * (đối chiếu `browser-handlers.ts` + `provider.ts`) — client không có quyền
 * chọn resource, một `resource` lạ bị `auth` loại bằng `InvalidTarget`.
 *
 * ⚠️ Origin fetch là `fetchOrigin` (fallback issuer): trên local, issuer mang
 * port động của Traefik đúng cho browser nhưng container Node không tới được
 * origin đó — fetch đi qua origin nội bộ do cấu hình cấp (`config.ts`). URL
 * path `/token` không đổi: provider serve cùng endpoint trên cả hai origin.
 *
 * @returns Response đã parse, hoặc `null` cho mọi nhánh thất bại (network,
 *   non-2xx, body không parse được) — caller phân loại chung một lý do.
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

/**
 * Verify ID token cho step-up — chữ ký, `iss`, `aud` = `client_id`, `exp`,
 * và `sub` khớp access token (ADR-0012 §3).
 *
 * @returns `auth_time` (epoch ms) + `acr`, hoặc `null` khi bất kỳ phép kiểm
 *   nào thất bại.
 */
async function verifyIdToken(
  idToken: string,
  config: BackofficeAuthConfig,
  expectedSub: string,
): Promise<{ authTimeMs: number | null; acr: string | null } | null> {
  try {
    // Cùng luật fetch-origin với access token: JWKS lấy từ origin nội bộ khi
    // cấu hình (local), `iss` vẫn so exact với issuer trên cả hai đường.
    const resolver = await jwksResolver(config.issuer, config.internalOrigin ?? undefined);
    const { payload } = await jwtVerify(idToken, resolver, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ['ES256'],
      requiredClaims: ['iss', 'aud', 'exp', 'sub'],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || payload.sub !== expectedSub) {
      return null;
    }
    const authTime = payload.auth_time;
    const acr = payload.acr;
    return {
      authTimeMs: typeof authTime === 'number' ? authTime * 1000 : null,
      acr: typeof acr === 'string' ? acr : null,
    };
  } catch {
    return null;
  }
}

export default defineEventHandler(async (event: H3Event): Promise<void> => {
  setResponseHeader(event, 'Cache-Control', 'no-store');

  const config = backofficeAuthConfig(event);
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

  const flowIdHash = await hashFlowIdentifier(flowCookie as string);
  const consumed = await withBackofficePool(binding, (pool) =>
    consumeLoginFlow(pool, flowIdHash, state),
  ).catch(() => null);
  if (consumed === null) {
    // Hàng không tồn tại / `state` sai / hết hạn / DB lỗi — chung một từ chối.
    reject(event, 401, 'flow_not_consumable');
  }

  // 3. Đổi code → token — fetch origin nội bộ khi cấu hình (local), issuer
  // khi không (production): danh tính `iss` không đổi, chỉ nơi POST đổi.
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

  // 5. Verify ID token — bằng chứng step-up (`auth_time`) của phiên.
  let authTimeMs: number | null = null;
  let acr: string | null = null;
  if (typeof tokens?.id_token === 'string' && tokens.id_token.length > 0) {
    const idToken = await verifyIdToken(tokens.id_token, config, verified.sub);
    if (idToken === null) {
      reject(event, 401, 'id_token_invalid');
    }
    authTimeMs = idToken.authTimeMs;
    acr = idToken.acr;
  }

  // 6. Tạo phiên — idle TTL là mốc `expires_at` ghi DB; absolute enforce ở
  // `isSessionLive` tính từ `created_at` (cột default `now()` của DB).
  const sessionValue = createSessionIdentifier();
  const csrfValue = createCsrfToken();
  const deadlines = sessionDeadlines(Date.now());
  await withBackofficePool(binding, async (pool) => {
    const idHash = await hashSessionIdentifier(sessionValue);
    await insertSession(pool, {
      idHash,
      accountSub: verified.sub,
      accessToken: accessToken as string,
      refreshToken,
      authTime: authTimeMs === null ? null : new Date(authTimeMs),
      acr,
      expiresAt: new Date(deadlines.idleExpiresAtMs),
    });
  }).catch(() => {
    reject(event, 503, 'session_store_unavailable');
  });

  writeLog({
    event: 'backoffice_login.done',
    route: '/api/auth/callback',
    status: 302,
    sub: verified.sub,
  });

  setResponseHeader(event, 'Set-Cookie', [
    sessionCookie(sessionValue),
    csrfCookie(csrfValue),
    clearLoginFlowCookie(),
  ]);
  // Onboarding gate (#325): phiên mới có `needsDisplayName` thì đưa người dùng
  // sang màn onboarding. Đường này là **soft** — chỉ áp cho login vừa hoàn tất;
  // người dùng đã skip onboarding hay vào app từ đường khác không bị chặn. Hỏi
  // `account` ở đây fail-closed theo đúng nghĩa mềm: khi account không trả lời
  // được thì vào thẳng app (không onboarding), chứ không khoá login — gate cứng
  // (2FA, giai đoạn 2) sẽ là quyết định review riêng. Không đọc `needsDisplayName`
  // từ client: quyết định điều hướng thuộc server.
  try {
    const accountConfig = accountClientConfig(readWorkerEnv(event));
    if (accountConfig !== null) {
      const profiles = await fetchAccountProfiles(accountConfig, [verified.sub]);
      if (profiles.ok && needsDisplayName(profiles.profiles, verified.sub)) {
        writeLog({
          event: 'backoffice_login.onboarding_redirect',
          route: '/api/auth/callback',
          status: 302,
          sub: verified.sub,
        });
        return sendRedirect(event, '/onboarding', 302);
      }
    }
  } catch {
    // Mọi lỗi khi hỏi onboarding không được biến thành lỗi login — phiên đã hợp lệ.
  }
  return sendRedirect(event, '/', 302);
});
