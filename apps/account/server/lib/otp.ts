/**
 * Thư viện OTP của luồng đăng nhập email — sinh mã, digest keyed-HMAC, so sánh
 * timing-safe, normalize địa chỉ và rate limit.
 *
 * ## Biên của module này
 *
 * Toàn bộ **policy** (window, số lần thử, TTL) là hằng số export để test khoá và
 * call site không tự ghép số. Toàn bộ **I/O** (PostgreSQL, đồng hồ, entropy mặc
 * định) do caller truyền vào: các hàm thuần nhận tham số, các hàm persistence nhận
 * `Pool`. Module không đọc env, không giữ state — cùng nguyên tắc với
 * `server/utils/db.ts` (runtime:edge cấm node-local state).
 *
 * ## Anti-enumeration là bất biến của tầng này
 *
 * Route `challenge` phải trả lời **giống nhau** cho địa chỉ tồn tại và địa chỉ
 * lạ: không câu chữ, không status code, không thời gian phản hồi phân biệt được
 * (trong giới hạn của một lần ghi DB — phần thời gian được xử lý ở route bằng
 * cách **vẫn ghi** challenge cho địa chỉ lạ, dùng chính rate-limit làm cơ chế
 * chống dò, xem `0006_otp_challenges.sql`). Hàm `resolveOtpTarget` ở đây trả một
 * discriminator để route biết phải gửi mail hay không — discriminator đó **không
 * bao giờ** đi vào response.
 *
 * ⚠️ Không import `node:*`: `.oxlintrc.json` cấm Node builtin trong `apps/**`
 * (`runtime:edge`). WebCrypto (`crypto.subtle`, `crypto.getRandomValues`) là
 * global có trên cả Workers lẫn Node ≥ 19 — cùng đường với
 * `libs/internal-auth-contracts/src/internal-auth.ts`.
 */

/** Số chữ số của mã OTP. 8 chữ số = 10^8 không gian. */
export const OTP_CODE_DIGITS = 8;

/** TTL của một challenge (giây) — nhiệm vụ yêu cầu 10 phút. */
export const OTP_TTL_SECONDS = 600;

/** Khoảng cách tối thiểu giữa hai lần cấp mã cho cùng địa chỉ (giây). */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** Trần số lần nhập sai cho một challenge. */
export const MAX_OTP_ATTEMPTS = 5;

/** Rate limit cấp mã: tối đa 3 challenge trong cửa sổ trượt 15 phút, mỗi địa chỉ. */
export const OTP_RATE_LIMIT_SHORT_MAX = 3;

/** Cửa sổ ngắn của rate limit (giây). */
export const OTP_RATE_LIMIT_SHORT_WINDOW_SECONDS = 900;

/** Rate limit cấp mã: tối đa 10 challenge trong cửa sổ trượt 1 giờ, mỗi địa chỉ. */
export const OTP_RATE_LIMIT_HOUR_MAX = 10;

/** Cửa sổ dài của rate limit (giây). */
export const OTP_RATE_LIMIT_HOUR_WINDOW_SECONDS = 3600;

/** Độ dài tối thiểu của secret HMAC cho OTP — cùng mốc với internal HMAC. */
export const MIN_OTP_HMAC_SECRET_LENGTH = 32;

/** Purpose duy nhất của v1 — phải khớp CHECK `otp_challenges_purpose_check`. */
export const OTP_PURPOSE_LOGIN = 'login';

/** Kết quả sinh mã: mã trần (chỉ tồn tại trong bộ nhớ của caller) và digest để ghi. */
export interface OtpCodeMaterial {
  /** Mã 8 chữ số dạng chuỗi — đi thẳng vào mail, không bao giờ vào DB hay log. */
  readonly code: string;
  /** HMAC-SHA256 hex của `purpose:code` — thứ duy nhất được ghi xuống DB. */
  readonly digest: string;
}

/** Nhãn của một địa chỉ sau khi normalize. */
export interface NormalizedEmail {
  /** Địa chỉ đã lowercase + trim — dạng nội bộ, không phải dạng hiển thị. */
  readonly normalized: string;
  /** SHA-256 hex của `normalized` — khoá tra cứu của DB. */
  readonly hash: string;
}

