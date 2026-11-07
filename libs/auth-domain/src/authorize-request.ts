import { OAuthProtocolError } from './errors';
import { assertWellFormedRedirectUri, redirectUriMatches } from './redirect-uri';
import { parseCodeChallenge } from './pkce';

/**
 * Tham số hợp lệ của một `GET /authorize` (FR-005).
 *
 * ⚠️ Mọi trường ở đây được đọc từ request `/authorize` và ghi vào transaction
 * MỘT LẦN. Sau đó, `/authorize/complete` đọc lại TỪ TRANSACTION — không bao
 * giờ đọc từ query string (FR-009k). Nếu `/authorize/complete` nhận
 * `redirect_uri` từ query thì bất kỳ ai cũng đổi được đích redirect, và
 * transaction chỉ còn là hình thức.
 */

/** `response_type` duy nhất được hỗ trợ. */
export const SUPPORTED_RESPONSE_TYPE = 'code' as const;

/** Grant type duy nhất được hỗ trợ ở `/token` trong scope này. */
export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export type SupportedGrantType = (typeof SUPPORTED_GRANT_TYPES)[number];

export interface AuthorizationRequest {
  responseType: 'code';
  clientId: string;
  redirectUri: string;
  scope: readonly string[];
  state: string | undefined;
  nonce: string | undefined;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

/**
 * `scope` là tham số BẮT BUỘC (OIDC Core: scope REQUIRED trong yêu cầu xác
 * thực): thiếu, rỗng hay toàn khoảng trắng đều bị từ chối ngay — client phải
 * nói rõ muốn gì, không có scope mặc định ngầm.
 */
function parseScope(rawScope: string | undefined): readonly string[] {
  if (rawScope === undefined || rawScope.trim() === '') {
    throw OAuthProtocolError.directInvalidRequest('scope is required');
  }
  return rawScope.split(/\s+/u).filter((part) => part !== '');
}

/**
 * Trần của `state` và `nonce`, tính bằng **UTF-8 bytes** (không phải ký tự).
 *
 * ⚠️ Đơn vị là byte vì giá trị được phản chiếu vào `Location` header và được
 * lưu vào `db-auth`; cả hai đều chịu giới hạn theo byte, không theo ký tự.
 * Một chuỗi Unicode có thể ngắn về ký tự nhưng vượt byte — chỉ kiểm
 * `.length` là chặn hụt.
 *
 * 512 là ngưỡng được chốt cho hợp đồng persistence này: đủ rộng cho mọi
 * client thực tế (RFC 6749 chỉ nói `state` là "phổ biến để chống CSRF",
 * không đặt trần), đủ hẹp để không biến một tham số không kiểm soát thành
 * nơi nhồi dữ liệu vào DB và vào response redirect.
 */
export const MAX_STATE_LENGTH_BYTES = 512;
export const MAX_NONCE_LENGTH_BYTES = 512;

/** Kiểm một giá trị `state`/`nonce` nằm trong trần byte; ném `invalid_request` khi vượt. */
function assertOptionalParamByteLimit(
  value: string | undefined,
  field: 'state' | 'nonce',
  maxBytes: number,
): void {
  if (value === undefined) {
    return;
  }
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength > maxBytes) {
    throw OAuthProtocolError.directInvalidRequest(`${field} vuot gioi han ${maxBytes} byte`);
  }
}

/**
 * Parse và kiểm tra tham số `/authorize`.
 *
 * ⚠️ Thứ tự kiểm tra ở đây CÓ Ý NGHĨA. `client_id` và `redirect_uri` phải được
 * kiểm tra TRƯỚC mọi thứ khác, vì:
 *
 * 1. Chỉ khi `client_id` hợp lệ mới biết được `redirect_uri` đăng ký — mà
 *    không có nó thì không redirect được lỗi.
 * 2. Kiểm tra sai thứ tự (ví dụ validate PKCE trước) sẽ trả lỗi cho một
 *    `redirect_uri` CHƯA được xác minh, và handler thấy lỗi thì redirect tới
 *    nó ⇒ open redirect.
 *
 * Hàm này chỉ kiểm tra CÚ PHÁP. Việc client đã đăng ký và URI có khớp không thuộc
 * tầng trên (cần tra DB) — `assertRegisteredRedirectUri`.
 */
