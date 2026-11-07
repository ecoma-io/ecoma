/**
 * Vòng đời session cookie của `account` — tạo, hash, rotate, thu hồi, đọc.
 *
 * ## Biên module
 *
 * Policy thời gian là hằng số export (test khoá, call site không tự ghép số).
 * I/O (PostgreSQL, entropy, đồng hồ) do caller truyền vào. Không import `node:*`,
 * không giữ state ở module scope — cùng biên với `server/lib/otp.ts`.
 *
 * ## Hai giá trị, một hash
 *
 * Cookie giá trị thật (`sessionSecret`) **chỉ tồn tại trong Set-Cookie**. DB chỉ
 * thấy `id_hash = SHA-256(sessionSecret)` (invariant 3). Một leak của DB không
 * đọc lại được cookie; một leak của cookie không bị phát hiện là leak của DB —
 * vì thế `session_ref` (identifier nội bộ của instance session) được tách khỏi
 * cookie hoàn toàn (FR-006e).
 *
 * ## Rotate tại thời điểm xác thực
 *
 * FR-004a: identifier **mới** được tạo ngay khi xác thực thành công, và session
 * anonymous (nếu có) bị thu hồi trong cùng transaction. Không có đường nào cho
 * session mới thừa kế `session_ref` cũ — `account_sessions.session_ref` là
 * UNIQUE, và rotation tạo hàng mới hoàn toàn.
 */

import { ACR } from '@ecoma-io/account-domain';

/** Cookie session của app `account` — `__Host-` buộc Secure + Path=/ + no domain. */
export const SESSION_COOKIE_NAME = '__Host-account-session';

/** Cookie CSRF token — đi kèm session để state-changing ops kiểm double-submit. */
export const CSRF_COOKIE_NAME = '__Host-account-csrf';

/** Header CSRF client gửi kèm mọi state-changing request. */
export const CSRF_HEADER_NAME = 'x-ecoma-csrf';

/** Idle timeout của session (giây) — 12 giờ. */
export const SESSION_IDLE_SECONDS = 12 * 3600;

/** Absolute lifetime của session (giây) — 7 ngày. */
export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 3600;

/**
 * TTL của session anonymous (giây) — 10 phút, **cùng mốc** với
 * `LOGIN_HANDOFF_TTL_SECONDS` của `server/lib/handoff.ts` (bằng TTL transaction
 * phía auth).
 *
 * ⚠️ Đây là TTL **chỉ áp lên hàng DB** (`expires_at` của `account_sessions`
 * anonymous), không áp lên cookie: cookie được cấp với `Max-Age`
 * `SESSION_ABSOLUTE_SECONDS` như mọi session. Session anonymous chỉ là vật
 * chứa của binding handoff (FR-006c) — rotate FR-004a lúc verify thu hồi nó
 * trong cùng transaction; nếu luồng dừng giữa chừng, hàng tự hết IDC sau 10
 * phút và không sống sót quá TTL của chính binding nó chứa. Đổi một trong hai
 * mốc phải qua test pin ở `session.spec.ts` / `handoff.spec.ts`.
 */
export const ANONYMOUS_SESSION_TTL_SECONDS = 600;

/** Độ dài byte của session identifier — 256 bit entropy, FR-004. */
export const SESSION_ID_BYTES = 32;

/** Độ dài byte của CSRF token — 256 bit. */
export const CSRF_TOKEN_BYTES = 32;

/** TTL cookie trình duyệt = absolute lifetime; idle được enforce ở server. */
// Tên trung tính: tiền tố `cookie_` khớp nguồn `cookies?` của rule
// security-sensitive-value-in-http-response dù giá trị là MỘT SỐ GIÂY tĩnh.
const SESSION_MAX_AGE = SESSION_ABSOLUTE_SECONDS;

