/**
 * Truy vấn và validate của data domain v1 — `user_profiles`, `user_preferences`,
 * `notification_preferences` (0008) và `email_addresses` (0005).
 *
 * ## Biên module
 *
 * Validation hình dạng là **hàm thuần** (test được không cần DB); persistence
 * nhận `Pool` do caller truyền vào — cùng biên với `server/lib/otp.ts` và
 * `server/utils/db.ts` (runtime:edge cấm node-local state, module không đọc env,
 * không giữ state).
 *
 * ## Luật ownership: mọi truy vấn neo theo `user_sub` của session
 *
 * Subject **luôn** lấy từ session row (`requireAuthedSession`), không bao giờ từ
 * client (SR-009). Các hàm persistence ở đây nhận `userSub` như tham số, và mọi
 * UPDATE/DELETE đều lọc theo `user_sub` — một id/email của user khác không bao
 * giờ khớp hàng nào của caller. Route chuyển "0 hàng bị ảnh hưởng" thành `404`,
 * không xác nhận sự tồn tại của record cho người không sở hữu (404-not-403).
 */

import { normalizeEmailAddress } from './otp';

// -------------------------------------------------------------------------------------------
// Validation — thuần, test không cần DB
// -------------------------------------------------------------------------------------------

/** Locale allowlist đóng (FR-008a) — khớp CHECK `user_preferences_locale_check`. */
export const LOCALE_ALLOWLIST: readonly string[] = ['en', 'vi'];

/** Color-mode enum đóng — khớp CHECK `user_preferences_color_mode_check`. */
export const COLOR_MODE_ALLOWLIST: readonly string[] = ['system', 'light', 'dark'];

/** Trần độ dài của display_name — chống payload lớn, không phải ràng buộc sản phẩm. */
export const DISPLAY_NAME_MAX_LENGTH = 200;

/** Trần độ dài của avatar URL — cùng mục đích, cùng hình dạng với display_name. */
export const AVATAR_URL_MAX_LENGTH = 2_048;

/**
 * Kiểm timezone theo IANA tz database (FR-008b).
 *
 * ⚠️ **`new Intl.DateTimeFormat`, không phải `Intl.supportedValuesOf('timeZone')`.**
 * `supportedValuesOf` chỉ trả **primary CLDR IDs** của icu data đang chạy — trên
 * nhiều bản build Node, danh sách đó thiếu cả `Asia/Ho_Chi_Minh` (primary ID chuẩn
 * của tzdata, đã đo được trả `false` trên Node 24 full-ICU với 418 zone) vì ICU
 * nội bộ dùng tên zone khác. `DateTimeFormat` chấp nhận **cả** alias (`Asia/Saigon`,
 * `Zulu`, `Etc/GMT+8`) lẫn primary ID, nên nó là phép kiểm "tz database có biết tên
 * này không" đúng nghĩa; danh sách đóng của `supportedValuesOf` thì từ chối oan
 * tên hợp lệ. Đã đo được `Mars/Phobos`, chuỗi rỗng, chuỗi injection và offset dạng
 * text đều bị `DateTimeFormat` từ chối.
 *
 * Biên đã biết (chấp nhận v1): một chuỗi rác đủ giống zone vẫn có thể lọt qua
 * phép format — kiểm này là lớp validate hình dạng, không phải allowlist đóng.
 */
export function isValidTimeZone(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 64) {
    return false;
  }
  try {
    // Mục đích là kiểm ném của constructor; formatter tạo ra được dùng ngay qua
    // resolvedOptions nên không vi phạm no-new.
    const probe = new Intl.DateTimeFormat('en', { timeZone: candidate });
    return probe.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

/** Kết quả validate PATCH preferences — chỉ có field được gửi, hoặc `false` khi sai hình dạng. */
export interface PreferencesPatch {
  readonly locale?: string;
  readonly timezone?: string;
  readonly colorMode?: string;
}

/**
 * Validate body PATCH preferences (FR-008a/b/d/e).
 *
 * ⚠️ **Bỏ qua mọi `sub` từ client** (FR-008d, SR-009): validator không đọc trường
 * `sub` nào — body chứa `sub` của user khác vẫn được validate theo các trường còn
 * lại, và giá trị đó không bao giờ chạm query. Object rỗng là hợp lệ (PATCH mọi
 * trường không gửi = no-op thành công, cùng hình thức partial-update của FR-008e).
 *
 * Sai hình dạng (kiểu sai, giá trị ngoài allowlist, timezone lạ) → `false` —
 * route chuyển thành `400`, giữ nguyên giá trị cũ (FR-008a: reject, không fallback).
 */
export function parsePreferencesPatch(value: unknown): PreferencesPatch | false {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const patch: { locale?: string; timezone?: string; colorMode?: string } = {};

  const locale = (value as { locale?: unknown }).locale;
  if (locale !== undefined) {
    if (typeof locale !== 'string' || !LOCALE_ALLOWLIST.includes(locale)) {
      return false;
    }
    patch.locale = locale;
  }

  const timezone = (value as { timezone?: unknown }).timezone;
  if (timezone !== undefined) {
    if (!isValidTimeZone(timezone)) {
      return false;
    }
    patch.timezone = timezone;
  }

  const colorMode = (value as { colorMode?: unknown }).colorMode;
  if (colorMode !== undefined) {
    if (typeof colorMode !== 'string' || !COLOR_MODE_ALLOWLIST.includes(colorMode)) {
      return false;
    }
    patch.colorMode = colorMode;
  }

  return patch;
}

/**
 * Validate email về hình dạng tối thiểu — **cùng luật** với `isChallengeBody`
 * (`challenge.post.ts`): không phải RFC 5321 đầy đủ, chỉ loại chuỗi rỗng, quá
 * dài (> 254 theo RFC 5321) và thiếu `@`. Chi tiết hơn là việc của normalize +
 * hash + ràng buộc DB, và đường anti-enumeration không phụ thuộc hình dạng chặt.
 */
export function isPlausibleEmail(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 3 && value.length <= 254 && value.includes('@')
  );
}