/** Loại mục tiêu mà route `challenge` đối mặt. */
export type OtpTargetKind = 'verified' | 'unknown_or_unusable';

/**
 * Kết quả tra cứu địa chỉ — discriminated để route quyết định gửi mail hay chỉ
 * ghi challenge "ma" (rate-limit địa chỉ lạ), **không bao giờ** lộ vào response.
 */
export interface OtpTarget {
  readonly kind: OtpTargetKind;
  /** Chỉ có ở `verified`: hàng `email_addresses` và chủ thể của nó. */
  readonly emailId?: string;
  readonly userSub?: string;
  /** Trạng thái account của chủ thể — route phải fail-closed với `suspended`/`deleted`. */
  readonly accountStatus?: string;
}

/**
 * Chuẩn hoá địa chỉ email: trim + lowercase toàn bộ.
 *
 * ⚠️ Đây là hình thức normalize **đơn giản có chủ đích**, không phải bộ RFC 5321
 * đầy đủ: local-part của hầu hết provider là case-insensitive trong thực tế, và
 * việc giữ nguyên hoa/thường chia đôi không gian tra cứu mà không thêm đúng nào.
 * Ví dụ `dot-atom` đặc biệt (quoted local-part, `"A"@example.com`) là trường hợp
 * hiếm và bị loại một cách chấp nhận được vì luồng OTP chỉ phục vụ địa chỉ
 * **đã được user tự khai báo** — khai báo bằng dạng nào thì đăng nhập bằng dạng đó
 * sau khi normalize. Không chuẩn hoá theo kiểu provider (Gmail bỏ dấu chấm) — đó là policy của
 * provider, không phải của ta.
 */
export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** SHA-256 hex của địa chỉ đã normalize — khoá tra cứu DB. */
export async function emailAddressHash(normalized: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/** Cả hai bước normalize + hash — đường chính mà mọi call site dùng. */
export async function normalizeAndHashEmail(address: string): Promise<NormalizedEmail> {
  const normalized = normalizeEmailAddress(address);
  return { normalized, hash: await emailAddressHash(normalized) };
}

/**
 * Sinh mã OTP 8 chữ số **không bias** và digest HMAC của nó.
 *
 * ## Vì sao modulo sau một khoảng lớn là đủ, và vì sao vẫn loại bias
 *
 * `crypto.getRandomValues(Uint32Array)` cho giá trị đều trên [0, 2^32). Lấy
 * `value % 10^8` sẽ có bias nhỏ (2^32 không chia hết cho 10^8) — một bias 2^-12
 * không phải lỗ hổng thực tế, nhưng loại nó gần như miễn phí: lấy **số 64-bit
 * từ hai Uint32** rồi modulo 10^8. 2^64 mod 10^8 lệch rất nhỏ; dứt điểm bằng
 * rejection sampling trên khoảng [0, 10^8·k) — re-draw khi rơi vào phần dư.
 * Vòng lặp kết thúc gần như tức thì (xác suất re-draw ~5.4% mỗi lần với
 * k = floor(2^64/10^8)).
 *
 * Mã trả dạng chuỗi **có số 0 đệm đầu** (`padStart`) — một mã `0042...` là một
 * mã hợp lệ, và so sánh số học sẽ làm mất không gian đó.
 *
 * ⚠️ Mã trần chỉ sống trong bộ nhớ của caller cho tới khi đi vào mail. Không log,
 * không ghi DB, không đưa vào response — chỉ digest được lưu (invariant 9).
 *
 * @param hmacKey Secret hex hoặc chuỗi tuỳ ý từ Worker Secret; dùng thẳng làm
 *   khoá HMAC (encode UTF-8). Tham số để test khoá được bất biến digest mà không
 *   chạm env.
 * @param purpose Ghép vào trước mã trong message HMAC để digest của cùng mã ở
 *   hai purpose khác nhau là hai giá trị — domain separation rẻ nhất.
 * @param random Nguồn byte ngẫu nhiên do caller truyền (mặc định
 *   `crypto.getRandomValues` trên `Uint32Array(2)`). Test truyền nguồn tất định
 *   để kiểm trajectory mà không chạm CSPRNG.
 */
export async function createOtpChallenge(
  hmacKey: string,
  purpose: string,
  random?: () => number,
): Promise<OtpCodeMaterial> {
  const code = random === undefined ? drawUnbiasedCode() : deterministicCode(random);
  const digest = await otpDigest(hmacKey, purpose, code);
  return { code, digest };
}

/**
 * HMAC-SHA256(key, `purpose + ":" + code`), hex 64 ký tự.
 *
 * Message ghép theo mẫu `purpose:code` thay vì hash riêng từng phần: purpose là
 * hằng của giao thức (`login`), code là chuỗi digit độ dài cố định, nên ghép
 * không mơ hồ. Export riêng để test tính bất biến digest (cùng key + cùng input
 * ⇒ cùng digest; đổi key ⇒ digest khác) và để verify gọi đúng hàm này.
 */
export async function otpDigest(hmacKey: string, purpose: string, code: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(hmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = new TextEncoder().encode(`${purpose}:${code}`);
  const signature = await crypto.subtle.sign('HMAC', key, message);
  return toHex(new Uint8Array(signature));
}

/**
 * So sánh digest theo thời gian hằng trên hex — bản dùng cho OTP của
 * `timingSafeEqualHex` trong `libs/internal-auth-contracts` (không import được: contract
 * lib không export hàm nội bộ đó, và lặp lại một hàm 15 dòng với cùng JSDoc là rẻ
 * hơn một phụ thuộc mới vào `type:contracts` từ composition app).
 *
 * XOR trên từng byte, không short-circuit: thời gian chạy không phụ thuộc vị trí
 * byte khác nhau đầu tiên. Độ dài khác nhau trả `false` trước vòng lặp — độ dài
 * digest là hằng công khai (64 hex), rò ở đó không lộ gì.
 */
export function timingSafeDigestEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const left = Number.parseInt(a[i] ?? '0', 16);
    const right = Number.parseInt(b[i] ?? '0', 16);
    diff |= left ^ right;
  }
  return diff === 0;
}

