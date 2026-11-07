/**
 * Store phiên BFF của `backoffice` — bảng `backoffice.bff_sessions` trong
 * `db-backoffice`.
 *
 * ## Vì sao phiên nằm ở PostgreSQL, không ở KV/Worker memory
 *
 * Invariant 26 (`docs/architecture/01-architecture.md` §9): ephemeral protocol
 * state — gồm cả state/PKCE challenge — nằm ở database của bounded context
 * sở hữu nó, single-use, có TTL; **không** ở KV, Queue hay Worker memory.
 * Phiên BFF của `backoffice` là đúng loại state đó: nó mang token set (dữ
 * liệu có nghĩa nếu mất), và mất isolate không được làm một phiên sống biến
 * thành phiên chết (hay ngược lại).
 *
 * ## Hai giá trị, một hash — cùng pattern `account_sessions`
 *
 * Cookie chỉ mang session ID nguyên vẹn (entropy 256-bit, base64url); DB chỉ
 * thấy `id_hash = SHA-256(id)` (`server/lib/session.ts` của `account` — cùng
 * một lập luận: leak DB không đọc lại được cookie, leak cookie không được
 * trùng khoá tra cứu DB). Token set nằm **chỉ** ở DB — cookie không bao giờ
 * mang token (ADR-0012 §1: token không về browser).
 *
 * ## Rotate refresh ⇒ destroy phiên
 *
 * `auth` rotate refresh token ở mỗi lần dùng, và một refresh **đã rotate**
 * xuất hiện lại ⇒ provider thu hồi cả grant (`invalid_grant`). Handler refresh
 * bắt đúng tín hiệu đó và **xoá phiên** — không retry (ADR-0012 §3).
 *
 * ## Biên module
 *
 * Policy thời gian là hằng số export (test ghim); I/O (pool, entropy, đồng
 * hồ) do caller truyền. Không giữ state ở module scope — cùng biên với
 * `apps/account/server/lib/session.ts`.
 */

import type { Pool } from 'pg';

/**
 * Cookie phiên của app `backoffice` — prefix `__Host-` buộc Secure + Path=/
 * + no domain (cùng luật `__Host-account-session`).
 */
export const SESSION_COOKIE_NAME = '__Host-backoffice-session';

/**
 * Cookie CSRF — đi kèm phiên cho double-submit ở mutation (J4); route logout
 * kiểm nó theo cùng luật `x-ecoma-csrf` của `account`.
 */
export const CSRF_COOKIE_NAME = '__Host-backoffice-csrf';

/** Header CSRF client gửi kèm state-changing request. */
export const CSRF_HEADER_NAME = 'x-ecoma-csrf';

/**
 * TTL idle của phiên (giây) — 12 giờ, cùng mốc `SESSION_IDLE_SECONDS` của
 * `account`: hai phiên là hai vòng đời độc lập nhưng cùng chính sách vận hành
 * cho một nhân viên làm việc cả ngày.
 */
export const SESSION_IDLE_SECONDS = 12 * 3600;

/**
 * TTL tuyệt đối của phiên (giây) — 7 ngày, cùng mốc absolute của `account`.
 * Vượt mốc này là login lại — không có phiên nào sống vô hạn vì refresh token
 * (30 ngày) nhưng phiên thì không.
 */
export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600;

/** TTL cookie (giây) = absolute lifetime; idle enforce ở server. */
const SESSION_MAX_AGE = SESSION_ABSOLUTE_SECONDS;

/** Entropy của session ID / CSRF token — 256 bit, cùng mốc `account`. */
export const SESSION_ID_BYTES = 32;

