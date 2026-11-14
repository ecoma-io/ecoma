/**
 * Verify access token của `auth` cho `pact-broker-app` — offline, resource
 * server profile (ADR-0031 §2; cùng hợp đồng verify đã đối chiếu oidc-provider
 * 9.12.2 ở `libs/backoffice-infrastructure/src/auth/verify.ts` — deliberate
 * duplication, module boundary cấm import chéo).
 *
 * Token là JWT ES256, header `typ: at+jwt` + `kid`; payload runtime gồm `sub`,
 * `aud`, `iss`, `exp`, `iat`, `scope`, `client_id`, `jti` — **không có `nbf`**.
 * Phép verify ghim: chữ ký ES256 theo `kid`, `iss` exact, `aud` exact, `exp`
 * trong quá khứ — không đòi `nbf` và không đòi claim nào ngoài tập này.
 *
 * ## Phân loại lỗi — hợp đồng 401/503
 *
 * - `invalid` → `401`: chữ ký sai, `iss`/`aud` sai, hết hạn, `kid` không còn
 *   trong JWKS, token sai cấu trúc.
 * - `unavailable` → `503`: JWKS không fetch được — "không verify được **lúc
 *   này**", khác "token sai".
 * - `verified` → tiếp tục authorization (403 là việc của tầng membership).
 *
 * ⚠️ Ngưỡng phân loại là **nguồn của lỗi**, không phải message — phân theo
 * tên lỗi của fetch JWKS (`JWKSInvalid`/`TypeError`/`FetchError`) là
 * `unavailable`; mọi lỗi khác là `invalid` (fail-closed: token đã được nhìn
 * mà không qua phép kiểm).
 *
 * JWKS cache theo issuer với TTL 10 phút, re-fetch-on-unknown-kid kèm cooldown
 * 30s và single-flight — đầy đủ ngữ nghĩa của `libs/backoffice-infrastructure/
 * src/auth/jwks.ts`, giữ ở một file cho app này.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

/**
 * Cấu hình OIDC đã qua kiểm hình dạng — nguồn `iss`/`aud` của verifier và
 * nơi fetch JWKS/token server-side.
 */
export interface PactBrokerAppAuthConfig {
  /** Issuer của `auth` — so exact với claim `iss` và làm base của mọi endpoint. */
  readonly issuer: string;
  /** Audience của `pact-broker` — so exact với claim `aud` của access token. */
  readonly audience: string;
  /** `client_id` của `pact-broker-app` tại `auth` — public client (auth-deploy seed). */
  readonly clientId: string;
  /**
   * Origin fetch server-side tới `auth` (tuỳ chọn, local-only) — có mặt ⇒
   * fetch JWKS/token từ origin này; `null` ⇒ fetch từ `issuer` (production).
   * KHÔNG tham gia verify: `iss` vẫn so exact với issuer.
   */
  readonly internalOrigin: string | null;
}

/** TTL của JWKS cache (giây) — 10 phút, đồng bộ mặc định `cacheMaxAge` của jose. */
export const JWKS_CACHE_TTL_SECONDS = 600;

/** Cooldown của re-fetch-on-unknown-kid (ms) — 30s, van chống fetch-storm. */
const JOSE_COOLDOWN_MS = 30_000;

interface JwksCacheEntry {
  readonly resolver: JWTVerifyGetKey;
  readonly createdAtMs: number;
}

/** Cache theo issuer — hai môi trường `auth` có key khác nhau, không chung entry. */
const cacheByIssuer = new Map<string, JwksCacheEntry>();

/** In-flight fetch theo issuer — single-flight, tránh fetch-storm lúc TTL hết. */
const inflightByIssuer = new Map<string, Promise<JWTVerifyGetKey>>();

function cachedResolver(issuer: string, nowMs: number): JWTVerifyGetKey | null {
  const entry = cacheByIssuer.get(issuer);
  if (entry === undefined) {
    return null;
  }
  if (nowMs - entry.createdAtMs >= JWKS_CACHE_TTL_SECONDS * 1000) {
    cacheByIssuer.delete(issuer);
    return null;
  }
  return entry.resolver;
}

/**
 * Fetch JWKS của issuer và dựng resolver — ném khi `auth` không trả lời được
 * (caller phân loại `503`).
 *
 * URL JWKS dựng từ `fetchOrigin` — **không phải** issuer — vì trên local
 * container Node không đi ra được origin công khai của issuer; issuer chỉ còn
 * vai trò danh tính. `createRemoteJWKSet` fetch lazy ở lần verify đầu — mọi
 * lỗi network nằm ở `jwtVerify`, thuộc phân loại của caller.
 */
