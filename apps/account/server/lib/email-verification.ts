/**
 * Mã xác minh email cho data domain — cấp, kiểm và consume OTP trên **bảng
 * `otp_challenges` dùng chung** với luồng đăng nhập.
 *
 * ## Vì sao tái sử dụng `otp_challenges`, không tạo bảng thứ hai
 *
 * 0006 đã nói rõ ý định này (COMMENT của cột `purpose`): "Login is the only
 * one in v1; the column is split so later flows can share the table". Bảng giữ
 * đúng thứ verify-email cần: keyed HMAC digest của mã (không lưu plaintext),
 * partial UNIQUE một challenge active cho mỗi (address, purpose), rate limit
 * đếm được từ chính hàng, TTL + consume nguyên tử. Tự dựng bảng mới là nhân
 * bản cả bốn tính chất đó — và tạo một kho mã thứ hai phải bảo vệ riêng.
 *
 * ## Địa chỉ của purpose là hash, không phải địa chỉ trần
 *
 * Cùng quy ước `address_hash` của luồng login: phép tra cứu theo SHA-256 hex
 * của địa chỉ đã normalize, không có địa chỉ trần trong index. Kiểu dữ liệu
 * (`addressKey`) ở đây là **ràng buộc hình dạng** để một caller không thể nhầm
 * địa chỉ trần thành hash: `fromNormalizedAddress` là đường duy nhất tạo giá
 * trị, và các hàm khác nhận kiểu này thay vì `string`.
 *
 * ## Mục đích mới `verify_email`
 *
 * 0006 chỉ CHECK `purpose IN ('login')` — cột chia từ đầu nhưng CHECK chưa
 * mở. Migration `0009` của PR này nới CHECK sang `('login', 'verify_email')`.
 * Domain-separation của digest (`otpDigest(key, purpose, code)`) bảo đảm một
 * mã của luồng đăng nhập không verify được email và ngược lại, dù trùng giá trị.
 */

import { emailAddressHash, normalizeEmailAddress } from './otp';

/** Purpose duy nhất của luồng verify-email — khớp CHECK mới của migration 0009. */
export const OTP_PURPOSE_VERIFY_EMAIL = 'verify_email';

/** TTL của mã verify-email (giây) — cùng mốc 10 phút với login. */
export const VERIFY_EMAIL_TTL_SECONDS = 600;

/**
 * Trần số lần thử sai cho một challenge verify-email.
 *
 * ⚠️ Giá trị **không** đọc `MAX_OTP_ATTEMPTS` của login: hai luồng cùng chia
 * bảng nhưng policy là của từng luồng — nới trần login không được tự động nới
 * verify-email. Cùng con số 5 là trùng hợp có chủ đích, không phải tham chiếu.
 */
export const VERIFY_EMAIL_MAX_ATTEMPTS = 5;

/** Cửa sổ rate limit ngắn (giây): tối đa 3 mã trong 15 phút, mỗi địa chỉ. */
export const VERIFY_EMAIL_RATE_SHORT_WINDOW_SECONDS = 900;

/** Trần cửa sổ ngắn. */
export const VERIFY_EMAIL_RATE_SHORT_MAX = 3;

/** Cửa sổ rate limit dài (giây): tối đa 10 mã trong 1 giờ, mỗi địa chỉ. */
export const VERIFY_EMAIL_RATE_HOUR_WINDOW_SECONDS = 3_600;

/** Trần cửa sổ dài. */
export const VERIFY_EMAIL_RATE_HOUR_MAX = 10;

/** Cooldown giữa hai lần cấp mã cho cùng địa chỉ (giây). */
export const VERIFY_EMAIL_RESEND_COOLDOWN_SECONDS = 60;

/**
 * Khoá tra cứu của luồng verify-email: SHA-256 hex của địa chỉ đã normalize.
 *
 * Kiểu branded để `addressHash` (login) và `verify_email` không trộn được —
 * cả hai đều là hex 64 nhưng ý nghĩa Tra cứu khác nhau theo purpose.
 */
declare const addressKeyBrand: unique symbol;
export type AddressKey = string & { readonly [addressKeyBrand]: true };

