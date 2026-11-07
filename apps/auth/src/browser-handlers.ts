/**
 * Route browser của `auth` — hai bước §5.1.2 hàng 1-2: `GET /authorize` và
 * `GET /authorize/confirm`.
 *
 * ## `GET /authorize` — cửa ngõ duy nhất, chạy TRƯỚC provider
 *
 * `beginAuthorization` (application layer) parse + nạp client + kiểm
 * `redirect_uri` đã đăng ký + mint transaction kèm handle X — MỌI lỗi trước
 * ranh giới `assertRegisteredRedirectUri` là direct (JSON), sau ranh giới là
 * redirect về `redirect_uri` kèm `error=`. Khi transaction đã mint, cookie
 * `__Host-auth-browser` (32 byte ngẫu nhiên base64url) được set, và browser
 * được 302 tới **route authorization của provider** (`${issuer}/auth`) với tham
 * số gốc + `ecoma_x`. Provider từ đó tạo Interaction, tự đẩy browser tới
 * `interactions.url` → trang login của `account` (mang handle X).
 *
 * ⚠️ KHÔNG redirect thẳng vào `/auth/:uid`: Interaction chưa tồn tại tại thời
 * điểm này (provider tạo nó trong chính request `/auth`), nên một resume URL
 * dựng tay sẽ không có cookie `_interaction` mà resume middleware đòi
 * (resume.js:22-34). Đường hợp pháp duy nhất vào resume là qua `/auth` —
 * nơi provider set cả hai cookie.
 *
 * ## `GET /authorize/confirm?handle=X` — chốt chặn handle-theft (§5.1.0 điều kiện 2)
 *
 * Browser quay lại từ trang login của `account`, mang handle X. Cookie B trên
 * browser được băm và so timing-safe với `browser_binding_hash` của transaction
 * (`confirmBrowser`): CAS chuyển `pending_browser → browser_confirmed`. Kết quả
 * là 302 về `${accountBaseUrl}/login/continue?handle=X` — `account` tiếp tục.
 * Replay của CÙNG browser (cookie khớp, transaction đã `browser_confirmed`, còn
 * TTL) nhận cùng 302 — hop này nằm trên đường browser nên điều hướng trùng là
 * idempotent, không phải lỗi.
 *
 * ⚠️ Binding lệch ⇒ JSON `invalid_request` KHÔNG redirect: redirect kèm handle X
 * chính là đường rò continuation handle (T-04).
 */

import {
  TRANSACTION_TTL_MS,
  beginAuthorization,
  confirmBrowser,
  createOpaqueId,
  type AuthStore,
} from '@ecoma-io/auth-application';
import { OAuthProtocolError, hashHandle } from '@ecoma-io/auth-domain';
import type { AuthConfig } from './config';

/**
 * Cookie binding của `auth` — điều kiện 2 của §5.1.0.
 *
 * Prefix `__Host-`: browser chỉ nhận cookie này khi Secure, `Path=/`, không có
 * `Domain` — đúng biên độ mà §5.1.0 đòi cho một binding browser↔transaction.
 */
export const BROWSER_COOKIE_NAME = '__Host-auth-browser';

/** 32 byte ngẫu nhiên mã hoá base64url (43 ký tự) — cùng entropy `createOpaqueId`. */
export function mintBrowserBinding(): string {
  return createOpaqueId();
}

/** Đọc giá trị cookie từ header `Cookie` — parse tối giản, không library. */
export function readBrowserCookie(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name === BROWSER_COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** Dựng `Set-Cookie` cho browser binding — HttpOnly + Secure + SameSite=Lax. */
export function browserBindingCookie(binding: string, maxAgeSeconds: number): string {
  return (
    `${BROWSER_COOKIE_NAME}=${binding}; ` +
    `Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`
  );
}

/** Tham số authorize mà handler chép lại vào URL cho provider. */
export type AuthorizeQuery = Readonly<Record<string, string | undefined>>;

/** Chỉ những tham số này được chép lại — cho phép tường minh, không spread mù. */
const AUTHORIZED_FORWARD_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
] as const;

/**
 * `GET /authorize` — bước 1 của §5.1.2: mint transaction + set cookie B + 302
 * vào route authorization của provider.
 */