// -------------------------------------------------------------------------------------------
// Hiển thị email — danh sách email của chính caller
// -------------------------------------------------------------------------------------------

/**
 * Hàng email cho response của `GET /api/emails` — **không** chứa
 * `address_hash` (dẫn xuất không đảo ngược được nhưng không phải dữ liệu hiển
 * thị) và `address_normalized` (dạng nội bộ, COMMENT của 0005 nói rõ).
 */
export interface AccountEmailView {
  readonly id: string;
  /** Địa chỉ dạng hiển thị — xem {@link maskEmail}. */
  readonly address: string;
  readonly status: 'pending' | 'verified' | 'revoked';
  /** Địa chỉ `verified` đang dùng đăng nhập — không xoá được nếu là cờ cuối (FR-002). */
  readonly isSignIn: boolean;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
}

/**
 * Che một phần local-part của địa chỉ để **hiển thị** — user vẫn nhận ra email
 * của mình, trong khi dạng đầy đủ không nằm trong payload JSON của response.
 *
 * ## Vì sao mask mà không trả nguyên văn
 *
 * `address_normalized` là **dạng nội bộ** (COMMENT của 0005), và route này phục
 * vụ chính chủ qua session cookie — nhưng contract của một response cá nhân hoá
 * vẫn phải tối thiểu: body qua log gateway, extension hay proxy debug là body
 * chứa email trần. Mask giữ đủ thông tin để UI render danh sách (đúng mục đích
 * của FR-009) mà không phát tán địa chỉ trần ngoài các route cần nó (challenge
 * của luồng đăng nhập, nơi user tự gõ). Quyết định v1 — reviewer có quyền đổi.
 *
 * Local-part ≤ 2 ký tự giữ nguyên; ký tự đầu giữ, các ký tự giữa thay bằng
 * `*`, domain giữ nguyên (domain không phải dữ liệu định danh cá nhân cùng mức).
 */
export function maskEmail(addressNormalized: string): string {
  const atIndex = addressNormalized.lastIndexOf('@');
  if (atIndex <= 0) {
    // Không tới được với email đã qua `isPlausibleEmail`, nhưng một hàm mask
    // an toàn với mọi đầu vào thì không ném — trả dạng đã cắt local-part.
    return `*${addressNormalized.slice(Math.max(0, atIndex))}`;
  }
  const local = addressNormalized.slice(0, atIndex);
  const domain = addressNormalized.slice(atIndex);
  if (local.length <= 2) {
    return `${local}${domain}`;
  }
  return `${local[0] ?? '*'}${'*'.repeat(local.length - 1)}${domain}`;
}

// -------------------------------------------------------------------------------------------
// Persistence — `user_profiles`
// -------------------------------------------------------------------------------------------

/** Hàng profile cho response — các cột audit nội bộ không đi ra ngoài. */
export interface AccountProfileRow {
  readonly display_name: string | null;
  readonly avatar_url: string | null;
}

/**
 * Đọc profile của một sub, hoặc `null` khi chưa có hàng (chưa nhập lần nào —
 * 1:1 row chỉ xuất hiện ở lần PATCH đầu).
 */
export async function selectProfile(
  pool: import('pg').Pool,
  userSub: string,
): Promise<AccountProfileRow | null> {
  const result = await pool.query<{ display_name: string | null; avatar_url: string | null }>(
    `SELECT display_name, avatar_url
       FROM account.user_profiles
      WHERE user_sub = $1`,
    [userSub],
  );
  return result.rows[0] ?? null;
}

/**
 * Upsert 1:1 profile của một sub — hàng được tạo ở lần PATCH đầu (FR-008e không
 * áp cho profile: display_name/avatar_url đều nullable, NULL = chưa nhập).
 *
 * `updated_at` do `now()` của DB đặt — một đồng hồ duy nhất cho mọi lần ghi của
 * bảng này; caller không tự tính mốc nào.
 */