/** Tạo khoá tra cứu từ địa chỉ trần — normalize + hash, đường duy nhất. */
export async function addressKeyFromRaw(address: string): Promise<AddressKey> {
  return (await emailAddressHash(normalizeEmailAddress(address))) as AddressKey;
}

// -------------------------------------------------------------------------------------------
// Persistence — cột mượn của `otp_challenges`
// -------------------------------------------------------------------------------------------

/** Pool tối thiểu mà các hàm persistence cần — `Pool` thật của caller. */
type QueryablePool = import('pg').Pool;

/** Kết quả ghi challenge verify-email thành công. */
export interface VerifyEmailChallenge {
  readonly id: string;
  readonly expiresAt: Date;
}

/**
 * Ghi một challenge `verify_email` — consume challenge active cũ **ngoài**
 * cooldown, đếm rate limit, rồi INSERT. Toàn bộ trong **một transaction** với
 * cùng hai neo tuần tự hoá của `insertChallenge` (login): khoá hàng active
 * `FOR UPDATE` trước, đếm cửa sổ sau, partial UNIQUE index tại INSERT là ràng
 * buộc cuối cùng.
 *
 * ⚠️ **Bản sao có chủ đích của `insertChallenge`** (`server/lib/otp.ts`), với
 * hai khác biệt: purpose là `verify_email`, và cooldown/rate limit là hằng của
 * luồng này ({@link VERIFY_EMAIL_RESEND_COOLDOWN_SECONDS}...). Không gọi qua
 * `insertChallenge` được vì hàm đó fix cứng `purpose` qua tham số nhưng rate
 * limit đếm lẫn hàng `login` — hai luồng phải **độc lập** về allowance: dò
 * verify-email không được tốn hạn mức đăng nhập của user và ngược lại. Bản sao
 * nằm cạnh bản gốc trong review; một cuộc gộp về sau phải chứng minh được hai
 * luồng vẫn đếm riêng.
 *
 * Trả `undefined` khi bị chặn (cooldown còn hiệu lực hoặc cửa sổ tràn) — caller
 * (route) quyết định anti-enumeration response; con số này không bao giờ vào body.
 */
export async function insertVerifyEmailChallenge(
  pool: QueryablePool,
  params: {
    readonly addressKey: AddressKey;
    readonly digest: string;
    readonly expiresAt: Date;
    readonly resendCooldownSeconds: number;
    readonly rateShortWindowSeconds: number;
    readonly rateHourWindowSeconds: number;
  },
): Promise<VerifyEmailChallenge | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Neo 1: khoá hàng active cùng purpose để phép đọc cooldown và phép đếm
    // cửa sổ tuần tự với COMMIT của transaction trước cùng địa chỉ (READ
    // COMMITTED: statement sau khi thoát khoá thấy đủ hàng vừa commit).
    const active = await client.query<{ id: string; created_at: Date }>(
      `SELECT id, created_at
         FROM account.otp_challenges
        WHERE address_hash = $1 AND purpose = $2 AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [params.addressKey, OTP_PURPOSE_VERIFY_EMAIL],
    );
    const activeRow = active.rows[0];
    if (
      activeRow !== undefined &&
      Date.now() - activeRow.created_at.getTime() < params.resendCooldownSeconds * 1000
    ) {
      await client.query('COMMIT');
      return undefined;
    }
    // Neo 2: đếm hai cửa sổ trượt — SAU statement khoá, đúng lý do của login.
    const window = await client.query<{ short_count: number; hour_count: number }>(
      `SELECT count(*) FILTER (WHERE created_at > now() - make_interval(secs => $3))::int AS short_count,
              count(*) FILTER (WHERE created_at > now() - make_interval(secs => $4))::int AS hour_count
         FROM account.otp_challenges
        WHERE address_hash = $1 AND purpose = $2`,
      [
        params.addressKey,
        OTP_PURPOSE_VERIFY_EMAIL,
        params.rateShortWindowSeconds,
        params.rateHourWindowSeconds,
      ],
    );
    const windowRow = window.rows[0];
    if (
      (windowRow?.short_count ?? 0) >= VERIFY_EMAIL_RATE_SHORT_MAX ||
      (windowRow?.hour_count ?? 0) >= VERIFY_EMAIL_RATE_HOUR_MAX
    ) {
      await client.query('COMMIT');
      return undefined;
    }
    // Consume hàng active ngoài cooldown — hàng sinh ra trong cooldown là của
    // request khác thắng gần đây, không cướp.
    await client.query(
      `UPDATE account.otp_challenges
          SET consumed_at = now()
        WHERE address_hash = $1 AND purpose = $2 AND consumed_at IS NULL
          AND created_at <= now() - ($3 * interval '1 second')`,
      [params.addressKey, OTP_PURPOSE_VERIFY_EMAIL, params.resendCooldownSeconds],
    );
    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO account.otp_challenges (address_hash, code_digest, purpose, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, expires_at`,
      [params.addressKey, params.digest, OTP_PURPOSE_VERIFY_EMAIL, params.expiresAt],
    );
    await client.query('COMMIT');
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('otp_challenges: verify_email insert returned no row');
    }
    return { id: row.id, expiresAt: row.expires_at };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Hàng challenge active đọc ra cho verify. */
