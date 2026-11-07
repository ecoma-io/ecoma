import { describe, expect, it } from 'vitest';

import { ACR, acrSetFor, acrSatisfies, isAcr, isAcrShape } from './acr';
import { isExpired, isFresh, isRevoked, requiresReauthentication } from './session-policy';

/** Mốc thời gian cố định cho mọi case — module này thuần, không đọc đồng hồ. */
const NOW = 1_700_000_000_000;
const SECOND = 1000;

describe('isExpired', () => {
  it('is false strictly before the expiry instant', () => {
    expect(isExpired({ expiresAt: NOW + 1 }, NOW)).toBe(false);
  });

  it('is true at exactly the expiry instant', () => {
    expect(isExpired({ expiresAt: NOW }, NOW)).toBe(true);
  });

  it('is true after the expiry instant', () => {
    expect(isExpired({ expiresAt: NOW - 1 }, NOW)).toBe(true);
  });

  it('ignores revocation when only measuring expiry', () => {
    expect(isExpired({ expiresAt: NOW + SECOND, revokedAt: NOW - SECOND }, NOW)).toBe(false);
  });
});

describe('isRevoked', () => {
  it('is false when never revoked', () => {
    expect(isRevoked({ expiresAt: NOW + SECOND }, NOW)).toBe(false);
  });

  it('is false when revokedAt is explicitly null', () => {
    expect(isRevoked({ expiresAt: NOW + SECOND, revokedAt: null }, NOW)).toBe(false);
  });

  it('is true once the revocation instant is reached', () => {
    expect(isRevoked({ expiresAt: NOW + SECOND, revokedAt: NOW }, NOW)).toBe(true);
  });

  it('is false before a future revocation instant', () => {
    expect(isRevoked({ expiresAt: NOW + SECOND, revokedAt: NOW + SECOND }, NOW)).toBe(false);
  });
});

describe('isFresh', () => {
  it('is true at exactly the max-age boundary', () => {
    expect(isFresh(NOW - 60 * SECOND, NOW, 60)).toBe(true);
  });

  it('is false one millisecond past the boundary', () => {
    expect(isFresh(NOW - 60 * SECOND - 1, NOW, 60)).toBe(false);
  });

  it('is true for an instant authentication', () => {
    expect(isFresh(NOW, NOW, 60)).toBe(true);
  });

  it('is false for evidence from the future', () => {
    expect(isFresh(NOW + 1, NOW, 60)).toBe(false);
  });

  it('is false for a negative max-age, which can never be satisfied', () => {
    expect(isFresh(NOW, NOW, -1)).toBe(false);
  });

  it('is true for a zero max-age at the same instant only', () => {
    expect(isFresh(NOW, NOW, 0)).toBe(true);
    expect(isFresh(NOW - 1, NOW, 0)).toBe(false);
  });
});