/**
 * Rút một mã từ CSPRNG không bias — rejection sampling trên khoảng 64-bit.
 *
 * Export để test gọi trực tiếp và đo phân bố/độ dài; đường production đi qua
 * {@link createOtpChallenge}.
 */
export function drawUnbiasedCode(): string {
  const space = 10 ** OTP_CODE_DIGITS;
  // k = số lượng "splits" đầy đủ của [0, 2^64) — mọi giá trị dưới `k * space`
  // đều nhau trên không gian mã.
  const spaceBig = BigInt(space);
  const draws = 2n ** 64n;
  const usable = (draws / spaceBig) * spaceBig; // k * space, số nguyên 64-bit

  for (;;) {
    const value = (BigInt(cryptoRandom32()) << 32n) | BigInt(cryptoRandom32());
    // Giá trị dưới `usable` là đều trên không gian; lấy modulo. Re-draw phần dư.
    if (value < usable) {
      const code = Number(value % spaceBig);
      return String(code).padStart(OTP_CODE_DIGITS, '0');
    }
    // Biên an toàn không bao giờ chạm vì `usable >= 2^53` khi space = 10^8
    // (2^64/10^8 ≈ 1.8·10^11 splits). Assert dạng comment chứ không throw để
    // không thêm nhánh runtime vô nghĩa.
  }
}

/** Con số tất định từ callback — đường test của {@link createOtpChallenge}. */
function deterministicCode(random: () => number): string {
  const code = Math.abs(Math.floor(random())) % 10 ** OTP_CODE_DIGITS;
  return String(code).padStart(OTP_CODE_DIGITS, '0');
}

function cryptoRandom32(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] ?? 0;
}

/** Byte buffer → hex chữ thường. */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Persistence — PostgreSQL
// -------------------------------------------------------------------------------------------

/** Hàng `otp_challenges` cần cho verify và cho kiểm cooldown resend. */
export interface OtpChallengeRow {
  readonly id: string;
  readonly code_digest: string;
  readonly attempts: number;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly created_at: Date;
}

/**
 * Loại pool mà persistence của module này nhận — luôn là `Pool` của caller. Các
 * hàm tự mở `PoolClient` bên trong transaction; không nhận `PoolClient` từ ngoài
 * (khác với `bindHandleFirst`/`insertAnonymousSession` chạy trong transaction do
 * caller mở).
 */