export async function upsertProfile(
  pool: import('pg').Pool,
  params: {
    readonly userSub: string;
    readonly displayName: string | null;
    readonly avatarUrl: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO account.user_profiles (user_sub, display_name, avatar_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_sub) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url,
           updated_at = now()`,
    [params.userSub, params.displayName, params.avatarUrl],
  );
}

// -------------------------------------------------------------------------------------------
// Persistence — `user_preferences`
// -------------------------------------------------------------------------------------------

/** Hàng preference cho response. */
export interface AccountPreferencesRow {
  readonly locale: string;
  readonly timezone: string;
  readonly color_mode: string;
}

/**
 * Đọc preference của một sub, hoặc `null` khi chưa có hàng.
 *
 * ⚠️ **Không default ở đường đọc.** FR-008c: default áp **một lần lúc tạo
 * account** — đường ghi khởi tạo, không phải đường đọc. Trả `null` để route
 * quyết định (v1: route tự insert hàng default khi caller PATCH lần đầu; GET
 * trả `404`-styled shape `defaults` để UI hiển thị trạng thái chưa cấu hình —
 * xem JSDoc route). Default hoá im lặng ở đây là fallback đúng cái FR-008a cấm.
 */
export async function selectPreferences(
  pool: import('pg').Pool,
  userSub: string,
): Promise<AccountPreferencesRow | null> {
  const result = await pool.query<{
    locale: string;
    timezone: string;
    color_mode: string;
  }>(
    `SELECT locale, timezone, color_mode
       FROM account.user_preferences
      WHERE user_sub = $1`,
    [userSub],
  );
  return result.rows[0] ?? null;
}

/**
 * Ghi preference theo **partial update** (FR-008e): chỉ cột được gửi được SET.
 *
 * Dùng đúng một câu `INSERT … ON CONFLICT DO UPDATE` với `COALESCE`: cột không
 * gửi giữ giá trị hiện có (không reset về default), hàng được tạo ở lần PATCH
 * đầu với các cột còn thiếu lấy giá trị DB default (timezone `Asia/Ho_Chi_Minh`,
 * color_mode `system` — cùng default §3.3).
 *
 * ⚠️ **`locale` là tham số bắt buộc theo hình thức** (`locale: string`, không
 * phải `locale?: string`): cột `locale` của 0008 là NOT NULL **không** DB
 * default theo chủ ý (FR-008a cấm fallback im lặng), nên một INSERT cần một
 * giá trị. Route phải **require `locale` khi caller chưa có hàng** — kiểm tra
 * `selectPreferences` trước, trả `400 locale_required` nếu patch lần đầu thiếu
 * trường đó. Việc route đọc-then-write ở đây chấp nhận được vì v1 chỉ có một
 * account (sub) mỗi user và PATCH của cùng sub tuần tự hoá trên PRIMARY KEY.
 *
 * Câu này là nguyên tử: hai PATCH song song không ghi đè trường của nhau ngoài
 * các trường chúng thực sự gửi.
 */
export async function updatePreferencesPartial(
  pool: import('pg').Pool,
  params: {
    readonly userSub: string;
    readonly locale: string;
    readonly timezone?: string;
    readonly colorMode?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO account.user_preferences (user_sub, locale, timezone, color_mode)
     VALUES ($1,
             $2,
             COALESCE($3, 'Asia/Ho_Chi_Minh'),
             COALESCE($4, 'system'))
     ON CONFLICT (user_sub) DO UPDATE
       SET locale = $2,
           timezone = COALESCE($3, user_preferences.timezone),
           color_mode = COALESCE($4, user_preferences.color_mode),
           updated_at = now()`,
    [params.userSub, params.locale, params.timezone ?? null, params.colorMode ?? null],
  );
}

// -------------------------------------------------------------------------------------------
// Persistence — `email_addresses` (đường quản lý email của chính chủ)
// -------------------------------------------------------------------------------------------

/** Hàng email thô đọc từ DB — đầu vào của {@link toEmailView}. */
export interface EmailAddressRow {
  readonly id: string;
  readonly address_normalized: string;
  readonly status: string;
  readonly is_sign_in: boolean;
  readonly created_at: Date;
  readonly verified_at: Date | null;
}

/** Danh sách email của một sub, mới nhất trước. */
export async function listEmails(
  pool: import('pg').Pool,
  userSub: string,
): Promise<readonly EmailAddressRow[]> {
  const result = await pool.query<EmailAddressRow>(
    `SELECT id, address_normalized, status, is_sign_in, created_at, verified_at
       FROM account.email_addresses
      WHERE user_sub = $1
      ORDER BY created_at DESC`,
    [userSub],
  );
  return result.rows;
}

/** Email của một sub theo id — `null` khi id không thuộc về caller (→ 404). */
export async function findEmailById(
  pool: import('pg').Pool,
  params: { readonly userSub: string; readonly id: string },
): Promise<EmailAddressRow | null> {
  const result = await pool.query<EmailAddressRow>(
    `SELECT id, address_normalized, status, is_sign_in, created_at, verified_at
       FROM account.email_addresses
      WHERE id = $1 AND user_sub = $2`,
    [params.id, params.userSub],
  );
  return result.rows[0] ?? null;
}

/**
 * Đếm email `verified` của một sub. FR-002: ≥ 1 verified mới đăng nhập được,
 * nên DELETE của email verified cuối cùng bị chặn ở route.
 */
export async function countVerifiedEmails(
  pool: import('pg').Pool,
  userSub: string,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM account.email_addresses
      WHERE user_sub = $1 AND status = 'verified'`,
    [userSub],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Địa chỉ có **thuộc về một sub nào đó** hay không — tra cứu theo `address_hash`
 * (cùng khoá với luồng OTP).
 *
 * ⚠️ Hàm này phục vụ **anti-enumeration** của POST /api/emails: kết quả không
 * bao giờ đi vào response. Hai account cùng thêm một địa chỉ → địa chỉ thứ hai
 * nhận **cùng response thành công** như bình thường, chỉ là không có hàng mới
 * và không có mail đi ra (xem JSDoc route). Khi hàng verified hiện tại bị revoke
 * hoặc bị xoá, địa chỉ claim lại được — đúng semantic partial UNIQUE của 0005.
 */
export async function findOwnedEmailByHash(
  pool: import('pg').Pool,
  params: { readonly addressHash: string; readonly userSub: string },
): Promise<EmailAddressRow | null> {
  const result = await pool.query<EmailAddressRow>(
    `SELECT id, address_normalized, status, is_sign_in, created_at, verified_at
       FROM account.email_addresses
      WHERE address_hash = $1 AND user_sub = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [params.addressHash, params.userSub],
  );
  return result.rows[0] ?? null;
}