describe('requiresReauthentication', () => {
  const freshAuthn = NOW - SECOND;
  const staleAuthn = NOW - 600 * SECOND;

  it('does not require reauthentication when the ACR set contains the required ACR and evidence is fresh', () => {
    expect(
      requiresReauthentication(
        acrSetFor({ emailOtp: true, secondFactor: 'passkey' }),
        freshAuthn,
        NOW,
        {
          requiredAcr: ACR.Mfa,
          maxAgeSeconds: 300,
        },
      ),
    ).toBe(false);
  });

  it('requires reauthentication when the ACR set lacks the required ACR, however fresh', () => {
    expect(
      requiresReauthentication(acrSetFor({ emailOtp: true }), freshAuthn, NOW, {
        requiredAcr: ACR.PhishingResistant,
        maxAgeSeconds: 300,
      }),
    ).toBe(true);
  });

  it('requires reauthentication when the ACR set satisfies but the evidence is stale', () => {
    expect(
      requiresReauthentication(
        acrSetFor({ emailOtp: true, secondFactor: 'passkey' }),
        staleAuthn,
        NOW,
        {
          requiredAcr: ACR.Mfa,
          maxAgeSeconds: 300,
        },
      ),
    ).toBe(true);
  });

  it('requires reauthentication for an empty ACR set against any real ACR', () => {
    expect(
      requiresReauthentication(new Set(), freshAuthn, NOW, {
        requiredAcr: ACR.EmailOtp,
        maxAgeSeconds: 300,
      }),
    ).toBe(true);
  });

  it('does not let email-otp alone satisfy mfa (membership, not ranking)', () => {
    // totp vừa xác thực nhưng yêu cầu passkey -> vẫn phải xác thực lại.
    expect(
      requiresReauthentication(
        acrSetFor({ emailOtp: true, secondFactor: 'totp' }),
        freshAuthn,
        NOW,
        {
          requiredAcr: ACR.PhishingResistant,
          maxAgeSeconds: 300,
        },
      ),
    ).toBe(true);
  });

  it('measures evidence age rather than session age (FR-004b)', () => {
    // `authn_at` cũ nhưng session vẫn sống: vẫn phải xác thực lại.
    expect(
      requiresReauthentication(acrSetFor({ emailOtp: true }), staleAuthn, NOW, {
        requiredAcr: ACR.EmailOtp,
        maxAgeSeconds: 300,
      }),
    ).toBe(true);
  });
});

describe('acrSetFor', () => {
  it('is empty when nothing was completed', () => {
    expect(acrSetFor({}).size).toBe(0);
    expect(acrSetFor({ emailOtp: false, secondFactor: 'totp' }).size).toBe(0);
  });

  it('contains only email-otp after OTP login', () => {
    const set = acrSetFor({ emailOtp: true });
    expect([...set]).toEqual([ACR.EmailOtp]);
  });

  it('adds mfa but not phishing-resistant for TOTP as the second factor', () => {
    const set = acrSetFor({ emailOtp: true, secondFactor: 'totp' });
    expect(acrSatisfies(set, ACR.EmailOtp)).toBe(true);
    expect(acrSatisfies(set, ACR.Mfa)).toBe(true);
    expect(acrSatisfies(set, ACR.PhishingResistant)).toBe(false);
  });

  it('adds mfa and phishing-resistant for passkey as the second factor', () => {
    const set = acrSetFor({ emailOtp: true, secondFactor: 'passkey' });
    expect(acrSatisfies(set, ACR.EmailOtp)).toBe(true);
    expect(acrSatisfies(set, ACR.Mfa)).toBe(true);
    expect(acrSatisfies(set, ACR.PhishingResistant)).toBe(true);
  });

  it('never grants mfa without the OTP base', () => {
    // Yếu tố thứ hai mà không qua OTP không hợp lệ ở tầng policy; nếu vẫn truyền
    // vào thì tập không được tự sinh `mfa` — việc đó thuộc tầng điều phối flow.
    const set = acrSetFor({ emailOtp: false, secondFactor: 'passkey' });
    expect(acrSatisfies(set, ACR.Mfa)).toBe(false);
    expect(acrSatisfies(set, ACR.PhishingResistant)).toBe(false);
  });
});

describe('isAcr / isAcrShape', () => {
  it('accepts every declared ACR URN', () => {
    for (const acr of [ACR.EmailOtp, ACR.Mfa, ACR.PhishingResistant]) {
      expect(isAcr(acr)).toBe(true);
      expect(isAcrShape(acr)).toBe(true);
    }
  });

  it('rejects unknown or malformed values', () => {
    expect(isAcr('urn:ecoma:acr:sms')).toBe(false);
    expect(isAcr('password')).toBe(false);
    expect(isAcr('')).toBe(false);
    expect(isAcr(undefined)).toBe(false);
    expect(isAcrShape('urn:ecoma:acr:')).toBe(false);
    expect(isAcrShape('urn:other:acr:email-otp')).toBe(false);
    expect(isAcrShape('urn:ecoma:acr:Email-Otp')).toBe(false);
  });
});
