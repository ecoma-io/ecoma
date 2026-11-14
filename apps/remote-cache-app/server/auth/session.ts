/**
 * Store phiên BFF của `remote-cache-app` — bảng `remote_cache_app.bff_sessions`
 * trong `db-remote-cache-app` (ADR-0035).
 *
 * Deliberate duplication của `apps/pact-broker-app/server/auth/session.ts`
 * (module boundary cấm import chéo, 05-code-architecture.md §7) — cùng hình
 * ADR-0031 §2 từng cột: cookie chỉ mang session ID 256-bit base64url; DB chỉ
 * thấy `id_hash = SHA-256(id)`; token set nằm CHỈ ở DB; idle TTL 12h sliding,
 * absolute 7d từ `created_at` (DB default `now()`).
 *
 * ## Vì sao phiên nằm ở PostgreSQL, không ở KV/Worker memory
 *
 * Invariant 26: ephemeral protocol state nằm ở database của bounded context
 * sở hữu nó — không KV, không Worker memory (invariant 12).
 *
 * ## Biên module
 *
 * Policy thời gian là hằng số export (test ghim); I/O (pool, entropy, đồng hồ)
 * do caller truyền. Không giữ state ở module scope.
 */

import { Pool } from 'pg';

/**
 * Cookie phiên của app `remote-cache-app` — prefix `__Host-` buộc Secure +
 * Path=/ + no domain (cùng luật `__Host-pact-broker-session`).
 */
export const SESSION_COOKIE_NAME = '__Host-remote-cache-app-session';

/** Cookie CSRF — đi kèm phiên cho double-submit ở mutation. */
export const CSRF_COOKIE_NAME = '__Host-remote-cache-app-csrf';

/** Header CSRF client gửi kèm state-changing request. */
export const CSRF_HEADER_NAME = 'x-ecoma-csrf';

/**
 * TTL idle của phiên (giây) — 12 giờ, cùng mốc của `account`/`backoffice`/
 * `pact-broker-app`: cùng chính sách vận hành cho một phiên làm việc.
 */
export const SESSION_IDLE_SECONDS = 12 * 3600;

/** TTL tuyệt đối của phiên (giây) — 7 ngày. Vượt mốc là login lại. */
export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600;

/** TTL cookie (giây) = absolute lifetime; idle enforce ở server. */
const SESSION_MAX_AGE = SESSION_ABSOLUTE_SECONDS;

/** Entropy của session ID / CSRF token — 256 bit. */
export const SESSION_ID_BYTES = 32;

/** Hàng phiên đọc từ DB. */
export interface RemoteCacheAppSessionRow {
  readonly id_hash: string;
  readonly account_sub: string;
  /** Access token hiện hành của phiên — KHÔNG BAO GIỜ vào log/cookie/response. */
  readonly access_token: string;
  readonly refresh_token: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

/** Sinh session ID 256-bit base64url — giá trị cookie; không log, không ghi DB. */
export function createSessionIdentifier(random?: Uint8Array): string {
  const bytes = random ?? crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES));
  return base64UrlEncode(bytes);
}

/** Sinh CSRF token 256-bit base64url. */
export function createCsrfToken(random?: Uint8Array): string {
  const bytes = random ?? crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES));
  return base64UrlEncode(bytes);
}