/** Địa chỉ có hàng `verified` (thuộc sub bất kỳ) — khoá ownership của email đã xác minh. */
export async function findVerifiedEmailOwner(
  pool: import('pg').Pool,
  addressHash: string,
): Promise<{ readonly userSub: string } | null> {
  const result = await pool.query<{ user_sub: string }>(
    `SELECT user_sub
       FROM account.email_addresses
      WHERE address_hash = $1 AND status = 'verified'
      LIMIT 1`,
    [addressHash],
  );
  const row = result.rows[0];
  return row === undefined ? null : { userSub: row.user_sub };
}

/**
 * Chuyển hàng DB thành view hiển thị — địa chỉ qua {@link maskEmail}, mốc thời
 * gian qua ISO string để response là JSON thuần.
 */
export function toEmailView(row: EmailAddressRow): AccountEmailView {
  return {
    id: row.id,
    address: maskEmail(row.address_normalized),
    status:
      row.status === 'verified' ? 'verified' : row.status === 'pending' ? 'pending' : 'revoked',
    isSignIn: row.is_sign_in && row.status === 'verified',
    createdAt: row.created_at.toISOString(),
    verifiedAt: row.verified_at === null ? null : row.verified_at.toISOString(),
  };
}

// -------------------------------------------------------------------------------------------
// Trần pending email theo sub — rate limit từ durable state
// -------------------------------------------------------------------------------------------

/**
 * Trần số hàng `pending` một sub được tạo trong cửa sổ — giới hạn khả năng
 * đăng nhập (authenticated) tạo rác: không có nó, một sub có thể tạo vô hạn
 * hàng `pending` (mỗi request một hàng, mail thì bị rate limit nhưng hàng thì
 * không) và phình `email_addresses`. Cùng triết lý với rate limit của
 * `otp_challenges`: đếm từ **durable state**, không bảng rate-limit riêng.
 */
export const PENDING_EMAIL_MAX_PER_WINDOW = 5;

/** Cửa sổ đếm của {@link PENDING_EMAIL_MAX_PER_WINDOW} (giây). */
export const PENDING_EMAIL_WINDOW_SECONDS = 3_600;

/**
 * Đếm hàng `pending` của một sub được tạo trong cửa sổ trượt — đầu vào của
 * trần phía trên. Đếm cả hàng vừa tạo bởi request này (caller gọi trước
 * INSERT) lẫn hàng cũ: giới hạn là về tần suất tạo, không phải tồn tại.
 */
