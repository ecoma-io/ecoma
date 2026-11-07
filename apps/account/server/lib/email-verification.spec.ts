/**
 * Unit test cho `server/lib/email-verification.ts` — policy hằng của luồng
 * verify-email và hình dạng branded `AddressKey`.
 *
 * Các hàm persistence (`insertVerifyEmailChallenge`, `consumeVerifyChallenge`
 * ...) được integration test trên PostgreSQL thật; ở đây neo những con số là
 * **hợp đồng policy** (TTL, trần thử, rate limit hai cửa sổ, cooldown) và nguyên
 * tắc **độc lập** với allowance của luồng login.
 */

import { describe, expect, it } from 'vitest';

import {
  addressKeyFromRaw,
  OTP_PURPOSE_VERIFY_EMAIL,
  VERIFY_EMAIL_MAX_ATTEMPTS,
  VERIFY_EMAIL_RATE_HOUR_MAX,
  VERIFY_EMAIL_RATE_HOUR_WINDOW_SECONDS,
  VERIFY_EMAIL_RATE_SHORT_MAX,
  VERIFY_EMAIL_RATE_SHORT_WINDOW_SECONDS,
  VERIFY_EMAIL_RESEND_COOLDOWN_SECONDS,
  VERIFY_EMAIL_TTL_SECONDS,
} from './email-verification';
import {
  MAX_OTP_ATTEMPTS,
  OTP_RATE_LIMIT_HOUR_MAX,
  OTP_RATE_LIMIT_SHORT_MAX,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  normalizeEmailAddress,
  emailAddressHash,
} from './otp';

describe('verify-email policy constants', () => {
  it('locks the v1 policy numbers', () => {
    expect(OTP_PURPOSE_VERIFY_EMAIL).toBe('verify_email');
    expect(VERIFY_EMAIL_TTL_SECONDS).toBe(600);
    expect(VERIFY_EMAIL_MAX_ATTEMPTS).toBe(5);
    expect(VERIFY_EMAIL_RATE_SHORT_MAX).toBe(3);
    expect(VERIFY_EMAIL_RATE_SHORT_WINDOW_SECONDS).toBe(900);
    expect(VERIFY_EMAIL_RATE_HOUR_MAX).toBe(10);
    expect(VERIFY_EMAIL_RATE_HOUR_WINDOW_SECONDS).toBe(3600);
    expect(VERIFY_EMAIL_RESEND_COOLDOWN_SECONDS).toBe(60);
  });

  it('keeps values equal to login only by coincidence, not by reference', () => {
    // Hai luồng cùng chia bảng `otp_challenges` nhưng policy phải **độc lập**:
    // test này cố tình so sánh giá trị (không phải tham chiếu hằng) để nếu một
    // ngày login nới policy mà verify-email không theo, thay đổi đó là có chủ
    // đích và thấy được tại đây.
    expect(VERIFY_EMAIL_TTL_SECONDS).toBe(OTP_TTL_SECONDS);
    expect(VERIFY_EMAIL_MAX_ATTEMPTS).toBe(MAX_OTP_ATTEMPTS);
    expect(VERIFY_EMAIL_RATE_SHORT_MAX).toBe(OTP_RATE_LIMIT_SHORT_MAX);
    expect(VERIFY_EMAIL_RATE_HOUR_MAX).toBe(OTP_RATE_LIMIT_HOUR_MAX);
    expect(VERIFY_EMAIL_RESEND_COOLDOWN_SECONDS).toBe(OTP_RESEND_COOLDOWN_SECONDS);
  });
});

describe('addressKeyFromRaw', () => {
  it('produces the login address_hash for the same normalized address', async () => {
    // Cùng quy ước tra cứu với luồng login: hash của địa chỉ đã normalize. Nếu
    // hai luồng diverge, verify sẽ không tìm thấy challenge của chính nó.
    const key = await addressKeyFromRaw('  User@Example.COM ');
    expect(key).toBe(await emailAddressHash(normalizeEmailAddress('user@example.com')));
  });

  it('returns a 64-char lowercase hex string', async () => {
    const key = await addressKeyFromRaw('someone@example.org');
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
  });
});