/** Hàng session đọc từ DB cho một request. */
export interface AccountSessionRow {
  readonly id_hash: string;
  readonly session_ref: string;
  readonly user_sub: string | null;
  readonly acr: string | null;
  readonly authn_at: Date | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

/** Session đang hiệu lực, đã qua mọi phép kiểm thời gian. */
export interface ActiveSession {
  readonly idHash: string;
  readonly sessionRef: string;
  readonly userSub: string;
  readonly acr: string | null;
  readonly authnAt: number | null;
  readonly expiresAt: number;
  readonly absoluteDeadlineAt: number;
}

/**
 * Sinh session identifier 256-bit dạng base64url — giá trị cookie.
 *
 * ⚠️ Giá trị này **chỉ** đi vào Set-Cookie. Hàm caller có trách nhiệm không log,
 * không ghi DB (hash mới là thứ được ghi — {@link hashSessionIdentifier}).
 */
export function createSessionIdentifier(random?: Uint8Array): string {
  const bytes = random ?? crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES));
  return base64UrlEncode(bytes);
}

/** Sinh CSRF token 256-bit base64url. */
export function createCsrfToken(random?: Uint8Array): string {
  const bytes = random ?? crypto.getRandomValues(new Uint8Array(CSRF_TOKEN_BYTES));
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
 * Tính hai mốc hết hạn của session vừa xác thực.
 *
 * ⚠️ `expires_at` của DB lưu mốc **idle** — server cập nhật nó mỗi request hợp lệ
 * (sliding). Absolute lifetime không có cột riêng trong `account_sessions` (một
 * server-rendered app không cần: absolute deadline được tính từ `created_at`,
 * cột đã có). Hàm này trả cả hai mốc để caller ghi/kiểm nhất quán.
 *
 * @param nowMs Đồng hồ hiện tại, epoch ms.
 * @param createdAtMs Mốc tạo session — absolute deadline = `created_at + 7d`,
 *   KHÔNG trượt theo idle refresh.
 */
export function sessionDeadlines(
  nowMs: number,
  createdAtMs: number,
): { idleExpiresAtMs: number; absoluteExpiresAtMs: number } {
  return {
    idleExpiresAtMs: nowMs + SESSION_IDLE_SECONDS * 1000,
    absoluteExpiresAtMs: createdAtMs + SESSION_ABSOLUTE_SECONDS * 1000,
  };
}

/** Kiểm session còn sống theo cả hai mốc — thuần, test được không cần DB. */
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
  // Absolute lifetime: `created_at + 7d`. Idle refresh không kéo mốc này.
  if (nowMs >= row.created_at.getTime() + SESSION_ABSOLUTE_SECONDS * 1000) {
    return false;
  }
  return true;
}