export async function countRecentPendingEmails(
  pool: import('pg').Pool,
  userSub: string,
  sinceSeconds: number,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM account.email_addresses
      WHERE user_sub = $1 AND status = 'pending'
        AND created_at > now() - make_interval(secs => $2)`,
    [userSub, sinceSeconds],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Ghi hàng email `pending` cho một sub — hàng mới, KHÔNG upsert: địa chỉ đã có
 * hàng của caller (hoặc đã verified bởi ai đó) bị chặn ở route trước khi tới
 * đây. `is_sign_in` mặc định `false` — chỉ verify route mới đặt nó sau khi
 * địa chỉ verified thật sự.
 */
export async function insertEmailPending(
  pool: import('pg').Pool,
  params: {
    readonly userSub: string;
    readonly addressNormalized: string;
    readonly addressHash: string;
  },
): Promise<EmailAddressRow> {
  const result = await pool.query<EmailAddressRow>(
    `INSERT INTO account.email_addresses (user_sub, address_normalized, address_hash, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING id, address_normalized, status, is_sign_in, created_at, verified_at`,
    [params.userSub, params.addressNormalized, params.addressHash],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('email_addresses: insert returned no row');
  }
  return row;
}

/**
 * Chuyển một hàng `pending` của sub sang `verified` — nguyên tử, có điều kiện:
 * `WHERE status = 'pending'` bảo đảm một request song song không ghi đè mốc
 * `verified_at` của request đã thắng. `verified_at` do `now()` của DB đặt; cột
 * `is_sign_in` bật cùng lúc — địa chỉ vừa verify là địa chỉ đăng nhập (FR-002,
 * cờ hiển thị của 0005).
 *
 * Trả hàng đã đổi, hoặc `null` khi không còn hàng pending nào khớp (request
 * song song đã verify trước, hoặc hàng đã revoked) — caller tự xử lý.
 */
export async function markEmailVerified(
  pool: import('pg').Pool,
  params: { readonly userSub: string; readonly id: string },
): Promise<EmailAddressRow | null> {
  const result = await pool.query<EmailAddressRow>(
    `UPDATE account.email_addresses
        SET status = 'verified',
            verified_at = now(),
            is_sign_in = true,
            updated_at = now()
      WHERE id = $2 AND user_sub = $1 AND status = 'pending'
      RETURNING id, address_normalized, status, is_sign_in, created_at, verified_at`,
    [params.userSub, params.id],
  );
  return result.rows[0] ?? null;
}

/**
 * Revoke một hàng email của sub với guard FR-002 **nguyên tử** — DELETE là
 * hành vi của route "gỡ địa chỉ" theo yêu cầu chức năng, nhưng trạng thái
 * `revoked` giữ được lịch sử cho audit và cho phép user claim lại địa chỉ sau
 * này (partial UNIQUE của 0005 chặn `verified` mới chứ không chặn claim lại
 * sau revoke). `is_sign_in` đặt `false` cùng lúc — hàng revoked không còn là
 * địa chỉ đăng nhập.
 *
 * ## Guard FR-002 nằm trong transaction, không phải đếm-then-act
 *
 * Ràng buộc "≥1 verified còn lại" kiểm **trong cùng transaction** với UPDATE:
 * một statement `SELECT … ORDER BY id FOR UPDATE` khoá **toàn bộ** hàng của
 * sub theo thứ tự `id` cố định trước khi đếm, nên hai DELETE song song trên
 * hai địa chỉ verified khác nhau tuần tự hoá — request sau thấy kết quả của
 * request trước, và vì cả hai giành lock theo cùng thứ tự nên không có chu
 * trình deadlock (PostgreSQL 40P01). Một phép đếm ngoài transaction
 * (count-then-act) để hai request cùng thấy 2 verified, cùng vượt guard và hạ
 * caller xuống 0 verified — mất hẳn đường đăng nhập, vi phạm FR-002.
 *
 * Trả `'revoked'` khi đúng một hàng được revoke; `'last_verified'` khi phép
 * revoke sẽ hạ caller xuống 0 verified (bị chặn); `'already_revoked'` khi hàng
 * đã revoked trước (idempotent — route vẫn trả 204, không audit thứ hai);
 * `'missing'` khi hàng không tồn tại với caller (→ 404).
 */
export async function revokeEmailGuarded(
  pool: import('pg').Pool,
  params: { readonly userSub: string; readonly id: string },
): Promise<'revoked' | 'last_verified' | 'already_revoked' | 'missing'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Một statement khoá TOÀN BỘ hàng của sub theo thứ tự `id` — hai DELETE
    // song song tuần tự hoá tại đây và không có chu trình deadlock (cả hai
    // giành lock theo cùng thứ tự). Đếm trong JS từ snapshot đã khoá:
    // `FOR UPDATE` không đi cùng aggregate (PostgreSQL từ chối
    // `count(*) … FOR UPDATE`).
    const locked = await client.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM account.email_addresses
        WHERE user_sub = $1
        ORDER BY id
        FOR UPDATE`,
      [params.userSub],
    );
    const targetRow = locked.rows.find((row) => row.id === params.id);
    if (targetRow === undefined) {
      await client.query('COMMIT');
      return 'missing';
    }
    if (targetRow.status === 'revoked') {
      await client.query('COMMIT');
      return 'already_revoked';
    }
    const verifiedCount = locked.rows.filter((row) => row.status === 'verified').length;
    if (targetRow.status === 'verified' && verifiedCount <= 1) {
      await client.query('COMMIT');
      return 'last_verified';
    }
    const result = await client.query(
      `UPDATE account.email_addresses
          SET status = 'revoked',
              verified_at = NULL,
              is_sign_in = false,
              updated_at = now()
        WHERE id = $2 AND user_sub = $1 AND status <> 'revoked'`,
      [params.userSub, params.id],
    );
    await client.query('COMMIT');
    return (result.rowCount ?? 0) === 1 ? 'revoked' : 'missing';
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// -------------------------------------------------------------------------------------------
// Persistence — `account_sessions` (danh sách phiên của chính chủ)
// -------------------------------------------------------------------------------------------

/** Hàng phiên cho response — KHÔNG chứa `id_hash`, KHÔNG chứa `session_ref` (SR-006). */
export interface AccountSessionView {
  /**
   * Định danh công khai của phiên — xem {@link publicSessionId}. **Không** là
   * `session_ref`: SR-006 cấm giá trị đó trong URL, và `id` đi vào URL của
   * DELETE.
   */
  readonly id: string;
  readonly createdAt: string;
  /**
   * Suy gần đúng từ `expires_at` (idle deadline trừ hằng idle 12h): server
   * đẩy `expires_at` mỗi request hợp lệ, nên `expires_at - SESSION_IDLE_SECONDS`
   * là lần hoạt động gần nhất mà luồng touch nhìn thấy. Không cột `last_seen`
   * riêng trong schema — suy ra này là trung thực về những gì DB biết.
   */
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  /** Đúng một phiên trong danh sách có `true` — phiên của caller. */
  readonly isCurrent: boolean;
}

/**
 * Định danh công khai của một phiên: SHA-256 hex của `session_ref`.
 *
 * ⚠️ **Vì sao không trả `session_ref`**: SR-006 — `account_session_ref` không
 * bao giờ xuất hiện trong URL/log/audit, và `id` của phiên đi vào URL của
 * DELETE. Digest là giá trị khác `session_ref`, không đảo ngược được, và không
 * khớp được với session_ref mà không có DB. Chi phí: DELETE tra cứu phiên bằng
 * cách tính digest cho từng phiên của chính caller (danh sách đã giới hạn bởi
 * `user_sub`) — không truy vấn toàn bảng.
 */
export async function publicSessionId(sessionRef: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`session-public:${sessionRef}`),
  );
  let out = '';
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** Hàng phiên thô của danh sách. */
export interface LiveSessionRow {
  readonly session_ref: string;
  readonly created_at: Date;
  readonly expires_at: Date;
}