type QueryablePool = import('pg').Pool;

/**
 * Challenge active của một (address, purpose) — hoặc `null`.
 *
 * Unique partial index đảm bảo tối đa một hàng; đọc bằng `LIMIT 1` vẫn đúng hợp
 * đồng kể cả khi index bị bỏ (ví dụ hàng cũ từ trước khi migration tạo index).
 */
export async function findActiveChallenge(
  pool: QueryablePool,
  addressHash: string,
  purpose: string,
): Promise<OtpChallengeRow | null> {
  const result = await pool.query<{
    id: string;
    code_digest: string;
    attempts: number;
    expires_at: Date;
    consumed_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, code_digest, attempts, expires_at, consumed_at, created_at
       FROM account.otp_challenges
      WHERE address_hash = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [addressHash, purpose],
  );
  const row = result.rows[0];
  return row === undefined ? null : row;
}

/**
 * Đếm số challenge đã cấp cho địa chỉ trong cửa sổ trượt — đầu vào của rate limit.
 *
 * Đếm **mọi** hàng trong cửa sổ, kể cả đã consume: giới hạn là về **tần suất cấp
 * mã** (mỗi cấp là một mail đi ra), không phải về số challenge đang sống.
 */
export async function countChallengesSince(
  pool: QueryablePool,
  addressHash: string,
  sinceSeconds: number,
): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM account.otp_challenges
      WHERE address_hash = $1 AND created_at > now() - make_interval(secs => $2)`,
    [addressHash, sinceSeconds],
  );
  return result.rows[0]?.count ?? 0;
}

/** Quyết định rate limit — thuần, test được không cần DB. */
export function isRateLimited(shortCount: number, hourCount: number): boolean {
  return shortCount >= OTP_RATE_LIMIT_SHORT_MAX || hourCount >= OTP_RATE_LIMIT_HOUR_MAX;
}

/**
 * Kiểm cooldown resend: còn `now - lastCreated < cooldown` không.
 *
 * Thuần — caller truyền mốc tạo của challenge active gần nhất.
 */
export function isResendBlocked(lastCreatedAt: Date, nowMs: number): boolean {
  const elapsedMs = nowMs - lastCreatedAt.getTime();
  return elapsedMs < OTP_RESEND_COOLDOWN_SECONDS * 1000;
}

/**
 * Ghi một challenge mới, **consume challenge active cũ trong cùng transaction**,
 * đồng thời chạy phép đo **cuối cùng** của rolling-window rate limit **trong**
 * transaction đó — ngay sau khi thoát khoá hàng active.
 *
 * ## Hai neo tuần tự hoá, không advisory lock
 *
 * Transaction này là nơi duy nhất quyết định "request này được cấp mã hay không";
 * mọi guard phải ở đây chứ không ở pre-check của route (route đọc bằng `Pool`
 * chung ngoài transaction — N request đồng thời có thể cùng vượt phép đo
 * pre-check `otpBlocked` rồi cùng tới đây, xem `challenge.post.ts`). Với READ
 * COMMITTED, tuần tự hoá dựa trên HAI neo tuỳ theo trạng thái bảng:
 *
 * - **Có hàng active** → chuỗi khoá hàng: `SELECT … FOR UPDATE` là statement
 *   blocking của transaction này; transaction trước cùng địa chỉ giữ khoá tới
 *   COMMIT. Khi khoá được nhả, statement KẾ TIẾP của transaction này mở snapshot
 *   mới — thấy đủ mọi hàng transaction trước đã commit (READ COMMITTED: mỗi
 *   statement một snapshot). Chính vì thế phép đếm cửa sổ **phải đứng SAU**
 *   statement khoá: đo trước khi chờ khoá thì snapshot của phép đếm lấy trước khi
 *   predecessor commit, không thấy hàng mới của nó — request thua-rác không bị
 *   chặn và cửa sổ trượt tràn.
 * - **Không có hàng active** (địa chỉ mới hoặc mọi hàng đã consume) → partial
 *   UNIQUE index `(address_hash, purpose) WHERE consumed_at IS NULL` là neo:
 *   các `INSERT` đồng thời được tuần tự hoá bởi chính index; request thua nhận
 *   23505 và caller coi như nhánh bị chặn bình thường.
 *
 * ⚠️ **Không dùng advisory lock** (`pg_advisory_xact_lock`/`pg_advisory_lock`):
 * Hyperdrive — đường production của database này (`accountHyperdrive`) — không
 * hỗ trợ nhóm statement đó (`cloudflare-docs:
 * hyperdrive/reference/supported-databases-and-features`). Hai neo trên đủ để
 * đóng race, đúng cơ chế Postgres thường, chạy được trên Hyperdrive.
 *
 * Tại sao KHÔNG dùng `SERIALIZABLE` + retry 40001: hai neo trên đã loại mọi
 * đường tràn đo được (path fresh-address được index giữ, path consume-slot-freed
 * được thứ tự khoá-trước–đếm-sau giữ), nên chi phí vòng retry + rollback của
 * isolation level mạnh hơn không mua thêm bất biến nào. SERIALIZABLE chỉ
 * cần khi phép đo phải tuần tự với **nhiều** hàng — ở đây mọi phép ghi cùng địa
 * chỉ đều đi qua một trong hai neo.
 *
 * ## Thứ tự guard trong transaction
 *
 *  1. **Khoá hàng active** `SELECT … FOR UPDATE` — statement blocking; đồng thời
 *     giữ đúng một định nghĩa cooldown: `now()` của transaction là cố định,
 *     `created_at` so qua `isResendBlocked` bằng chuẩn của route.
 *  2. **Cooldown resend** — hàng active còn trong 60s ⇒ nhả khoá (`COMMIT`),
 *     trả `null`. Không đếm, không consume, không insert.
 *  3. **Đếm hai cửa sổ trượt** (15 phút / 1 giờ) — một câu SELECT hai
 *     `count(*) FILTER`, đứng SAU bước khoá (trường hợp chờ khoá thì snapshot
 *     này thấy đủ mọi hàng predecessor đã commit). Đếm **mọi** hàng trong cửa
 *     sổ kể cả đã consume: giới hạn là về tần suất cấp mã. Vượt trần ⇒ COMMIT
 *     nhả khoá, trả `null` — nhánh bị chặn bình thường, route đổi thành 204 im
 *     lặng (anti-enumeration: mọi nhánh bị chặn cùng response).
 *  4. **Consume-`UPDATE`** chỉ consume hàng ngoài cooldown — hàng sinh ra trong
 *     cooldown là hàng của request khác thắng gần đây, request này không cướp.
 *     Hàng commit sau statement 1 chỉ lọt qua statement này và kết thúc ở 23505
 *     của `INSERT` (đo được: test race vẫn thấy 2 mail nếu bỏ điều kiện).
 *  5. **INSERT** va partial UNIQUE index: một challenge active cho mỗi
 *     (address, purpose) là thuộc tính của DB, không phải quy tắc app.
 *
 * Unique partial index tại INSERT vẫn là ràng buộc cuối cùng (23505 → caller
 * coi như thua race); transaction rollback khi `INSERT` ném — hàng cũ trả lại
 * trạng thái active, không mất mát.
 *
 * Lỗi flaky của `otp-flow-e2e.spec.ts` trên CI là bằng chứng đo được của kẽ hở
 * cooldown; cả hai lớp cooldown đều được chạy thật khi xác minh bản sửa.
 *
 * @returns Hàng đã ghi (để route biết `id` và `expires_at` khi cần); `null` khi
 *   bị chặn bởi bất kỳ guard nào trong transaction — cooldown còn hiệu lực hoặc
 *   cửa sổ trượt đã tràn. Caller (route) coi `null` lẫn lỗi unique violation như
 *   điều kiện bị chặn bình thường của luồng và trả 204 im lặng, **không** retry
 *   ngầm.
 */
export async function insertChallenge(
  pool: QueryablePool,
  params: {
    addressHash: string;
    digest: string;
    purpose: string;
    expiresAt: Date;
    /** Cửa sổ cooldown resend — policy của caller, route truyền thẳng hằng của module. */
    resendCooldownSeconds: number;
    /** Cửa sổ ngắn của rate limit (giây) — cùng nguồn với phép đo pre-check route. */
    rateLimitShortWindowSeconds: number;
    /** Cửa sổ dài của rate limit (giây) — cùng nguồn với phép đo pre-check route. */
    rateLimitHourWindowSeconds: number;
  },
): Promise<{ id: string; expiresAt: Date } | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lớp 1: khoá hàng active nhìn thấy được trước khi đọc `created_at`, để phép
    // đọc và phép ghi phía dưới thành một điểm tuần tự đối với hàng đó. Statement
    // này cũng là neo tuần tự hoá của phép đếm CỬA SỔ TRƯỢT phía dưới: transaction
    // trước cùng địa chỉ giữ khoá tới COMMIT, và sau khi thoát khoá, statement kế
    // tiếp mở snapshot READ COMMITTED mới — thấy đủ mọi hàng nó vừa commit.
    // `now()` của một transaction là cố định, còn `created_at` do `INSERT` của
    // transaction khác ghi — so sánh qua `isResendBlocked` giữ đúng một định nghĩa
    // cooldown cho cả route và đây.
    const active = await client.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at
         FROM account.otp_challenges
        WHERE address_hash = $1 AND purpose = $2 AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [params.addressHash, params.purpose],
    );
    const activeRow = active.rows[0];
    if (activeRow !== undefined && isResendBlocked(activeRow.created_at, Date.now())) {
      // Cooldown còn hiệu lực: không consume, không ghi. COMMIT để nhả khoá và
      // trả `undefined` — đây là branch bị chặn bình thường, không phải lỗi.
      await client.query('COMMIT');
      return undefined;
    }
    // Lớp 2: đếm hai cửa sổ trượt — đứng SAU statement khoá (lớp 1), KHÔNG trước.
    // Thứ tự này là phần đóng path "consume-slot-freed": T2 block trong lớp 1 trong
    // khi T1 commit (consume X + insert Y); khi T2 thoát block, statement đếm này
    // mở snapshot mới và thấy hàng Y của T1 — nếu trần đã cạn thì T2 trả `null`
    // thay vì insert. Đo trước lớp 1 thì snapshot của phép đếm lấy trước khi T1
    // commit, không thấy Y (path OCR-3), và trần giữ không được. Không khoá tư vấn
    // được dùng: Hyperdrive (đường production) không hỗ trợ advisory lock.
    // Với địa chỉ chưa từng có hàng (không ai FOR UPDATE được gì) thì partial
    // UNIQUE index tại INSERT là neo tuần tự hoá — các INSERT đồng thời được index
    // xếp hàng, request thua 23505, caller coi như nhánh bị chặn.
    const window = await client.query<{ short_count: number; hour_count: number }>(
      `SELECT count(*) FILTER (WHERE created_at > now() - make_interval(secs => $3))::int AS short_count,
              count(*) FILTER (WHERE created_at > now() - make_interval(secs => $4))::int AS hour_count
         FROM account.otp_challenges
        WHERE address_hash = $1 AND purpose = $2`,
      [
        params.addressHash,
        params.purpose,
        params.rateLimitShortWindowSeconds,
        params.rateLimitHourWindowSeconds,
      ],
    );
    const windowRow = window.rows[0];
    if (isRateLimited(windowRow?.short_count ?? 0, windowRow?.hour_count ?? 0)) {
      // Cửa sổ trượt hết allowance: không consume, không ghi — nhánh bị chặn
      // bình thường. COMMIT để nhả khoá, trả `undefined` cùng hợp đồng với nhánh
      // cooldown: route đổi nó thành 204 im lặng.
      await client.query('COMMIT');
      return undefined;
    }
    // Lớp 3: chỉ consume hàng ngoài cooldown — hàng sinh ra trong cooldown là hàng
    // của một request khác thắng gần đây, request này không được cướp. Hàng commit
    // sau `SELECT` ở trên chỉ lọt qua statement này, và với điều kiện thì nó kết
    // thúc ở 23505 của `INSERT` dưới thay vì thành mail thứ hai.
    await client.query(
      `UPDATE account.otp_challenges
          SET consumed_at = now()
        WHERE address_hash = $1 AND purpose = $2 AND consumed_at IS NULL
          AND created_at <= now() - ($3 * interval '1 second')`,
      [params.addressHash, params.purpose, params.resendCooldownSeconds],
    );
    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO account.otp_challenges (address_hash, code_digest, purpose, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, expires_at`,
      [params.addressHash, params.digest, params.purpose, params.expiresAt],
    );
    await client.query('COMMIT');
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('otp_challenges: insert returned no row');
    }
    return { id: row.id, expiresAt: row.expires_at };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Khoá challenge đã quá TTL — một UPDATE nguyên tử theo (address, purpose).
 *
 * `findActiveChallenge` trả hàng chưa consume gần nhất và **không** lọc theo
 * `expires_at`: "chưa consume" không đồng nghĩa "còn hiệu lực". Mọi call-site
 * hiện tại tự so `isExpired` trước khi tin kết quả (route `verify` làm vậy),
 * nên hàng hết hạn không tự hoạt động được — việc khoá này là hygiene, không
 * phải vá lỗ hổng. Nhưng nó giữ một bất biến mà chỉ một UPDATE nguyên tử cột
 * được: `consumed_at IS NULL` luôn nghĩa "chưa đi qua vòng đời". Không khoá thì
 * hàng hết hạn nằm ở trạng thái "active theo ràng buộc" mãi mãi, và một đường
 * code sau này chỉ tin điều kiện active (mà quên `isExpired`) sẽ đọc được một
 * challenge đã chết như còn sống.
 *
 * Route `verify` gọi khi phát hiện hết hạn. Mốc thời gian do caller truyền để
 * cùng một nguồn với phép `isExpired` đã quyết định nhánh; điều kiện trong SQL
 * so `expires_at` với mốc đó, không với `now()` DB — hai đồng hồ của Worker và
 * DB lệch nhau vài giây không đổi kết quả của TTL mười phút.
 *
 * @returns Số hàng đã khoá (1 khi có hàng hết hạn chưa consume; 0 khi không).
 */