/** SHA-256 hex của session identifier — giá trị DUY NHẤT được ghi DB. */
export async function hashSessionIdentifier(identifier: string): Promise<string> {
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
 * Hai mốc hết hạn của phiên vừa tạo — idle (trượt sau này) + absolute (không
 * trượt, tính tại mốc tạo = `created_at` của hàng).
 */
export function sessionDeadlines(nowMs: number): {
  idleExpiresAtMs: number;
  absoluteExpiresAtMs: number;
} {
  return {
    idleExpiresAtMs: nowMs + SESSION_IDLE_SECONDS * 1000,
    absoluteExpiresAtMs: nowMs + SESSION_ABSOLUTE_SECONDS * 1000,
  };
}

/**
 * Kiểm hàng phiên còn sống — thuần, test được không cần DB.
 *
 * ⚠️ `expires_at` là mốc idle được trượt ở mỗi request hợp lệ; absolute
 * deadline = `created_at` + 7d, không bao giờ trượt. Phiên revoked (logout)
 * chết ngay. Skew app↔DB chỉ lệch TTL theo đúng lượng skew — sai là
 * fail-closed (chết sớm ⇒ login lại), không phải nhánh bảo mật.
 */
export function isSessionLive(
  row: {
    readonly expires_at: Date;
    readonly created_at: Date;
    readonly revoked_at: Date | null;
  },
  nowMs: number,
): boolean {
  if (row.revoked_at !== null) {
    return false;
  }
  if (nowMs >= row.expires_at.getTime()) {
    return false;
  }
  if (nowMs >= row.created_at.getTime() + SESSION_ABSOLUTE_SECONDS * 1000) {
    return false;
  }
  return true;
}

/** Đọc phiên theo hash — `null` khi không có hàng. */
export async function loadSessionByHash(
  pool: Pool,
  idHash: string,
): Promise<RemoteCacheAppSessionRow | null> {
  const result = await pool.query<RemoteCacheAppSessionRow>(
    `SELECT id_hash, account_sub, access_token, refresh_token, created_at,
            expires_at, revoked_at
       FROM remote_cache_app.bff_sessions
      WHERE id_hash = $1
      LIMIT 1`,
    [idHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Ghi hàng phiên mới — một lượt INSERT sau khi access token đã verify (hợp
 * đồng của caller: callback là đường duy nhất gọi hàm này).
 *
 * ⚠️ `created_at` để DB default (`now()`) — absolute deadline của
 * `isSessionLive` tính từ cột này: đồng hồ duy nhất được tin là đồng hồ của DB.
 */
export async function insertSession(
  pool: Pool,
  params: {
    idHash: string;
    accountSub: string;
    accessToken: string;
    refreshToken: string | null;
    /** Mốc idle expiry — trượt sau này ở `touchSession`. */
    expiresAt: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO remote_cache_app.bff_sessions
       (id_hash, account_sub, access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.idHash, params.accountSub, params.accessToken, params.refreshToken, params.expiresAt],
  );
}

/** Trượt idle expiry của phiên — gọi ở mỗi request hợp lệ (sliding). */
export async function touchSession(
  pool: Pool,
  idHash: string,
  idleExpiresAtMs: number,
): Promise<void> {
  await pool.query(
    `UPDATE remote_cache_app.bff_sessions
        SET expires_at = $2
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash, new Date(idleExpiresAtMs)],
  );
}

/**
 * Đánh dấu phiên revoked — logout qua đây; không DELETE (dòng phiên giữ lại
 * để điều tra).
 */
export async function revokeSessionByHash(pool: Pool, idHash: string): Promise<void> {
  await pool.query(
    `UPDATE remote_cache_app.bff_sessions
        SET revoked_at = now()
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash],
  );
}

/** Dựng chuỗi `Set-Cookie` của phiên — `__Host-`, HttpOnly, SameSite=Lax. */
export function sessionCookie(value: string): string {
  return (
    `${SESSION_COOKIE_NAME}=${value}; Max-Age=${SESSION_MAX_AGE}; Path=/; ` +
    'Secure; HttpOnly; SameSite=Lax'
  );
}

/** Xoá cookie phiên — expiry quá khứ, giữ nguyên thuộc tính khác. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** Cookie CSRF — không HttpOnly: client JS đọc và echo vào header. */
export function csrfCookie(csrfValue: string): string {
  return `${CSRF_COOKIE_NAME}=${csrfValue}; Max-Age=${SESSION_MAX_AGE}; Path=/; Secure; SameSite=Lax`;
}

/** Xoá cookie CSRF — luôn đi cùng `clearSessionCookie` ở logout. */
export function clearCsrfCookie(): string {
  return `${CSRF_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; SameSite=Lax`;
}

/**
 * Kiểm double-submit CSRF — so thường là đủ vì entropy 256-bit; timing-safe
 * chỉ có nghĩa với secret là dữ liệu người dùng chọn.
 */
export function csrfMatches(
  cookieValue: string | undefined,
  headerValue: string | undefined,
): boolean {
  if (cookieValue === undefined || headerValue === undefined) {
    return false;
  }
  if (cookieValue.length === 0 || cookieValue.length !== headerValue.length) {
    return false;
  }
  return cookieValue === headerValue;
}

// ============ pool ============

/** Tên binding Hyperdrive của app — trỏ tới `db-remote-cache-app` (invariant 1). */
export const HYPERDRIVE_BINDING_NAME = 'DB_REMOTE_CACHE_APP';

/**
 * Đọc binding Hyperdrive từ `env` của Worker — `null` khi vắng (Node local,
 * test dựng h3 thủ công). Shape-check hình dạng thật, không cast và tin.
 */
export function remoteCacheAppHyperdrive(env: unknown): { connectionString: string } | null {
  if (typeof env !== 'object' || env === null) {
    return null;
  }
  const binding = (env as Record<string, unknown>)[HYPERDRIVE_BINDING_NAME];
  if (typeof binding !== 'object' || binding === null) {
    return null;
  }
  const connectionString = (binding as { connectionString?: unknown }).connectionString;
  return typeof connectionString === 'string' && connectionString !== ''
    ? { connectionString }
    : null;
}

/** Khoá runtimeConfig private giữ connection string Node local (`NITRO_REMOTE_CACHE_APP_DATABASE_URL`). */
export const NODE_DATABASE_URL_CONFIG_KEY = 'remoteCacheAppDatabaseUrl';

/** Đọc connection string Node local từ runtimeConfig — `null` khi vắng/không có runtimeConfig. */
export function remoteCacheAppNodeDatabaseUrl(runtimeConfig: unknown): string | null {
  const url = (runtimeConfig as Record<string, unknown> | null)?.[NODE_DATABASE_URL_CONFIG_KEY];
  return typeof url === 'string' && url !== '' ? url : null;
}

/**
 * Dựng pool `pg` cho connection string đã chọn — giới hạn đúng luật Hyperdrive
 * (max 4, idle 10 phút, connect timeout 15s, không `ssl` — Hyperdrive đã chấm
 * dứt TLS upstream). Mỗi lần gọi tạo pool mới; caller chịu trách nhiệm `end()`.
 */
export function createRemoteCacheAppPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 600_000,
    connectionTimeoutMillis: 15_000,
  });
}