/**
 * Các phiên sống của một sub — chưa revoked và chưa quá idle expiry. Absolute
 * deadline (`created_at + 7d`) được kiểm ở tầng app cùng `isSessionLive` của
 * lib session; SQL lọc hai điều kiện rẻ nhất trước để danh sách ngắn.
 */
export async function listLiveSessions(
  pool: import('pg').Pool,
  userSub: string,
  nowMs: number,
): Promise<readonly LiveSessionRow[]> {
  const result = await pool.query<LiveSessionRow>(
    `SELECT session_ref, created_at, expires_at
       FROM account.account_sessions
      WHERE user_sub = $1 AND revoked_at IS NULL AND expires_at > $2
      ORDER BY created_at DESC`,
    [userSub, new Date(nowMs)],
  );
  return result.rows;
}

/**
 * Thu hồi một phiên của chính caller theo `session_ref` — cùng đường
 * `revokeSessionByRef` của lib session nhưng nhận pool có sẵn thay vì tự mở.
 *
 * Trả `true` khi có hàng bị cập nhật; `false` khi phiên không thuộc caller,
 * đã revoked rồi, hoặc đã quá idle expiry (idempotent — kết quả cuối cùng vẫn
 * là "phiên không còn sống").
 */
export async function revokeOwnSession(
  pool: import('pg').Pool,
  params: { readonly userSub: string; readonly sessionRef: string },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE account.account_sessions
        SET revoked_at = now()
      WHERE user_sub = $1 AND session_ref = $2 AND revoked_at IS NULL`,
    [params.userSub, params.sessionRef],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Dựng view công khai của một phiên từ hàng thô — điểm duy nhất tính
 * {@link publicSessionId} và suy `lastSeenAt`, nên mọi caller thấy cùng một
 * hình dạng response.
 *
 * ⚠️ `row.session_ref` KHÔNG rời hàm này vào bất kỳ trường nào của view.
 */
export async function toSessionView(
  row: { readonly session_ref: string; readonly created_at: Date; readonly expires_at: Date },
  ctx: { readonly idleSeconds: number; readonly currentRef: string },
): Promise<AccountSessionView> {
  return {
    id: await publicSessionId(row.session_ref),
    createdAt: row.created_at.toISOString(),
    lastSeenAt: new Date(row.expires_at.getTime() - ctx.idleSeconds * 1000).toISOString(),
    expiresAt: row.expires_at.toISOString(),
    isCurrent: row.session_ref === ctx.currentRef,
  };
}

// -------------------------------------------------------------------------------------------
// Persistence — `notification_preferences` (0008) — ý định nhận thông báo
// -------------------------------------------------------------------------------------------

/**
 * Kênh delivery mà DB định nghĩa (CHECK của 0008) — taxonomy **kênh**, không
 * phải phân loại nội dung của UI. UI giữ ba toggle nội dung
 * (serviceEmail | productUpdates | marketing); map v1 (quyết định ghi trong PR
 * body): toàn bộ ba toggle đều là **email** — `push` chưa có sản phẩm viết vào
 * nó, và một toggle UI điều khiển đúng một hàng intent.
 */
export const NOTIFICATION_CHANNEL_ALLOWLIST: readonly string[] = ['email', 'push'];

/** Kênh mà mọi toggle UI của v1 map vào. */
export const SERVICE_EMAIL_CHANNEL = 'email';

/** Hàng notification preference như PostgreSQL trả về. */
export interface NotificationPreferenceRow {
  readonly channel: string;
  readonly enabled: boolean;
}

/**
 * Đọc mọi intent kênh của một sub.
 *
 * ⚠️ **Không default ở đường đọc** — cùng lập luận `selectPreferences`: bảng
 * trung tính với chính sách opt-in/opt-out (comment 0008), một hàng không tồn
 * tại phải trả "chưa có hàng" thay vì default hoá im lặng. UI v1 hiển thị
 * trạng thái mặc định của riêng nó (object `NotificationPreferences` với mọi
 * toggle `true` cho email) và PATCH lần đầu ghi hàng thật.
 */
export async function listNotificationPreferences(
  pool: import('pg').Pool,
  userSub: string,
): Promise<readonly NotificationPreferenceRow[]> {
  const result = await pool.query<NotificationPreferenceRow>(
    `SELECT channel, enabled
       FROM account.notification_preferences
      WHERE user_sub = $1
      ORDER BY channel`,
    [userSub],
  );
  return result.rows;
}

/**
 * Ghi intent của MỘT kênh — upsert theo PK (user_sub, channel).
 *
 * ⚠️ Mỗi toggle UI là MỘT request PATCH với một kênh (map v1: cả ba toggle đều
 * `email`): không có PATCH hàng loạt nào để hai toggle song song ghi đè nhau
 * ngoài cùng một cột — mỗi hàng độc lập. `updated_at` do `now()` của DB đặt.
 */
export async function upsertNotificationPreference(
  pool: import('pg').Pool,
  params: {
    readonly userSub: string;
    readonly channel: string;
    readonly enabled: boolean;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO account.notification_preferences (user_sub, channel, enabled)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_sub, channel) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           updated_at = now()`,
    [params.userSub, params.channel, params.enabled],
  );
}

