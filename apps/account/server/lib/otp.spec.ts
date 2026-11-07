/**
 * Unit test cho `server/lib/otp.ts` — policy hằng, sinh mã không bias, digest
 * keyed-HMAC, so sánh timing-safe, rate limit và phân loại mục tiêu.
 *
 * Mọi hàm persistence (`findActiveChallenge`, `insertChallenge`, ...) được integration
 * test trên PostgreSQL thật (testcontainers); ở đây chỉ test phần **thuần** — những
 * hàm mà một sai sót không thể thấy bằng đọc code: bias của mã, thời gian so sánh,
 * và biên của rate limit.
 */

import { describe, expect, it } from 'vitest';

import {
  createOtpChallenge,
  drawUnbiasedCode,
  emailAddressHash,
  isRateLimited,
  isResendBlocked,
  isUniqueViolation,
  MAX_OTP_ATTEMPTS,
  normalizeAndHashEmail,
  normalizeEmailAddress,
  OTP_CODE_DIGITS,
  OTP_RATE_LIMIT_HOUR_MAX,
  OTP_RATE_LIMIT_HOUR_WINDOW_SECONDS,
  OTP_RATE_LIMIT_SHORT_MAX,
  OTP_RATE_LIMIT_SHORT_WINDOW_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  otpDigest,
  resolveOtpTarget,
  timingSafeDigestEqual,
} from './otp';

/** Secret đủ dài cho HMAC — giá trị không quan trọng, chỉ cần ổn định trong test. */
const TEST_KEY = 'unit-test-hmac-key-not-a-real-secret';

/** SHA-256("user@example.com") — vector tính sẵn để neo thuật toán hash. */
const KNOWN_SHA256_USER_EXAMPLE_COM =
  'b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514';

