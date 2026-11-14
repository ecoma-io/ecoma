/**
 * Luồng login-in-progress của `remote-cache-app` — `state` + PKCE (S256), lưu
 * server-side gắn một cookie dùng một lần (ADR-0035, theo ADR-0031 §2).
 *
 * Deliberate duplication của `apps/pact-broker-app/server/auth/login-flow.ts`
 * (module boundary cấm import chéo, 05-code-architecture.md §7). Bảng đích là
 * `remote_cache_app.bff_login_flows` — database riêng của app này (invariant 1).
 *
 * ## Chống replay callback — ba lớp độc lập
 *
 * 1. **Cookie `__Host-remote-cache-app-login` dùng một lần** — giá trị 256-bit
 *    do BFF cấp lúc `/api/auth/login`, xả ngay khi callback dùng nó (`DELETE`
 *    trả rowCount 0 ⇒ replay/lặp/hết hạn ⇒ từ chối).
 * 2. **`state`** — giá trị do BFF sinh, lưu cùng hàng với verifier; callback
 *    so khớp query `state` với hàng của cookie.
 * 3. **Authorization code** — single-use CAS ở chính `auth`: code dùng hai
 *    lần là `invalid_grant` ở `/token`.
 */

import type { Pool } from 'pg';

/** Cookie của luồng login — `__Host-`, dùng một lần, TTL ngắn. */
export const LOGIN_FLOW_COOKIE_NAME = '__Host-remote-cache-app-login';

/** TTL hàng flow (giây) — 10 phút, khớp interaction TTL của `auth`. */
export const LOGIN_FLOW_TTL_SECONDS = 600;

/** Entropy của cookie flow / `state` / verifier — 256 bit mỗi giá trị. */
const FLOW_VALUE_BYTES = 32;

/** Hàng luồng login. */
export interface RemoteCacheAppLoginFlowRow {
  readonly id_hash: string;
  readonly state: string;
  /** PKCE code_verifier — bí mật phía BFF; challenge = S256(verifier). */
  readonly code_verifier: string;
  readonly created_at: Date;
  readonly expires_at: Date;
}

/** Sinh giá trị 256-bit base64url — cookie flow, `state`, hay verifier. */
export function createFlowValue(random?: Uint8Array): string {
  const bytes = random ?? crypto.getRandomValues(new Uint8Array(FLOW_VALUE_BYTES));
  return base64UrlEncode(bytes);
}

/** PKCE `code_challenge` = BASE64URL(SHA-256(verifier)) — RFC 7636 §4.2. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** SHA-256 hex của cookie flow — khoá tra cứu duy nhất (cùng pattern session). */
export async function hashFlowIdentifier(identifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identifier));
  let out = '';
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  return base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Tạo hàng luồng login — INSERT một lần; TTL 10 phút khớp interaction TTL của
 * `auth`.
 */
export async function insertLoginFlow(
  pool: Pool,
  params: { idHash: string; state: string; codeVerifier: string; expiresAt: Date },
): Promise<void> {
  await pool.query(
    `INSERT INTO remote_cache_app.bff_login_flows (id_hash, state, code_verifier, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [params.idHash, params.state, params.codeVerifier, params.expiresAt],
  );
}

/**
 * Consume hàng luồng login — **vừa là kiểm tra vừa là ghi**: DELETE trả đúng số
 * hàng xoá; `0` nghĩa là hàng không tồn tại (cookie lạ), đã dùng (replay), hay
 * đã hết hạn — mọi lý do đều từ chối callback chung một trạng thái. Hai callback
 * chạy đồng thời với cùng cookie thì đúng một thấy rowCount 1.
 */
export async function consumeLoginFlow(
  pool: Pool,
  idHash: string,
  state: string,
): Promise<{ codeVerifier: string } | null> {
  const result = await pool.query<{ code_verifier: string }>(
    `DELETE FROM remote_cache_app.bff_login_flows
      WHERE id_hash = $1 AND state = $2 AND expires_at > now()
      RETURNING code_verifier`,
    [idHash, state],
  );
  const row = result.rows[0];
  return row === undefined ? null : { codeVerifier: row.code_verifier };
}

/** Cookie luồng login — HttpOnly, SameSite=Lax, TTL khớp hàng. */
export function loginFlowCookie(value: string): string {
  return (
    `${LOGIN_FLOW_COOKIE_NAME}=${value}; Max-Age=${LOGIN_FLOW_TTL_SECONDS}; Path=/; ` +
    'Secure; HttpOnly; SameSite=Lax'
  );
}

/** Xoá cookie luồng login — callback luôn set ở bước hoàn tất. */
export function clearLoginFlowCookie(): string {
  return `${LOGIN_FLOW_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