/** Hàng phiên đọc từ DB. */
export interface BackofficeSessionRow {
  readonly id_hash: string;
  readonly account_sub: string;
  /** Access token hiện hành của phiên — **không bao giờ** vào log/cookie. */
  readonly access_token: string;
  readonly refresh_token: string | null;
  /** `iat` của ID token — mốc tuyệt đối của `auth_time` đã verify. */
  readonly auth_time: Date | null;
  /** ACR của lần xác thực — chỉ để audit, không là điều kiện allow (ADR-0012 §3). */
  readonly acr: string | null;
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

/** SHA-256 hex của session identifier — giá trị **duy nhất** được ghi DB. */
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
 * trượt). Cùng ngữ nghĩa `sessionDeadlines` của `account`, khác ở chỗ absolute
 * được tính tại **mốc tạo** (`created_at` của hàng là mốc này) — caller ghi cả
 * hai cột cùng một lượt `INSERT`, nên truyền một mốc `nowMs` là đủ.
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
 * ⚠️ `expires_at` là mốc idle được trượt ở **mỗi** request hợp lệ
 * ({@link touchSession}); absolute deadline = `created_at + 7d`, không bao giờ
 * trượt. Phiên được đánh dấu revoke (logout, refresh reuse) chết ngay.
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
): Promise<BackofficeSessionRow | null> {
  const result = await pool.query<BackofficeSessionRow>(
    `SELECT id_hash, account_sub, access_token, refresh_token, auth_time,
            acr, created_at, expires_at, revoked_at
       FROM backoffice.bff_sessions
      WHERE id_hash = $1
      LIMIT 1`,
    [idHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Ghi hàng phiên mới — một lượt `INSERT` sau khi access token đã verify
 * (hợp đồng của caller: callback là đường duy nhất gọi hàm này).
 *
 * ⚠️ `created_at` để DB default (`now()`) — absolute deadline của
 * {@link isSessionLive} tính từ **cột này**, không từ tham số nào của app:
 * đồng hồ duy nhất được tin là đồng hồ của DB (clock skew giữa isolate và DB
 * không được làm phiên sống ngắn/dài hơn chính sách).
 */
export async function insertSession(
  pool: Pool,
  params: {
    idHash: string;
    accountSub: string;
    accessToken: string;
    refreshToken: string | null;
    authTime: Date | null;
    acr: string | null;
    /** Mốc idle expiry — trượt sau này ở {@link touchSession}. */
    expiresAt: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO backoffice.bff_sessions
       (id_hash, account_sub, access_token, refresh_token, auth_time, acr, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.idHash,
      params.accountSub,
      params.accessToken,
      params.refreshToken,
      params.authTime,
      params.acr,
      params.expiresAt,
    ],
  );
}

/**
 * Trượt idle expiry của phiên — gọi ở **mỗi** request hợp lệ (sliding);
 * absolute deadline không đổi vì tính từ `created_at`.
 */
export async function touchSession(
  pool: Pool,
  idHash: string,
  idleExpiresAtMs: number,
): Promise<void> {
  await pool.query(
    `UPDATE backoffice.bff_sessions
        SET expires_at = $2
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash, new Date(idleExpiresAtMs)],
  );
}

/**
 * Đánh dấu phiên revoked — logout và refresh-reuse đều qua đây; không DELETE
 * (dòng phiên giữ lại để điều tra, cùng nguyên tắc "không xoá vật lý" §4.6).
 */
export async function revokeSessionByHash(pool: Pool, idHash: string): Promise<void> {
  await pool.query(
    `UPDATE backoffice.bff_sessions
        SET revoked_at = now()
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash],
  );
}

/**
 * Chuyển **access token** của phiên sau khi refresh thành công — chỉ cột này
 * được đổi, mọi cột khác bất biến sau `INSERT`.
 *
 * ⚠️ Access token mới đã được verify trước khi gọi hàm này (đường refresh
 * không bao giờ ghi token chưa qua phép verify vào phiên) — caller là handler
 * refresh, và hợp đồng đó được ghim bằng test.
 */
export async function replaceAccessToken(
  pool: Pool,
  idHash: string,
  newAccessToken: string,
): Promise<void> {
  await pool.query(
    `UPDATE backoffice.bff_sessions
        SET access_token = $2
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash, newAccessToken],
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

/** Xoá cookie CSRF — luôn đi cùng {@link clearSessionCookie} ở logout. */
export function clearCsrfCookie(): string {
  return `${CSRF_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; SameSite=Lax`;
}

/**
 * Kiểm double-submit CSRF — cùng ngữ nghĩa `csrfMatches` của `account`: so
 * thường là đủ vì entropy 256-bit; timing-safe chỉ có nghĩa với secret là dữ
 * liệu người dùng chọn.
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