// -------------------------------------------------------------------------------------------
// Persistence — `privacy_requests` (0010) — yêu cầu data subject v1
// -------------------------------------------------------------------------------------------

/** Loại yêu cầu — allowlist đóng khớp CHECK `privacy_requests_kind_check` (0010). */
export const PRIVACY_KIND_ALLOWLIST: readonly string[] = [
  'export',
  'correct',
  'delete',
  'restrict',
  'object',
];

/** Trạng thái trả cho UI — khớp CHECK `privacy_requests_status_check` (0010). */
export const PRIVACY_STATUS_ALLOWLIST: readonly string[] = [
  'pending',
  'in-progress',
  'completed',
  'rejected',
];

/**
 * Số ngày deadline của v1 (FR-014) — quyết định v1 khi chưa có kết luận pháp
 * lý (bảng quyết định mở §7.1); forward-fix khi pháp lý chốt con số khác.
 */
export const PRIVACY_DEADLINE_DAYS = 30;

/** Trần số request một sub tạo trong cửa sổ — cùng triết lý trần pending email. */
export const PRIVACY_REQUEST_MAX_PER_WINDOW = 3;

/** Cửa sổ đếm của {@link PRIVACY_REQUEST_MAX_PER_WINDOW} (giây). */
export const PRIVACY_REQUEST_WINDOW_SECONDS = 3_600;

/** Hàng privacy request như PostgreSQL trả về — đầu vào của {@link toPrivacyRequestView}. */
export interface PrivacyRequestRow {
  readonly kind: string;
  readonly status: string;
  readonly created_at: Date;
  readonly deadline_at: Date;
}

/**
 * Danh sách privacy request của một sub, mới nhất trước — truy vấn duy nhất
 * của GET /api/privacy-requests (index `privacy_requests_subject_created_idx`).
 */
export async function listPrivacyRequests(
  pool: import('pg').Pool,
  userSub: string,
): Promise<readonly PrivacyRequestRow[]> {
  const result = await pool.query<PrivacyRequestRow>(
    `SELECT kind, status, created_at, deadline_at
       FROM account.privacy_requests
      WHERE subject_sub = $1
      ORDER BY created_at DESC`,
    [userSub],
  );
  return result.rows;
}

/**
 * Đếm request một sub tạo trong cửa sổ trượt — đầu vào của trần tạo
 * {@link PRIVACY_REQUEST_MAX_PER_WINDOW}. Đếm từ durable state, không bảng
 * rate-limit riêng (cùng luật `countRecentPendingEmails`).
 */
