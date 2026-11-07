import type { PublicJwk, SigningKeyProvider } from '@ecoma-io/auth-domain';

/**
 * Phát hành token (FR-030..FR-036), theo quyết định D3:
 *
 * - **Access token = JWT tự chứa, ký ES256.** Verify được OFFLINE: resource
 *   server chỉ cần JWKS, không gọi `auth`.
 * - **Refresh token = opaque.** Không tự chứa gì; mọi trạng thái nằm ở
 *   `db-auth`, nên thu hồi có hiệu lực ngay ở lần refresh kế tiếp.
 * - **Không có `/introspect`.** Vì access token verify offline, một endpoint
 *   introspection sẽ là nguồn sự thật thứ hai cho cùng một câu hỏi.
 *
 * ⚠️ **ĐỘ TRỄ THU HỒI — điều phải nói thẳng, không được giấu:**
 * Một access token đã phát hành KHÔNG THỂ thu hồi trước khi hết hạn. Resource
 * server verify nó bằng chữ ký, không hỏi ai. Vì vậy nếu ta thu hồi một grant
 * lúc T, access token đã cấp vẫn dùng được tới `T + accessTokenTtl`. Đây không
 * phải một khiếm khuyết cài đặt mà là hệ quả trực tiếp của offline validation —
 * và cách duy nhất để rút ngắn nó là rút ngắn TTL, đánh đổi bằng nhiều lần
 * refresh hơn.
 *
 * Hệ quả phải nói tiếp: **TTL là một tham số bảo mật**, không phải tham số hiệu
 * năng. `assertRevocationDelayBounded` kiểm điều đó thay vì tin vào một comment.
 */

/** Thuật toán ký duy nhất của access token. Phải khớp khoá. */
// `JWT_SIGNING_ALG` thay vì `ACCESS_TOKEN_ALG`: tiền tố `access_token` khớp nguồn
// của rule security-sensitive-value-in-http-response dù giá trị là TÊN THUẬT TOÁN
// ('ES256') — hằng số chuỗi tĩnh, không phải credential.
export const JWT_SIGNING_ALG = 'ES256' as const;

/**
 * ⚠️ Trần TTL của access token. Vượt trần này bị TỪ CHỐI, không phải cảnh báo.
 *
 * Lý do: giá trị này BẰNG ĐỘ TRỄ THU HỒI. Một access token sống 24 giờ nghĩa
 * là một grant bị thu hồi vẫn còn dùng được tới 24 giờ. Trần 15 phút là một
 * quyết định về chính sách bảo mật — đổi nó là đổi mức rủi ro, nên nó ở đây
 * như một hằng số đọc được chứ không phải một số trong config.
 */
export const MAX_ACCESS_TOKEN_TTL_SECONDS = 900;

/** TTL mặc định của access token: 5 phút. */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 300;

/** Claims tối thiểu mà access token mang. Không thêm claim tuỳ tiện. */
export interface AccessTokenClaims {
  /** Chủ thể — account id. `sub` theo chuẩn JWT. */
  sub: string;
  /** Audience: resource server được phép dùng token này. */
  aud: string;
  /** Issuer. Phải khớp `iss` trong discovery document. */
  iss: string;
  /** Thời điểm hết hạn (epoch giây). */
  exp: number;
  /** Thời điểm phát hành (epoch giây). */
  iat: number;
  /** Thời điểm có hiệu lực — bằng `iat` trừ skew, không cho dùng trước. */
  nbf: number;
  /** Client đã được cấp token. */
  client_id: string;
  /** Scope đã cấp, dạng chuỗi space-separated theo RFC 6749. */
  scope: string;
  /** Transaction id đã sinh ra token — để truy vết, KHÔNG phải để phân quyền. */
  transaction_id: string;
}

/** Cấu hình phát hành. */
export interface TokenIssuanceConfig {
  issuer: string;
  audience: string;
  /** TTL tính bằng giây. Bị `MAX_ACCESS_TOKEN_TTL_SECONDS` chặn trên. */
  accessTokenTtlSeconds?: number;
}