describe('OTP policy constants', () => {
  it('locks the task-mandated policy numbers', () => {
    // Các con số này là hợp đồng với nhiệm vụ (TTL 10 phút, cooldown 60s, trần
    // 5 lần thử, limit 3/15 phút + 10/giờ) và với migration (CHECK purpose):
    // đổi một con số phải là thay đổi có chủ đích, thấy được ở test này.
    expect(OTP_TTL_SECONDS).toBe(600);
    expect(OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
    expect(MAX_OTP_ATTEMPTS).toBe(5);
    expect(OTP_RATE_LIMIT_SHORT_MAX).toBe(3);
    expect(OTP_RATE_LIMIT_SHORT_WINDOW_SECONDS).toBe(900);
    expect(OTP_RATE_LIMIT_HOUR_MAX).toBe(10);
    expect(OTP_RATE_LIMIT_HOUR_WINDOW_SECONDS).toBe(3600);
    expect(OTP_CODE_DIGITS).toBe(8);
  });
});

describe('normalizeEmailAddress', () => {
  it('lowercases and trims the address', () => {
    expect(normalizeEmailAddress('  User@Example.COM ')).toBe('user@example.com');
  });

  it('is idempotent', () => {
    const once = normalizeEmailAddress('Mixed@Example.com');
    expect(normalizeEmailAddress(once)).toBe(once);
  });

  it('keeps inner spacing and plus-addressing intact', () => {
    // Normalize ĐƠN GIẢN có chủ đích: không bỏ dấu chấm kiểu Gmail, không cắt
    // plus-tag — đó là policy của provider, không phải của ta.
    expect(normalizeEmailAddress('first.last+tag@Example.com')).toBe('first.last+tag@example.com');
  });
});

describe('emailAddressHash', () => {
  it('is the SHA-256 hex of the normalized address', async () => {
    // Neo vector thật: mọi thay đổi thuật toán (shorthand, salt, ...) phải qua test này.
    expect(await emailAddressHash('user@example.com')).toBe(KNOWN_SHA256_USER_EXAMPLE_COM);
  });

  it('produces 64 lowercase hex characters', async () => {
    const { hash } = await normalizeAndHashEmail('someone@example.org');
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('collapses case and surrounding whitespace into one lookup key', async () => {
    const left = await normalizeAndHashEmail('User@Example.COM');
    const right = await normalizeAndHashEmail('  user@example.com  ');
    expect(left).toEqual(right);
  });
});

describe('createOtpChallenge', () => {
  it('pads codes below 10^7 with leading zeros', async () => {
    // Mã 1234567 phải ra "01234567": so sánh số học sẽ mất toàn bộ không gian
    // 0xxxxxxx (10% của tổng) — đúng loại bug mà padStart tồn tại để tránh.
    const { code } = await createOtpChallenge(TEST_KEY, 'login', () => 1_234_567);
    expect(code).toBe('01234567');
  });

  it('uses the caller-provided random source verbatim', async () => {
    const { code } = await createOtpChallenge(TEST_KEY, 'login', () => 42);
    expect(code).toBe('00000042');
  });

  it('produces a distinct digest per key', async () => {
    const { code } = await createOtpChallenge(TEST_KEY, 'login', () => 7);
    const other = await otpDigest('another-key', 'login', code);
    expect(other).not.toBe(await otpDigest(TEST_KEY, 'login', code));
  });

  it('binds the purpose into the digest (domain separation)', async () => {
    // Cùng mã ở hai purpose phải là hai digest: nếu không, một challenge purpose
    // khác trong tương lai tái dùng được digest của challenge login.
    const loginDigest = await otpDigest(TEST_KEY, 'login', '12345678');
    const otherPurpose = await otpDigest(TEST_KEY, 'verify-email', '12345678');
    expect(loginDigest).not.toBe(otherPurpose);
  });

  it('is deterministic for the same key and code', async () => {
    const first = await otpDigest(TEST_KEY, 'login', '00000001');
    const second = await otpDigest(TEST_KEY, 'login', '00000001');
    expect(first).toBe(second);
  });

  it('returns a 64-character lowercase hex digest', async () => {
    const { digest } = await createOtpChallenge(TEST_KEY, 'login', () => 1);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('drawUnbiasedCode', () => {
  it('always returns exactly 8 digits', () => {
    for (let i = 0; i < 200; i++) {
      expect(drawUnbiasedCode()).toMatch(/^\d{8}$/u);
    }
  });

  it('draws from the CSPRNG, so repeated calls do not repeat codes', () => {
    // Không phải một test phân bố, chỉ là smoke test entropy: 200 lần rút trùng
    // nhau hàng loạt là dấu hiệu CSPRNG bị thay bằng nguồn tất định.
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      codes.add(drawUnbiasedCode());
    }
    // Xác suất một cặp trùng trong 200 rút từ 10^8 là ~0.02% — một trùng lẻ là
    // birthday paradox, nhiều trùng là hỏng.
    expect(codes.size).toBeGreaterThan(190);
  });

  it('can return codes in the leading-zero decade of the space', () => {
    // Vết của leading-zero: với 200 mẫu, phải thấy mã bắt đầu bằng '0' theo tỷ lệ
    // xấp xỉ 10%. Test nghẽn "mã luôn >= 10^7" — sai lầm của so sánh số học.
    let leadingZero = 0;
    for (let i = 0; i < 200; i++) {
      if (drawUnbiasedCode().startsWith('0')) {
        leadingZero += 1;
      }
    }
    // Biên cho phép rộng: chỉ bắt dạng "không bao giờ" và "luôn luôn".
    expect(leadingZero).toBeGreaterThan(2);
    expect(leadingZero).toBeLessThan(60);
  });
});

describe('timingSafeDigestEqual', () => {
  it('accepts equal digests', () => {
    expect(timingSafeDigestEqual('ab'.repeat(32), 'ab'.repeat(32))).toBe(true);
  });

  it('rejects a digest differing in the first byte', () => {
    expect(timingSafeDigestEqual('ab'.repeat(32), 'bb' + 'ab'.repeat(31))).toBe(false);
  });

  it('rejects a digest differing in the last byte', () => {
    expect(timingSafeDigestEqual('ab'.repeat(32), 'ab'.repeat(31) + 'bb')).toBe(false);
  });

  it('rejects different lengths without scanning', () => {
    expect(timingSafeDigestEqual('ab'.repeat(32), 'ab'.repeat(31))).toBe(false);
  });

  it('rejects every differing byte position, not only the first', () => {
    // Không đo thời gian trong unit test (flaky); thay vào đó assert nguyên tắc
    // của hàm: XOR của MỌI byte được OR vào một accumulator, nên một hàm đúng
    // trả false cho cả hai vị trí. Chứng minh timing thật là việc của review +
    // phân tích code, không phải của assertion này.
    const a = '0'.repeat(64);
    const firstByteDiffers = '1' + '0'.repeat(63);
    const lastByteDiffers = '0'.repeat(63) + '1';
    expect(timingSafeDigestEqual(a, firstByteDiffers)).toBe(false);
    expect(timingSafeDigestEqual(a, lastByteDiffers)).toBe(false);
  });
});

describe('isRateLimited', () => {
  it('blocks at exactly the short-window cap', () => {
    expect(isRateLimited(OTP_RATE_LIMIT_SHORT_MAX - 1, 0)).toBe(false);
    expect(isRateLimited(OTP_RATE_LIMIT_SHORT_MAX, 0)).toBe(true);
  });

  it('blocks at exactly the hour cap', () => {
    expect(isRateLimited(0, OTP_RATE_LIMIT_HOUR_MAX - 1)).toBe(false);
    expect(isRateLimited(0, OTP_RATE_LIMIT_HOUR_MAX)).toBe(true);
  });

  it('blocks when either window is at its cap', () => {
    expect(isRateLimited(OTP_RATE_LIMIT_SHORT_MAX, OTP_RATE_LIMIT_HOUR_MAX)).toBe(true);
  });

  it('passes below both caps', () => {
    expect(isRateLimited(0, 0)).toBe(false);
    expect(isRateLimited(2, 9)).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('recognizes the PostgreSQL 23505 error code', () => {
    // Lỗi thật của driver `pg` mang `code: '23505'` — route challenge dựa vào đó
    // để biến thua race consume-then-insert thành silently_rejected thay vì 503.
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('rejects other database errors and non-error values', () => {
    expect(isUniqueViolation({ code: '23505 ' })).toBe(false);
    expect(isUniqueViolation({ code: '08006' })).toBe(false);
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('isResendBlocked', () => {
  it('blocks inside the cooldown window', () => {
    const now = 1_000_000;
    expect(isResendBlocked(new Date(now - 59_999), now)).toBe(true);
  });

  it('allows exactly at the cooldown boundary', () => {
    const now = 1_000_000;
    expect(isResendBlocked(new Date(now - 60_000), now)).toBe(false);
  });

  it('allows well past the cooldown', () => {
    const now = 1_000_000;
    expect(isResendBlocked(new Date(now - 301_000), now)).toBe(false);
  });
});

describe('resolveOtpTarget', () => {
  const verifiedLookup = {
    emailId: 'email-1',
    userSub: 'sub-1',
    accountStatus: 'active',
  };

  it('returns verified for an active account with a verified address', () => {
    expect(resolveOtpTarget(verifiedLookup)).toMatchObject({ kind: 'verified' });
  });

  it('returns unknown_or_unusable for a null lookup', () => {
    expect(resolveOtpTarget(null)).toEqual({ kind: 'unknown_or_unusable' });
  });

  it('is fail-closed for suspended accounts', () => {
    // suspended/deleted và mọi giá trị lạ cùng về unknown_or_unusable — cùng kết
    // quả phát hành, đúng hợp đồng FR-011d.
    expect(resolveOtpTarget({ ...verifiedLookup, accountStatus: 'suspended' })).toEqual({
      kind: 'unknown_or_unusable',
    });
  });

  it('is fail-closed for deleted accounts', () => {
    expect(resolveOtpTarget({ ...verifiedLookup, accountStatus: 'deleted' })).toEqual({
      kind: 'unknown_or_unusable',
    });
  });

  it('is fail-closed for unknown status values', () => {
    expect(resolveOtpTarget({ ...verifiedLookup, accountStatus: 'whatever' })).toEqual({
      kind: 'unknown_or_unusable',
    });
  });

  it('never leaks the discriminator payload on the reject path', () => {
    // Kết quả từ chối phải là object rỗng ngoài `kind`: không emailId, không sub —
    // thứ duy nhất mà response có thể phản ánh mà không lộ thông tin.
    const rejected = resolveOtpTarget({ ...verifiedLookup, accountStatus: 'suspended' });
    expect(Object.keys(rejected)).toEqual(['kind']);
  });
});
