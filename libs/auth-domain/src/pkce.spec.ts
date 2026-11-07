import { describe, expect, it } from 'vitest';

import {
  assertValidCodeVerifier,
  computeS256Challenge,
  parseCodeChallenge,
  verifyCodeChallenge,
} from './pkce';
import { OAuthProtocolError } from './errors';

/** Verifier hợp lệ theo RFC 7636: 43 ký tự trong bảng ký tự cho phép. */
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('parseCodeChallenge', () => {
  it('accepts S256 with a 43-character challenge', () => {
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    const parsed = parseCodeChallenge({ codeChallenge: challenge, codeChallengeMethod: 'S256' });
    expect(parsed.codeChallenge).toBe(challenge);
    expect(parsed.codeChallengeMethod).toBe('S256');
  });

  it('rejects plain (FR-010 / AC-007)', () => {
    // PKCE downgrade sang plain la T-03.
    expect(() =>
      parseCodeChallenge({ codeChallenge: VERIFIER, codeChallengeMethod: 'plain' }),
    ).toThrow(OAuthProtocolError);
  });

  it('rejects a missing code_challenge_method — there is no default', () => {
    // Mac dinh ngam la duong downgrade: client cu khong gui method, server cho qua.
    expect(() =>
      parseCodeChallenge({ codeChallenge: VERIFIER, codeChallengeMethod: undefined }),
    ).toThrow(/thieu code_challenge_method/u);
  });

  it('rejects a missing code_challenge', () => {
    expect(() =>
      parseCodeChallenge({ codeChallenge: undefined, codeChallengeMethod: 'S256' }),
    ).toThrow(/thieu code_challenge/u);
  });

  it('rejects a challenge of the wrong length (not 43 characters)', () => {
    expect(() => parseCodeChallenge({ codeChallenge: 'abc', codeChallengeMethod: 'S256' })).toThrow(
      /khong dung dinh dang S256/u,
    );
  });

  it('rejects a challenge with base64 padding', () => {
    expect(() =>
      parseCodeChallenge({ codeChallenge: `${'a'.repeat(42)}=`, codeChallengeMethod: 'S256' }),
    ).toThrow(/khong dung dinh dang S256/u);
  });
});

describe('computeS256Challenge / verifyCodeChallenge', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    // Vector chinh thuc cua RFC: verifier -> challenge.
    const challenge = await computeS256Challenge(VERIFIER);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('the correct verifier against the stored challenge: matches', async () => {
    const challenge = await computeS256Challenge(VERIFIER);
    await expect(
      verifyCodeChallenge({ codeVerifier: VERIFIER, expectedChallenge: challenge }),
    ).resolves.toBe(true);
  });

  it('a wrong verifier: does not match', async () => {
    const challenge = await computeS256Challenge(VERIFIER);
    await expect(
      verifyCodeChallenge({
        codeVerifier: 'yWjZS1sT2FT1RSW1Z1Y1d3R4yWjZS1sT2FT1RSWQ',
        expectedChallenge: challenge,
      }),
    ).resolves.toBe(false);
  });

  it('the challenge is 43 base64url characters with no padding', async () => {
    const challenge = await computeS256Challenge(VERIFIER);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});

describe('assertValidCodeVerifier', () => {
  it('accepts a 43-character verifier', () => {
    expect(() => assertValidCodeVerifier(VERIFIER)).not.toThrow();
  });

  it('accepts a 128-character verifier', () => {
    expect(() => assertValidCodeVerifier('a'.repeat(128))).not.toThrow();
  });

  it('rejects a verifier shorter than 43', () => {
    expect(() => assertValidCodeVerifier('a'.repeat(42))).toThrow(OAuthProtocolError);
  });

  it('rejects a verifier longer than 128', () => {
    expect(() => assertValidCodeVerifier('a'.repeat(129))).toThrow(OAuthProtocolError);
  });

  it('rejects characters outside the RFC 7636 charset', () => {
    // '+' va '/' la base64 chuan, khong thuocc [A-Za-z0-9-._~].
    expect(() => assertValidCodeVerifier(`${'a'.repeat(42)}+`)).toThrow(OAuthProtocolError);
    expect(() => assertValidCodeVerifier(`${'a'.repeat(42)}/`)).toThrow(OAuthProtocolError);
    expect(() => assertValidCodeVerifier(`${'a'.repeat(42)}=`)).toThrow(OAuthProtocolError);
  });

  it('rejects an empty verifier', () => {
    expect(() => assertValidCodeVerifier('')).toThrow(OAuthProtocolError);
  });
});