export interface ActiveVerifyChallengeRow {
  readonly id: string;
  readonly code_digest: string;
  readonly attempts: number;
  readonly expires_at: Date;
}

/** Challenge `verify_email` active của một địa chỉ, hoặc `null`. */
export async function findActiveVerifyChallenge(
  pool: QueryablePool,
  addressKey: AddressKey,
): Promise<ActiveVerifyChallengeRow | null> {
  const result = await pool.query<ActiveVerifyChallengeRow>(
    `SELECT id, code_digest, attempts, expires_at
       FROM account.otp_challenges
      WHERE address_hash = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [addressKey, OTP_PURPOSE_VERIFY_EMAIL],
  );
  return result.rows[0] ?? null;
}

/**
 * Khoá nguyên tử challenge hết hạn — cùng hình thức `expireChallengeIfExpired`
 * của login, fix cứng purpose `verify_email`. Hygiene vòng đời: hàng hết hạn
 * không được đứng ở trạng thái "active theo ràng buộc" mãi.
 */
export async function expireVerifyChallengeIfExpired(
  pool: QueryablePool,
  addressKey: AddressKey,
  nowMs: number,
): Promise<number> {
  const result = await pool.query(
    `UPDATE account.otp_challenges
        SET consumed_at = now()
      WHERE address_hash = $1 AND purpose = $2
        AND consumed_at IS NULL
        AND expires_at <= $3`,
    [addressKey, OTP_PURPOSE_VERIFY_EMAIL, new Date(nowMs)],
  );
  return result.rowCount ?? 0;
}

/**
 * Consume challenge — CAS theo điều kiện `consumed_at IS NULL`, đúng hình thức
 * `consumeChallenge` của login. Replay một mã đã dùng không verify hai lần.
 */
export async function consumeVerifyChallenge(
  pool: QueryablePool,
  challengeId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE account.otp_challenges
        SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL`,
    [challengeId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Tăng `attempts` và khoá ngay khi đạt trần — **một** câu UPDATE, cùng lập luận
 * với `recordFailedAttemptAndLock` của login: nếu khoá là UPDATE riêng chạy
 * sau, lần thử chạm trần và lần thử trần+1 chen vào đó và tăng tiếp. Trần verify
 * email là hằng riêng ({@link VERIFY_EMAIL_MAX_ATTEMPTS}) chứ không đọc hằng login.
 */
export async function recordVerifyFailedAttemptAndLock(
  pool: QueryablePool,
  challengeId: string,
): Promise<number | null> {
  const result = await pool.query<{ attempts: number }>(
    `UPDATE account.otp_challenges
        SET attempts = attempts + 1,
            consumed_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE consumed_at END
      WHERE id = $1 AND consumed_at IS NULL
      RETURNING attempts`,
    [challengeId, VERIFY_EMAIL_MAX_ATTEMPTS],
  );
  const row = result.rows[0];
  return row === undefined ? null : row.attempts;
}