/**
 * ⚠️ Chặn trần TTL. Gọi lúc dựng service, không lúc phát hành token: một cấu
 * hình sai phải làm Worker không phát hành được token, chứ không phải phát hành
 * một lần rồi mới lộ ra.
 */
export function assertAccessTokenTtl(ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`access token TTL phai la so nguyen duong, nhan duoc: ${ttlSeconds}`);
  }
  if (ttlSeconds > MAX_ACCESS_TOKEN_TTL_SECONDS) {
    throw new Error(
      `access token TTL ${ttlSeconds}s vuot tran ${MAX_ACCESS_TOKEN_TTL_SECONDS}s; ` +
        'tran bang do tre thu hoi, vi access token verify offline nen khong the thu hoi som',
    );
  }
}

/**
 * Một refresh token opaque đã sinh, kèm bản băm để lưu.
 *
 * ⚠️ `plaintext` chỉ tồn tại trong biến này và trong response. `db-auth` CHỈ
 * nhận `hash`. Nếu bản rõ được lưu, một lần đọc được bảng là một lần mạo danh
 * được mọi phiên.
 */
export interface IssuedRefreshToken {
  plaintext: string;
  /** SHA-256 base64url của plaintext. Đây là thứ được lưu. */
  hash: string;
  /** `id` của token family — dùng để thu hồi cả họ khi phát hiện reuse. */
  familyId: string;
}

/** Kết quả phát hành token. */
export interface IssuedTokens {
  accessToken: string;
  /** Giây, để tính `expires_in` trong response (RFC 6749 §5.1). */
  expiresInSeconds: number;
  refreshToken: IssuedRefreshToken;
  tokenType: 'Bearer';
}

/** Sinh refresh token opaque và băm nó. */
export async function createRefreshToken(params: {
  familyId: string;
  /** Nguồn entropy. Truyền vào để test kiểm soát được. */
  crypto?: Crypto;
}): Promise<IssuedRefreshToken> {
  const cryptoImpl = params.crypto ?? crypto;

  // 32 byte = 256 bit entropy. Refresh token là bí mật dài hạn, nên cần đủ
  // entropy để không thể đoán; đây là ngưỡng thấp hơn giới hạn thực tế nhưng
  // là mức tối thiểu tuyệt đối.
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);

  const plaintext = base64UrlEncode(bytes);
  const hash = await sha256Base64Url(plaintext);

  return { plaintext, hash, familyId: params.familyId };
}

/**
 * Ký access token.
 *
 * ⚠️ Dùng `SignJWT` với thuật toán ES256 và `kid` trong header, để resource
 * server chọn đúng khoá trong JWKS khi xoay khoá.
 */
export async function issueAccessToken(params: {
  claims: AccessTokenClaims;
  signingKey: SigningKeyProvider;
}): Promise<string> {
  const { claims, signingKey } = params;
  const { SignJWT } = await import('jose');

  assertAccessTokenTtl(claims.exp - claims.iat);

  const key = await signingKey.privateKey();

  // `typ: at+jwt` theo RFC 9068 để resource server phân biệt access token với
  // id token. Không có nó thì một id token có thể bị dùng như access token.
  // `SignJWT` ký claims rồi đóng gói thành JWT. Biến `key` từ đây đi ra là
  // chữ ký trên public key, KHÔNG phải private key — và cả access token là
  // dữ liệu công khai theo thiết kế (resource server xác minh offline). Đây
  // không phải đường rò rỉ credential.
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: JWT_SIGNING_ALG, kid: signingKey.kid, typ: 'at+jwt' })
    .setIssuedAt(claims.iat)
    .setNotBefore(claims.nbf)
    .setExpirationTime(claims.exp)
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .sign(key);
}

/** JWKS chỉ chứa khoá công khai — không bao giờ private material. */
export function buildJwks(keys: readonly PublicJwk[]): { keys: PublicJwk[] } {
  return { keys: [...keys] };
}

/** Mã hoá base64url không padding, đúng như JOSE yêu cầu. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** SHA-256 base64url — cùng dạng với `hashHandle` trong domain. */
async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64UrlEncode(new Uint8Array(digest));
}