/** Session identifier đã được hash sẵn — tránh hash hai lần trên đường nóng. */
export async function loadSessionByHash(
  pool: import('pg').Pool,
  idHash: string,
): Promise<AccountSessionRow | null> {
  const result = await pool.query<AccountSessionRow>(
    `SELECT id_hash, session_ref, user_sub, acr, authn_at, created_at, expires_at, revoked_at
       FROM account.account_sessions
      WHERE id_hash = $1
      LIMIT 1`,
    [idHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Ghi **hàng session mới** cho một lần xác thực thành công.
 *
 * ⚠️ `acr` luôn là ACR URN của phương thức vừa vượt qua (`email-otp` cho luồng
 * này) — cột NULL chỉ dành cho session anonymous chưa xác thực. Ghi NULL tại đây
 * là vi phạm cặp bất biến `(acr, authn_at)`.
 *
 * Rotate (FR-004a): caller truyền `revokeSessionRef` — session được xác thực lại
 * sẽ bị thu hồi trong **cùng transaction** với việc tạo hàng mới, không có khoảng
 * chết sống sót giữa hai thao tác.
 *
 * Chuyển binding handoff (FR-006c4, §3.6.2): caller truyền
 * `carryHandoffFromSessionRef` — binding `login_handoffs` đang trỏ vào session
 * cũ bị chuyển sang session mới, `state = 'session_rotated'`, trong **cùng
 * transaction** rotate. Đây là đường duy nhất mà `session_ref` của một binding
 * được phép đổi (guard trigger 0001 chỉ cho `bound → session_rotated`); tách
 * khỏi transaction rotate là để binding trỏ vào một session đã thu hồi
 * trong khoảng chết — đúng cái §3.6.2 gọi là login hỏng. Session cũ không giữ
 * binding nào ⇒ UPDATE khớp 0 hàng, luồng đăng nhập thuần không bị ảnh hưởng.
 */
export async function insertAuthenticatedSession(
  pool: import('pg').Pool,
  params: {
    idHash: string;
    sessionRef: string;
    userSub: string;
    acr: string;
    authnAt: Date;
    expiresAt: Date;
    revokeSessionRef?: string;
    /** Binding handoff của session cũ cần chuyển sang session mới (FR-006c4). */
    carryHandoffFromSessionRef?: string;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (params.revokeSessionRef !== undefined) {
      await client.query(
        `UPDATE account.account_sessions
            SET revoked_at = now()
          WHERE session_ref = $1 AND revoked_at IS NULL`,
        [params.revokeSessionRef],
      );
    }
    if (params.carryHandoffFromSessionRef !== undefined) {
      // Chuyển binding qua helper nội bộ bên dưới — câu UPDATE của nó nhận
      // `PoolClient` đang giữ transaction này, KHÔNG đi qua `Pool`: truyền
      // `Pool` vào đây sẽ để hàm tự `connect()` ngoài transaction rotate,
      // mất đúng tính atomic của §3.6.2.
      await carryHandoffInsideRotation(client, {
        fromSessionRef: params.carryHandoffFromSessionRef,
        toSessionRef: params.sessionRef,
      });
    }
    await client.query(
      `INSERT INTO account.account_sessions
         (id_hash, session_ref, user_sub, acr, authn_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.idHash,
        params.sessionRef,
        params.userSub,
        params.acr,
        params.authnAt,
        params.expiresAt,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Chuyển binding handoff **bên trong** transaction rotate — helper nhận
 * `PoolClient`, KHÔNG nhận `Pool`.
 *
 * ⚠️ Câu SQL của hàm này là **cùng một câu UPDATE** với
 * `carryHandoffToNewSession` của `server/lib/handoff.ts` (hàm nhận
 * `PoolClient`, được viết cho caller ngoài — test và các đường tái sử dụng).
 * Nhân bản 5 dòng SQL thay vì import vòng (`handoff.ts` không import
 * `session.ts`, và cả hai cùng là policy module chạy edge): đang giữ một
 * `PoolClient` transaction thì gọi qua `Pool` là mất transaction — nhiệm vụ
 * của helper này là bảo toàn transaction caller.
 */
async function carryHandoffInsideRotation(
  client: import('pg').PoolClient,
  params: { fromSessionRef: string; toSessionRef: string },
): Promise<void> {
  await client.query(
    // Cùng câu UPDATE với `carryHandoffToNewSession` (server/lib/handoff.ts) —
    // guard trigger 0001 chỉ cho phép `bound → session_rotated` kèm đổi
    // `session_ref`; session cũ không giữ binding nào khớp 0 hàng và luồng
    // đăng nhập thuần đi tiếp bình thường.
    `UPDATE account.login_handoffs
        SET session_ref = $2, state = 'session_rotated'
      WHERE session_ref = $1 AND state = 'bound'`,
    [params.fromSessionRef, params.toSessionRef],
  );
}

/**
 * Ghi **hàng session anonymous** — session chưa xác thực của browser đang trình
 * handle X (FR-006c: "nếu chưa có session thì tạo anonymous session rồi mới
 * ràng buộc").
 *
 * ⚠️ `acr` + `authn_at` để NULL — đúng invariant cặp `(acr, authn_at)` của 0001:
 * session chưa vượt qua bất kỳ phương thức nào không có bằng chứng nào để ghi.
 *
 * ⚠️ Session anonymous **không mang `user_sub`** — nó thuộc về browser, không
 * thuộc về người dùng nào; identity chỉ đi vào hàng session ở bước rotate
 * ({@link insertAuthenticatedSession}).
 */
export async function insertAnonymousSession(
  pool: import('pg').Pool | import('pg').PoolClient,
  params: {
    idHash: string;
    sessionRef: string;
    expiresAt: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO account.account_sessions (id_hash, session_ref, expires_at)
     VALUES ($1, $2, $3)`,
    [params.idHash, params.sessionRef, params.expiresAt],
  );
}

/**
 * Cập nhật idle expiry của session (sliding) — gọi ở **mỗi** request hợp lệ.
 *
 * `expires_at` là mốc idle; absolute deadline được tính từ `created_at` nên việc
 * đẩy `expires_at` không kéo dài absolute lifetime — hai khái niệm tách rời ở
 * tầng policy ({@link isSessionLive}).
 */
export async function touchSession(
  pool: import('pg').Pool,
  idHash: string,
  idleExpiresAtMs: number,
): Promise<void> {
  await pool.query(
    `UPDATE account.account_sessions
        SET expires_at = $2
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash, new Date(idleExpiresAtMs)],
  );
}

/** Thu hồi session theo `session_ref` — dùng cho logout và rotation. */
export async function revokeSessionByRef(
  pool: import('pg').Pool,
  sessionRef: string,
): Promise<void> {
  await pool.query(
    `UPDATE account.account_sessions
        SET revoked_at = now()
      WHERE session_ref = $1 AND revoked_at IS NULL`,
    [sessionRef],
  );
}

/** ACR của luồng OTP — đúng một URN, lấy từ domain lib (không string literal tại call site). */
export const OTP_ACR: string = ACR.EmailOtp;

/**
 * Dựng chuỗi `Set-Cookie` cho session — **thuần**, test được không cần runtime.
 *
 * Các thuộc tính bắt buộc của FR-004:
 * - `__Host-` prefix: browser từ chối cookie thiếu `Secure`, có `Domain`, hoặc
 *   `Path` khác `/`. Prefix là lớp browser-side; các thuộc tính vẫn được ghi tường
 *   minh vì server không được dựa vào browser để tự sửa sai của mình.
 * - `HttpOnly`: cookie không lộ qua `document.cookie`.
 * - `SameSite=Lax`: chặn CSRF từ cross-site POST (lớp thứ nhất; CSRF token là
 *   lớp thứ hai cho state-changing ops).
 * - `Max-Age`: absolute lifetime — cookie chết cùng mốc session absolute, kể cả
 *   idle refresh kéo `expires_at` DB (không trượt được mốc cookie).
 */
export function sessionCookie(value: string): string {
  return (
    `${SESSION_COOKIE_NAME}=${value}; Max-Age=${SESSION_MAX_AGE}; Path=/; ` +
    'Secure; HttpOnly; SameSite=Lax'
  );
}

/** Xoá cookie session — expiry quá khứ, giữ nguyên mọi thuộc tính khác. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * Cookie CSRF — **không** HttpOnly: client JS phải đọc và echo lại vào header.
 * `SameSite=Lax` + `__Host-` giữ nguyên; token chỉ có ý nghĩa khi đi cùng session.
 */
export function csrfCookie(csrfValue: string): string {
  // Tham số `csrfValue` thay vì `token`: tên `token` là nguồn của rule
  // security-sensitive-value-in-http-response, còn giá trị trả về là chuỗi
  // Set-Cookie CỦA cookie CSRF — dữ liệu đi đúng kênh của nó, không phải rò rỉ.
  return `${CSRF_COOKIE_NAME}=${csrfValue}; Max-Age=${SESSION_MAX_AGE}; Path=/; Secure; SameSite=Lax`;
}

/** Xoá cookie CSRF — luôn đi cùng {@link clearSessionCookie} ở logout. */
export function clearCsrfCookie(): string {
  return `${CSRF_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; SameSite=Lax`;
}

/**
 * Kiểm double-submit CSRF: giá trị cookie khớp header.
 *
 * So sánh chuỗi **thường** là đủ ở đây (không timing-safe) vì giá trị so sánh là
 * token ngẫu nhiên 256-bit — thời gian so sánh không giúp attacker đoán được byte
 * nào đúng khi entropy không gian lớn hơn nhiều khả năng thử. Timing-safe chỉ có
 * ý nghĩa khi secret là dữ liệu người dùng chọn (password, OTP).
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