export async function handleAuthorize(params: {
  readonly config: AuthConfig;
  readonly store: AuthStore;
  readonly query: AuthorizeQuery;
  readonly cookieHeader: string | undefined;
  readonly now: Date;
}): Promise<Response> {
  const { config, store, query, now } = params;

  let presented = readBrowserCookie(params.cookieHeader);
  if (presented === undefined || presented === '') {
    // Chưa có cookie — mint mới. `Set-Cookie` đi kèm 302 là cách browser nhận
    // giá trị này; giá trị KHÔNG được đổi trên mỗi request (mỗi lần mint mới với
    // cookie đã có là transaction cũ không còn khớp binding nào).
    presented = mintBrowserBinding();
  }

  let beginResult: { handle: string; transactionId: string; scope: readonly string[] };
  try {
    beginResult = await beginAuthorization({
      store,
      raw: {
        response_type: query['response_type'],
        client_id: query['client_id'],
        redirect_uri: query['redirect_uri'],
        scope: query['scope'],
        state: query['state'],
        nonce: query['nonce'],
        code_challenge: query['code_challenge'],
        code_challenge_method: query['code_challenge_method'],
      },
      handleKey: config.handleKey,
      handleKeyVersion: config.handleKeyVersion,
      browserBinding: presented,
      now,
      newId: () => createOpaqueId(),
    });
  } catch (error) {
    return oauthErrorResponse(error, query);
  }

  // URL resume là route authorization của provider — nơi Interaction được tạo,
  // cookie `_interaction` được set, và `interactions.url` đẩy browser sang
  // account. `ecoma_x` đi như extra param; provider chép nó vào `params` của
  // Interaction (extraParams allowlist), glue đọc lại từ đó khi back-channel.
  const target = new URL(`${config.issuer}/auth`);
  for (const key of AUTHORIZED_FORWARD_PARAMS) {
    const value = query[key];
    if (value !== undefined) {
      target.searchParams.set(key, value);
    }
  }
  target.searchParams.set('ecoma_x', beginResult.handle);
  // `resource` được chèn để access token resource-bound theo cấu hình
  // resourceIndicators của provider. Chọn audience theo client_id nếu client
  // được map tới resource riêng (vd. backoffice); nếu không dùng primary.
  // ⚠️ `client_id` có thể là mảng (query lặp tham số); lọc lấy phần tử string
  // và map qua TẤT CẢ candidate — match đầu tiên thắng, không match ⇒ primary.
  const requestedClientIds = query['client_id'];
  const candidates = (
    Array.isArray(requestedClientIds) ? requestedClientIds : [requestedClientIds]
  ).filter((id): id is string => typeof id === 'string');
  const mappedAudience = config.resources.find((resource) =>
    candidates.some((id) => resource.clientIds.includes(id)),
  )?.audience;
  target.searchParams.set('resource', mappedAudience ?? config.audience);
  // ⚠️ `prompt=consent` khi scope có `offline_access` — bắt buộc của provider
  // (`checkScope`: scopes.js:33-40 cắt `offline_access` khỏi params trừ khi
  // request mang `prompt=consent`; điều kiện `PARAM_LIST.has('prompt')` luôn
  // đúng vì PARAM_LIST là allowlist tên tham số). Không chèn là KHÔNG BAO GIỜ
  // có refresh token. Đây KHÔNG phải hạ rét consent: gate của OIDC đòi "một
  // luồng consent phải chạy" và luồng đó VẪN chạy — qua back-channel ECOMA
  // (`needsConsent` → UI consent của account → `/internal/consent/decide`),
  // và `issueRefreshToken` vẫn đòi `offline_access` phải sống sót tới scope
  // của code. `grantedPath`/`consentRequiredPath` đều gắn `result.consent`
  // trước resume nên `prompt=consent` được resolve đúng tại đó.
  if (beginResult.scope.includes('offline_access')) {
    target.searchParams.set('prompt', 'consent');
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: target.href,
      'Set-Cookie': browserBindingCookie(presented, Math.floor(TRANSACTION_TTL_MS / 1000)),
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * `GET /authorize/confirm?handle=X` — bước 2 của §5.1.2: đối chiếu cookie B
 * (timing-safe qua hash) rồi CAS `pending_browser → browser_confirmed`.
 *
 * ⚠️ Replay của cùng browser (cookie khớp + đã `browser_confirmed`, còn TTL)
 * nhận CÙNG `302 /login/continue?handle=X` — hop này là một bước bắt buộc của
 * LUẬT browser, nên điều hướng trùng không được là lỗi (`confirmBrowser` trả
 * `already-confirmed`, không đổi trạng thái). Mọi nhánh lỗi giữ nguyên JSON
 * `invalid_request` KHÔNG redirect.
 */
export async function handleAuthorizeConfirm(params: {
  readonly store: AuthStore;
  readonly query: AuthorizeQuery;
  readonly cookieHeader: string | undefined;
  readonly accountBaseUrl: string;
  readonly now: Date;
}): Promise<Response> {
  const { store, query, cookieHeader, now } = params;

  const handleX = query['handle'];
  if (handleX === undefined || handleX === '') {
    return jsonOAuthError('invalid_request', 'thieu handle', 400);
  }
  const presented = readBrowserCookie(cookieHeader);
  if (presented === undefined || presented === '') {
    // Không cookie ⇒ không thể chứng minh browser này đã mở transaction —
    // không redirect (rò handle), trả JSON trực tiếp.
    return jsonOAuthError('invalid_request', 'thieu cookie browser binding', 400);
  }

  try {
    const handleXHash = await hashHandle(handleX);
    const transaction = await store.findTransactionByHandleX({ handleXHash });
    if (transaction === undefined) {
      return jsonOAuthError('invalid_request', 'transaction khong ton tai', 400);
    }
    // Hai mode đều dẫn tới cùng một đích — đường tiếp theo không phân biệt lần
    // confirm đầu và replay.
    await confirmBrowser({ store, transaction, presentedBinding: presented, now });
  } catch (error) {
    if (error instanceof OAuthProtocolError) {
      // Mọi OAuthProtocolError ở bước này là direct — `confirmBrowser` ném
      // `directInvalidRequest`, không có biến thể redirectable ở đây.
      return jsonOAuthError(error.code, error.detail ?? error.code, error.httpStatus);
    }
    throw error;
  }

  // Browser tiếp tục tới trang login-continue của `account`, mang handle X —
  // từ đó account đăng nhập rồi push back-channel `session/verified`.
  const target = new URL('/login/continue', params.accountBaseUrl);
  target.searchParams.set('handle', handleX);
  return new Response(null, {
    status: 302,
    headers: { Location: target.href, 'Cache-Control': 'no-store' },
  });
}

/** JSON error cho nhánh direct (KHÔNG redirect). */
function jsonOAuthError(code: string, detail: string, status: number): Response {
  return new Response(JSON.stringify({ error: code, error_description: detail }), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Chuyển `OAuthProtocolError` thành response browser: `redirectable` ⇒ 302
 * `redirect_uri?error=...&state=...` (chỉ dùng khi đã qua ranh giới
 * `assertRegisteredRedirectUri` — chính là chỗ `beginAuthorization` đặt cờ);
 * còn lại ⇒ JSON direct.
 *
 * ⚠️ Lỗi KHÔNG phải `OAuthProtocolError` (bug nội bộ, DB chết...) ⇒
 * `server_error` JSON direct, KHÔNG redirect: redirect về `redirect_uri` khi
 * chưa qua ranh giới là open redirect.
 */
function oauthErrorResponse(error: unknown, query: AuthorizeQuery): Response {
  if (error instanceof OAuthProtocolError) {
    if (error.redirectable && query['redirect_uri'] !== undefined) {
      const target = new URL(query['redirect_uri']);
      target.searchParams.set('error', error.code);
      if (error.detail !== undefined) {
        target.searchParams.set('error_description', error.detail);
      }
      const state = query['state'];
      if (state !== undefined) {
        target.searchParams.set('state', state);
      }
      return new Response(null, {
        status: 302,
        headers: { Location: target.href, 'Cache-Control': 'no-store' },
      });
    }
    return jsonOAuthError(error.code, error.detail ?? error.code, error.httpStatus);
  }
  return jsonOAuthError('server_error', 'internal error', 500);
}