export async function expireChallengeIfExpired(
  pool: QueryablePool,
  addressHash: string,
  purpose: string,
  nowMs: number,
): Promise<number> {
  const result = await pool.query(
    `UPDATE account.otp_challenges
        SET consumed_at = now()
      WHERE address_hash = $1 AND purpose = $2
        AND consumed_at IS NULL
        AND expires_at <= $3`,
    [addressHash, purpose, new Date(nowMs)],
  );
  return result.rowCount ?? 0;
}

/**
 * Consume challenge — một UPDATE nguyên tử, chỉ khi còn active.
 *
 * @returns `true` khi request này thắng consume; `false` khi request khác đã
 *   consume trước (single-use enforced bởi điều kiện WHERE, không phải bằng
 *   đọc-rồi-ghi).
 */
export async function consumeChallenge(pool: QueryablePool, challengeId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE account.otp_challenges
        SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL`,
    [challengeId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Tăng `attempts` và khoá ngay khi đạt trần — trong **một** câu UPDATE.
 *
 * Tính nguyên tử của riêng phép cộng không đủ. `attempts = attempts + 1` bảo
 * đảm hai request cạnh nhau không đè mất lần đếm của nhau, nhưng nếu việc khoá
 * (consume khi `attempts >= MAX_OTP_ATTEMPTS`) là một UPDATE riêng chạy
 * **sau** ở route thì giữa hai câu có khoảng trống: lần thử chạm trần và lần
 * thử `MAX_OTP_ATTEMPTS + 1` chen vào đó và tăng tiếp — trần 5 quay thành trần
 * tuỳ hứng (test concurrency đo được trần chạy tới 10). Điều kiện khoá do đó
 * phải nằm trong chính câu tăng, tính trên giá trị cột đã cộng.
 *
 * Câu SQL thực hiện cùng lúc hai hành vi, trong một transaction ngầm của
 * PostgreSQL:
 *
 * 1. `attempts = attempts + 1` — nguyên tử theo PostgreSQL row-level lock. Phép
 *    so của khoá viết `attempts + 1 >= MAX` (giá trị MỚI) vì bên phải phép gán
 *    `SET` đọc giá trị CŨ của hàng.
 * 2. `consumed_at = now()` khi `attempts` cộng xong đã đạt trần — khoá còn
 *    active chạm trần ngay lập tức, không chờ route quyết định.
 *
 * Cả hai chỉ khớp khi challenge chưa consume (`consumed_at IS NULL`): request
 * khác đã consume giữa chừng thì không tăng, không khoá — cùng hợp đồng trả
 * `null` như một UPDATE tăng thuần tuý.
 *
 * @returns Số `attempts` sau khi tăng, hoặc `null` khi challenge đã bị consume
 *   bởi request khác giữa chừng.
 */
export async function recordFailedAttemptAndLock(
  pool: QueryablePool,
  challengeId: string,
): Promise<number | null> {
  const result = await pool.query<{ attempts: number }>(
    `UPDATE account.otp_challenges
        SET attempts = attempts + 1,
            consumed_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE consumed_at END
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING attempts`,
    [challengeId, MAX_OTP_ATTEMPTS],
  );
  const row = result.rows[0];
  return row === undefined ? null : row.attempts;
}

/**
 * Nhận diện lỗi unique violation của PostgreSQL (`23505`) từ một error bất kỳ.
 *
 * Route `challenge` dùng nó để phân biệt **thua race consume-then-insert** (hai
 * request cấp mã song song cho cùng địa chỉ — partial UNIQUE index chỉ cho một
 * cái thắng) khỏi lỗi DB thật. Thua race là một nhánh bị chặn bình thường của
 * luồng — nó phải về `silently_rejected` (204, anti-enumeration), không được rơi
 * vào 503 `db_unreachable` vì 503 là một response phân biệt được.
 *
 * Chỉ đọc `code` của error driver `pg` — không đọc `message` (message có thể
 * chứa giá trị cột, ví dụ digest).
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

// -------------------------------------------------------------------------------------------
// Tra cứu địa chỉ — đầu vào của anti-enumeration
// -------------------------------------------------------------------------------------------

/**
 * Hàng `email_addresses` + trạng thái `users` của địa chỉ đã tra cứu.
 */
export interface OtpAddressLookup {
  readonly emailId: string | null;
  readonly userSub: string | null;
  readonly accountStatus: string | null;
}

/**
 * Tra cứu địa chỉ theo hash: hàng `email_addresses` verified và trạng thái account.
 *
 * ⚠️ Chỉ hàng `status = 'verified'` được nhận OTP đăng nhập (FR-002). `pending`
 * trả như **không tồn tại** — cả hai cùng là `unknown_or_unusable` ở tầng route.
 */
export async function lookupVerifiedAddress(
  pool: QueryablePool,
  addressHash: string,
): Promise<OtpAddressLookup | null> {
  const result = await pool.query<{
    email_id: string;
    user_sub: string;
    account_status: string;
  }>(
    `SELECT e.id AS email_id, e.user_sub, u.status AS account_status
       FROM account.email_addresses e
       JOIN account.users u ON u.sub = e.user_sub
      WHERE e.address_hash = $1 AND e.status = 'verified'
      LIMIT 1`,
    [addressHash],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    emailId: row.email_id,
    userSub: row.user_sub,
    accountStatus: row.account_status,
  };
}

/**
 * Phân loại mục tiêu — route dùng kết quả này để quyết định **hành vi nội bộ**
 * (gửi mail hay không), không phải để phân biệt response.
 *
 * Fail-closed với account status: `active` là trạng thái duy nhất được tiếp tục;
 * `suspended`/`deleted` và mọi giá trị lạ đều về `unknown_or_unusable` — cùng kết
 * quả phát hành, đúng hợp đồng "not_found và deleted dẫn tới cùng kết quả" của
 * FR-011d.
 */
export function resolveOtpTarget(lookup: OtpAddressLookup | null): OtpTarget {
  if (
    lookup === null ||
    lookup.emailId === null ||
    lookup.userSub === null ||
    lookup.accountStatus !== 'active'
  ) {
    return { kind: 'unknown_or_unusable' };
  }
  return {
    kind: 'verified',
    emailId: lookup.emailId,
    userSub: lookup.userSub,
    accountStatus: lookup.accountStatus,
  };
}