export async function countRecentPrivacyRequests(
  pool: import('pg').Pool,
  userSub: string,
  sinceSeconds: number,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM account.privacy_requests
      WHERE subject_sub = $1 AND created_at > now() - make_interval(secs => $2)`,
    [userSub, sinceSeconds],
  );
  return result.rows[0]?.count ?? 0;
}

/**
 * Kết quả tạo privacy request — phân biệt ba nhánh để route quyết định status:
 * `created`, `duplicate` (request mở cùng loại đã tồn tại — PK composite chặn,
 * idempotent trả hàng hiện có), `ceiling` (trần cửa sổ).
 */
export type PrivacyRequestOutcome =
  | { readonly kind: 'created'; readonly row: PrivacyRequestRow }
  | { readonly kind: 'duplicate'; readonly row: PrivacyRequestRow }
  | { readonly kind: 'ceiling' };

/**
 * Tạo privacy request `pending` với deadline một lần lúc tạo (FR-014).
 *
 * ⚠️ **Deadline theo `now()` của DB, không phải đồng hồ app** — một mốc pháp
 * lý phải từ nguồn thời gian duy nhất của dữ liệu; `deadline_at` KHÔNG BAO
 * GIỜ được UPDATE sau tạo (không có đường ghi nào chạm nó — comment 0010).
 *
 * ⚠️ Nhánh `duplicate`: PK (subject_sub, kind) chặn request mở thứ hai cùng
 * loại. Trả hàng hiện có để response của route là idempotent (`200` cùng
 * hình dạng như tạo mới) — caller của UI đã có confirm dialog, nộp đôi là
 * hành vi retry lành tính, và một hàng `pending` trùng là dữ liệu rác.
 */
export async function insertPrivacyRequest(
  pool: import('pg').Pool,
  params: {
    readonly userSub: string;
    readonly kind: string;
    readonly maxPerWindow: number;
    readonly windowSeconds: number;
    readonly deadlineDays: number;
  },
): Promise<PrivacyRequestOutcome> {
  const recent = await countRecentPrivacyRequests(pool, params.userSub, params.windowSeconds);
  if (recent >= params.maxPerWindow) {
    return { kind: 'ceiling' };
  }

  // Arbiter là partial unique index `privacy_requests_open_unique_idx` của
  // 0010 — chỉ chặn hàng đang mở. `ON CONFLICT` phải khai báo ĐỦ vế `WHERE`
  // của index (Postgres yêu cầu khớp chính xác, không khớp ⇒ lỗi 42P10).
  const result = await pool.query<PrivacyRequestRow>(
    `INSERT INTO account.privacy_requests (subject_sub, kind, status, deadline_at)
     VALUES ($1, $2, 'pending', now() + make_interval(days => $3))
     ON CONFLICT (subject_sub, kind) WHERE status IN ('pending', 'in-progress')
     DO NOTHING
     RETURNING kind, status, created_at, deadline_at`,
    [params.userSub, params.kind, params.deadlineDays],
  );
  const created = result.rows[0];
  if (created !== undefined) {
    return { kind: 'created', row: created };
  }
  // INSERT bị chặn bởi index mở — request đang mở cùng loại đã tồn tại; trả nó.
  const existing = await pool.query<PrivacyRequestRow>(
    `SELECT kind, status, created_at, deadline_at
       FROM account.privacy_requests
      WHERE subject_sub = $1 AND kind = $2
        AND status IN ('pending', 'in-progress')`,
    [params.userSub, params.kind],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    // Không tới được: ON CONFLICT DO NOTHING chỉ bỏ qua khi hàng trùng tồn tại.
    throw new Error('privacy_requests: conflict without existing row');
  }
  return { kind: 'duplicate', row };
}

/**
 * Chuyển hàng DB thành view cho response JSON — mốc thời gian qua ISO string;
 * `kind`/`status` đã qua allowlist phía caller nên giữ nguyên mã.
 */
export function toPrivacyRequestView(row: PrivacyRequestRow): {
  kind: string;
  status: string;
  submittedAt: string;
  dueAt: string;
} {
  return {
    kind: row.kind,
    status: row.status,
    submittedAt: row.created_at.toISOString(),
    dueAt: row.deadline_at.toISOString(),
  };
}

// -------------------------------------------------------------------------------------------
// Audit — `security_events`
// -------------------------------------------------------------------------------------------

/**
 * Tên event type của data domain v1 — tiền tố `data_` để tách nhóm khỏi event
 * của luồng OTP (`login_*` nếu có sau này). Danh sách đóng: thêm event mới là
 * sửa hằng này kèm test, không phải chuỗi tự do tại call site.
 */
export const DATA_EVENT_TYPES = {
  /** PATCH profile thành công. */
  profileUpdated: 'data_profile_updated',
  /** PATCH preferences thành công. */
  preferencesUpdated: 'data_preferences_updated',
  /** Thêm email mới (pending) — cả nhánh idempotent-cả-lại. */
  emailAdded: 'data_email_added',
  /** Verify email thành công. */
  emailVerified: 'data_email_verified',
  /** Resend verification thành công (mail đi ra). */
  emailResendSent: 'data_email_resend_sent',
  /** Xoá (revoke) email thành công. */
  emailRevoked: 'data_email_revoked',
  /** Thu hồi một session khác. */
  sessionRevoked: 'data_session_revoked',
  /** Thu hồi session hiện tại (tự logout từ trang sessions). */
  currentSessionRevoked: 'data_current_session_revoked',
  /** Cập nhật notification preferences (ít nhất một kênh đổi). */
  notificationPreferencesUpdated: 'data_notification_preferences_updated',
  /** Nộp privacy request thành công. */
  privacyRequested: 'data_privacy_requested',
  /** Thu hồi quyền của một connected application (qua contract với auth). */
  applicationRevoked: 'data_application_revoked',
} as const;

/** Kiểu event của data domain — union của các giá trị ở trên. */
export type DataEventType = (typeof DATA_EVENT_TYPES)[keyof typeof DATA_EVENT_TYPES];

/**
 * Ghi một hàng audit vào `security_events` (SR-002: append-only).
 *
 * ⚠️ **Không bao giờ ném** — observability/audit không được nằm trên serving
 * path (NFR-004): một lần ghi audit hỏng không được biến PATCH thành công thành
 * 500. Nhánh hỏng để lại dấu vết ở caller qua giá trị trả về; route tự log.
 *
 * ⚠️ Metadata là payload **đã sanitize**: không secret, không session_ref
 * (SR-006), không địa chỉ email trần. v1 chỉ ghi mã cấu trúc (`field_count`,
 * `channel_count`) — đủ để đếm tần suất, không đủ để tái hiện nội dung.
 *
 * ⚠️ **Cùng transaction với state change khi caller có `PoolClient`.** Đây là
 * hàm nhận `Pool` (đường gọi sau khi state change đã commit thành công) — chấp
 * nhận khoảng hở "state đã đổi, audit chưa ghi" khi process chết giữa hai bước;
 * audit missing là điều kiện được biết và không có đường nào audit ghi được cho
 * một state change chưa xảy ra. Route audit **sau** khi ghi DB thành công —
 * một request thất bại không tạo event `success` giả.
 */
export async function appendSecurityEvent(
  pool: import('pg').Pool,
  params: {
    readonly subjectSub: string;
    readonly type: DataEventType;
    readonly metadata?: Record<string, string | number | boolean>;
  },
): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO account.security_events (subject_sub, type, outcome, metadata)
       VALUES ($1, $2, 'success', $3::jsonb)`,
      [params.subjectSub, params.type, JSON.stringify(params.metadata ?? {})],
    );
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------------------------------
// Normalization export lại — route gọi một nơi duy nhất
// -------------------------------------------------------------------------------------------

/**
 * Normalize địa chỉ email của data domain — **cùng một hàm** với luồng OTP
 * (`normalizeEmailAddress`): hai đường cùng thấy một địa chỉ là cùng một địa
 * chỉ, không có hai luật normalize song song trôi khỏi nhau.
 */
export function normalizeEmail(address: string): string {
  return normalizeEmailAddress(address);
}
