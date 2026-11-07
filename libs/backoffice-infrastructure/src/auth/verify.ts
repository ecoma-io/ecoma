/**
 * Verify access token của `auth` — resource-server profile, offline theo
 * ADR-0012 §2.
 *
 * ## Hợp đồng verify (đã đối chiếu oidc-provider 9.12.2)
 *
 * Token là JWT ES256, header `typ: at+jwt` + `kid`; payload runtime gồm
 * `sub`, `aud`, `iss`, `exp`, `iat`, `scope`, `client_id`, `jti` — **không có
 * `nbf`** (`formats/jwt.js` của provider không đặt claim này;
 * `AccessTokenClaims` trong `libs/auth-application` khai `nbf` nhưng
 * đường phát hành production là oidc-provider, không qua interface này). Vì
 * vậy phép verify ở đây ghim: chữ ký ES256 theo `kid`, `iss` exact, `aud`
 * exact, `exp` trong quá khứ — **không** đòi `nbf` và **không** đòi claim
 * nào ngoài tập runtime này.
 *
 * ## Phân loại lỗi — hợp đồng 401/503 của ADR-0011 §1
 *
 * Kết quả verify là một trong ba class, caller chuyển thành status:
 * - `invalid` → `401`: chữ ký sai, `iss`/`aud` sai, hết hạn, `kid` không còn
 *   trong JWKS (kể cả sau re-fetch — trong cửa sổ cooldown thì kết luận ngay,
 *   xem `jwks.ts`), token sai cấu trúc.
 * - `unavailable` → `503`: JWKS không fetch được (network/5xx) — "không verify
 *   được **lúc này**", khác "token sai".
 * - `verified` → đi tiếp vào authorization (403 là việc của
 *   `requirePermission`, không phải của module này).
 *
 * ⚠️ Ngưỡng phân loại là **nguồn của lỗi**, không phải message: `jose` ném
 * nhiều loại error class khác nhau, bắt theo tên class là mỏng; ở đây phân
 * theo **hình dạng quyết định** — lỗi do token sai thì caller của fetch JWKS
 * không có lỗi nào cả; lỗi do JWKS không tới được thì token chưa kịp được
 * nhìn. Cả hai đường đều không nhận message từ token để quyết định.
 */

import { jwtVerify } from 'jose';

import { jwksResolver } from './jwks';

/**
 * Cấu hình OIDC đã qua kiểm hình dạng — hình dạng tối thiểu mà verifier dùng.
 *
 * ⚠️ Khai **structurally** ở đây, không import từ `apps/backoffice`
 * (`server/auth/config.ts`): lib infrastructure không phụ thuộc app composition.
 * `config.ts` phía app trả object đúng shape này, nên caller truyền thẳng —
 * TypeScript kiểm tương thích theo cấu trúc. Export cho test và cho caller cần
 * type tham số.
 */
export interface BackofficeAuthConfig {
  /** Issuer của `auth` — so exact với claim `iss` và làm base của mọi endpoint. */
  readonly issuer: string;
  /** Audience của `backoffice` — so exact với claim `aud` của access token. */
  readonly audience: string;
  /** `client_id` của `backoffice` tại `auth` — verifier không dùng tới. */
  readonly clientId: string;
  /**
   * Origin fetch JWKS (tuỳ chọn, local-only) — `null`/`undefined` ⇒ fetch từ
   * issuer như production. KHÔNG tham gia verify: `iss` vẫn so exact với
   * `issuer`, origin chỉ đổi nơi JWKS được lấy. Khai báo tuỳ chọn để caller
   * không có trường này (test, config cũ) vẫn typecheck.
   */
  readonly internalOrigin?: string | null;
}

/** Kết quả verify thành công — đúng tập claim mà verifier dùng. */
export interface VerifiedAccessToken {
  /** Discriminant của union `TokenVerifyResult` — caller narrow trên nó. */
  readonly outcome: 'verified';
  /**
   * `sub` của token = Account ID (định dạng `sub_` + 32 base32) — đầu vào của
   * `loadPrincipalAuthorization`. Module này **không** kiểm format `sub_…`:
   * việc đó thuộc `readPrincipal`/`requirePermission` hiện có (kiểm lại mỗi
   * lần đọc — defense in depth, không suy từ verify token).
   */
  readonly sub: string;
  /** `exp` (epoch giây) — test dùng để ghim; runtime không ra quyết định từ nó. */
  readonly exp: number;
}

/** Class lỗi `invalid` — token sai ⇒ `401`. */
export interface InvalidTokenResult {
  readonly outcome: 'invalid';
}

/** Class lỗi `unavailable` — không verify được lúc này ⇒ `503`. */
export interface UnavailableTokenResult {
  readonly outcome: 'unavailable';
}

export type TokenVerifyResult = VerifiedAccessToken | InvalidTokenResult | UnavailableTokenResult;

/**
 * Verify một access token theo cấu hình; không ném — mọi thất bại là kết quả
 * có phân loại.
 *
 * @param token Chuỗi JWT từ phiên — caller không log giá trị này (SR-014).
 * @param config Cấu hình OIDC đã qua kiểm hình dạng — nguồn `iss`/`aud`.
 */
export async function verifyAccessToken(
  token: string,
  config: BackofficeAuthConfig,
): Promise<TokenVerifyResult> {
  let resolver;
  try {
    // Origin nội bộ (nếu có) chỉ đổi NƠI JWKS được fetch — issuer vẫn là khóa
    // cache và chuẩn so `iss` exact. `null`/`undefined` là production: URL từ
    // issuer, hành vi giữ nguyên.
    resolver = await jwksResolver(config.issuer, config.internalOrigin ?? undefined);
  } catch {
    return { outcome: 'unavailable' };
  }

  try {
    const { payload } = await jwtVerify(token, resolver, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['ES256'],
      // Mặc định của `jose` đã bắt `exp`; `requiredClaims` ghim các claim bắt
      // buộc — token thiếu `sub` hay thiếu `exp` là token ngoài contract ⇒
      // `401`, không phải NPE ở tầng sau.
      requiredClaims: ['iss', 'aud', 'exp', 'sub'],
      clockTolerance: 5,
    });

    if (typeof payload.sub !== 'string') {
      return { outcome: 'invalid' };
    }
    return { outcome: 'verified', sub: payload.sub, exp: payload.exp as number };
  } catch (error) {
    return classifyJoseError(error);
  }
}

/**
 * Phân loại lỗi của `jwtVerify` — `invalid` (401) hay `unavailable` (503).
 *
 * ⚠️ Chỉ có **một** hình dạng lỗi là `unavailable`: lỗi fetch JWKS
 * (`JWKSInvalid`/`fetch` network). Mọi lỗi khác — chữ ký, claim, cấu trúc —
 * đều là `invalid`: fail-closed theo hướng "token sai" vì token đã được nhìn
 * và không vượt qua được phép kiểm.
 */
function classifyJoseError(error: unknown): InvalidTokenResult | UnavailableTokenResult {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'JWKSInvalid' || name === 'TypeError' || name === 'FetchError') {
    // `TypeError`: fetch network ném `TypeError: fetch failed` (undici) —
    // không phải lỗi token, là lỗi "không verify được lúc này".
    return { outcome: 'unavailable' };
  }
  return { outcome: 'invalid' };
}