export function parseAuthorizationRequest(params: {
  responseType: string | undefined;
  clientId: string | undefined;
  redirectUri: string | undefined;
  scope: string | undefined;
  state: string | undefined;
  nonce: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
}): AuthorizationRequest {
  // ⚠️ Mọi lỗi trong hàm này đều là `directInvalidRequest` — KHÔNG redirect.
  //
  // Lý do không phải là cẩn thận thừa: tại thời điểm gọi hàm này, chưa có bước
  // nào xác minh `redirect_uri` có khớp bản đăng ký hay không. Handler chỉ được
  // redirect lỗi tới `redirect_uri` sau khi `assertRegisteredRedirectUri` đã đi
  // qua. Redirect trước bước đó là open redirect — chính là T-04.
  //
  // Nếu chỉ kiểm tra `client_id` rồi chuyển sang `redirectable: true` cho phần
  // còn lại thì vẫn hỏng: chỉ cần `code_challenge_method=plain` là đủ để đẩy
  // lỗi tới một URI tùy ý. Đó là lý do ranh giới nằm ở đâu *sau* bước xác minh,
  // chứ không phải ở việc check cái gì trước.
  if (params.responseType === undefined) {
    throw OAuthProtocolError.directInvalidRequest('thieu response_type');
  }
  if (params.responseType !== SUPPORTED_RESPONSE_TYPE) {
    throw OAuthProtocolError.directInvalidRequest(
      `response_type chi ho tro ${SUPPORTED_RESPONSE_TYPE}`,
    );
  }

  // Bắt buộc, không có giá trị mặc định: thiếu `client_id` thì không xác định
  // được client nào để tra bảng đăng ký.
  if (params.clientId === undefined || params.clientId === '') {
    throw OAuthProtocolError.directInvalidRequest('thieu client_id');
  }

  if (params.redirectUri === undefined || params.redirectUri === '') {
    throw OAuthProtocolError.directInvalidRequest('thieu redirect_uri');
  }
  assertWellFormedRedirectUri(params.redirectUri);

  const scope = parseScope(params.scope);
  const { codeChallenge, codeChallengeMethod } = parseCodeChallenge({
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    // Ghi ro rang: moi loi PKCE o giai doan parse deu khong redirect duoc.
    redirectable: false,
  });

  // `state`/`nonce` là optional (RFC 6749 §4.1.1 — `state` là khuyến nghị,
  // không phải bắt buộc) nhưng KHÔNG phải unbounded: giá trị được lưu thẳng
  // vào `db-auth` và được phản chiếu nguyên vẹn vào redirect. Trần ở tầng
  // parse nghĩa là một giá trị vượt trần bị từ chối TRƯỚC khi tạo
  // transaction, không phải bị driver từ chối ở tầng DB với thông báo vô
  // nghĩa. Cũng là `directInvalidRequest` — tại đây `redirect_uri` chưa được
  // xác minh.
  assertOptionalParamByteLimit(params.state, 'state', MAX_STATE_LENGTH_BYTES);
  assertOptionalParamByteLimit(params.nonce, 'nonce', MAX_NONCE_LENGTH_BYTES);

  return {
    responseType: SUPPORTED_RESPONSE_TYPE,
    clientId: params.clientId,
    // Lưu NGUYÊN VĂN. Mọi so khớp về sau đều so với chính chuỗi này.
    redirectUri: params.redirectUri,
    scope,
    state: params.state,
    nonce: params.nonce,
    codeChallenge,
    codeChallengeMethod,
  };
}

/**
 * Lọc scope theo `allowed_scopes` của client.
 *
 * ⚠️ Client được yêu cầu scope KHÔNG nằm trong danh sách là `invalid_scope`
 * ngay tại `/authorize` — không phải "cho qua, lọc khi cấp token". Lọc muộn
 * nghĩa là client vẫn thấy consent screen với scope bị từ chối, và tệ hơn:
 * một consent record có thể ghi nhận scope mà user chưa từng thấy.
 *
 * ⚠️ `redirectable` mặc định `true` là CHỦ ý: hàm này chạy SAU khi
 * `redirect_uri` đã khớp bản đăng ký, nên trả lỗi bằng OAuth error redirect là
 * đúng. Đổi mặc định này sẽ làm người dùng thấy JSON thay vì trang lỗi.
 */
export function filterAllowedScopes(
  requested: readonly string[],
  allowedScopes: readonly string[],
  options: { redirectable?: boolean } = {},
): readonly string[] {
  const fail = (detail: string): OAuthProtocolError =>
    options.redirectable === false
      ? OAuthProtocolError.directInvalidScope(detail)
      : OAuthProtocolError.invalidScope(detail);

  const allowed = new Set(allowedScopes);
  const granted: string[] = [];
  for (const item of requested) {
    if (!allowed.has(item)) {
      throw fail(`scope not allowed: ${item}`);
    }
    granted.push(item);
  }
  return granted;
}

/**
 * Kiểm tra `redirect_uri` khớp EXACT một bản đăng ký.
 *
 * ⚠️ Lỗi ở đây là `redirectable = false`, dù hàm chạy sau bước xác minh client.
 * Lý do: ngay tại thời điểm hàm này chạy, chính nó là bước quyết định xem
 * `redirect_uri` có đáng tin hay chưa — một URI KHÔNG khớp bản đăng ký thì
 * không được dùng làm đích lỗi, vì lỗi tới một URI tùy ý chính là open
 * redirect. Sau khi hàm trả về, `redirect_uri` mới là đã xác minh và các
 * lỗi phía sau được redirect tới nó.
 */
export function assertRegisteredRedirectUri(
  requested: string,
  registeredUris: readonly string[],
  policy: { kind: 'exact' } | { kind: 'loopback-port-variable'; allowedHosts: ReadonlySet<string> },
): void {
  // Dùng lại đúng hàm so khớp đã định nghĩa ở redirect-uri.ts — không lặp lại
  // logic ở đây, vì hai bản sao là hai chỗ có thể lệch nhau và chỗ lệch là
  // open redirect.
  const matched = registeredUris.some((registered) =>
    redirectUriMatches(requested, registered, policy),
  );

  if (!matched) {
    throw OAuthProtocolError.directInvalidRequest('redirect_uri khong khop ban dang ky');
  }
}