async function fetchResolver(issuer: string, fetchOrigin?: string): Promise<JWTVerifyGetKey> {
  const jwksUrl = new URL('/jwks.json', fetchOrigin ?? issuer).toString();
  return createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: JOSE_COOLDOWN_MS });
}

/**
 * Trả resolver JWKS cho issuer — cache-hit trả ngay, cache-miss fetch
 * (single-flight) rồi cache. Không bao giờ trả resolver của issuer khác.
 */
export function jwksResolver(issuer: string, fetchOrigin?: string): Promise<JWTVerifyGetKey> {
  const nowMs = Date.now();
  const cached = cachedResolver(issuer, nowMs);
  if (cached !== null) {
    return Promise.resolve(cached);
  }

  const inflight = inflightByIssuer.get(issuer);
  if (inflight !== undefined) {
    return inflight;
  }

  const fetchPromise = fetchResolver(issuer, fetchOrigin)
    .then((resolver) => {
      cacheByIssuer.set(issuer, { resolver, createdAtMs: Date.now() });
      return resolver;
    })
    .finally(() => {
      inflightByIssuer.delete(issuer);
    });
  inflightByIssuer.set(issuer, fetchPromise);
  return fetchPromise;
}

/** Xoá sạch cache — chỉ test dùng, production không có caller nào. */
export function resetJwksCacheForTests(): void {
  cacheByIssuer.clear();
  inflightByIssuer.clear();
}

/** Kết quả verify thành công — đúng tập claim mà verifier dùng. */
export interface VerifiedAccessToken {
  readonly outcome: 'verified';
  /** `sub` của token = Account ID — đầu vào của phép phân quyền theo membership. */
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
 * có phân loại. Caller không log giá trị token (SR-007).
 */
export async function verifyAccessToken(
  token: string,
  config: PactBrokerAppAuthConfig,
): Promise<TokenVerifyResult> {
  let resolver;
  try {
    // Origin nội bộ (nếu có) chỉ đổi NƠI JWKS được fetch — issuer vẫn là khóa
    // cache và chuẩn so `iss` exact.
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
      // buộc — token thiếu `sub`/`exp` là token ngoài contract ⇒ `401`.
      requiredClaims: ['iss', 'aud', 'exp', 'sub'],
      clockTolerance: 5,
    });

    if (typeof payload.sub !== 'string') {
      return { outcome: 'invalid' };
    }
    // `exp` đã được `requiredClaims` đòi và `jwtVerify` của jose kiểm là số
    // epoch trước khi trả payload — `as number` ở đây chỉ thu hẹp kiểu mà jose
    // khai rộng (`number | undefined`), không phải tin mù shape ngoài biên
    // (review #254: schema validation runtime là lớp khác, hiện contract này
    // ghim bằng `requiredClaims` + check tường minh từng field dùng).
    return { outcome: 'verified', sub: payload.sub, exp: payload.exp as number };
  } catch (error) {
    return classifyJoseError(error);
  }
}

/**
 * Phân loại lỗi của `jwtVerify` — chỉ lỗi fetch JWKS là `unavailable`; mọi
 * lỗi khác là `invalid` (fail-closed).
 *
 * ⚠️ `TypeError` nằm trong nhóm `unavailable` là có chủ đích và được ghim cùng
 * hợp đồng ở `libs/backoffice-infrastructure/src/auth/verify.ts` (review #254
 * đề nghị bỏ): fetch network của runtime ném `TypeError: fetch failed`
 * (undici/workerd), không phải lỗi token — bỏ nó là lỗi JWKS chưa fetch được
 * rơi vào `invalid` (401) thay vì `unavailable` (503), sai hợp đồng 401/503
 * của JSDoc phía trên. Mọi lỗi khác (chữ ký, claim, cấu trúc) vẫn fail-closed
 * về `invalid` — kịch bản "TypeError do lập trình sai" chỉ xảy ra khi token
 * không phải string, và caller đã ghim `typeof token === 'string'`.
 */
function classifyJoseError(error: unknown): InvalidTokenResult | UnavailableTokenResult {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'JWKSInvalid' || name === 'TypeError' || name === 'FetchError') {
    return { outcome: 'unavailable' };
  }
  return { outcome: 'invalid' };
}
