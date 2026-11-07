/**
 * Test policy + helpers của luồng login — thuần (không DB): matrix ghim TTL,
 * entropy, PKCE challenge theo RFC 7636, và cookie attributes. Hợp đồng
 * consume-atomic (DELETE … RETURNING) được phủ bởi integration suite khi có
 * Docker; ở đây ghim **câu SQL** mà consumer chạy để hai lớp test không kéo
 * nhau sai.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  LOGIN_FLOW_COOKIE_NAME,
  LOGIN_FLOW_TTL_SECONDS,
  clearLoginFlowCookie,
  codeChallenge,
  createFlowValue,
  hashFlowIdentifier,
  loginFlowCookie,
} from './login-flow';

describe('login flow policy constants', () => {
  it('pins the 10-minute TTL matching the auth interaction window', () => {
    expect(LOGIN_FLOW_TTL_SECONDS).toBe(600);
  });

  it('pins the single-use login cookie name', () => {
    expect(LOGIN_FLOW_COOKIE_NAME).toBe('__Host-backoffice-login');
  });
});

describe('createFlowValue', () => {
  it('encodes 32 random bytes as base64url without padding', () => {
    const value = createFlowValue();
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('is deterministic when the caller provides the entropy', () => {
    const entropy = new Uint8Array(32).fill(7);
    expect(createFlowValue(entropy)).toBe(createFlowValue(entropy));
  });

  it('draws from the CSPRNG by default (two calls differ)', () => {
    expect(createFlowValue()).not.toBe(createFlowValue());
  });
});

describe('codeChallenge', () => {
  it('is BASE64URL(SHA-256(verifier)) per RFC 7636 §4.2 (S256)', async () => {
    const verifier = 'test-verifier-with-fixed-content';
    const expected = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    expect(await codeChallenge(verifier)).toBe(expected);
  });

  it('produces a challenge with no padding characters', async () => {
    const challenge = await codeChallenge(createFlowValue());
    expect(challenge).not.toContain('=');
    expect(challenge).not.toContain('+');
    expect(challenge).not.toContain('/');
  });
});

describe('hashFlowIdentifier', () => {
  it('is the SHA-256 hex of the cookie value', async () => {
    const identifier = 'flow-cookie-value';
    const expected = createHash('sha256').update(identifier, 'utf8').digest('hex');
    expect(await hashFlowIdentifier(identifier)).toBe(expected);
  });

  it('differs for different identifiers', async () => {
    expect(await hashFlowIdentifier('a')).not.toBe(await hashFlowIdentifier('b'));
  });
});

describe('loginFlowCookie', () => {
  it('carries __Host-, HttpOnly, Secure, SameSite=Lax and the TTL', () => {
    const cookie = loginFlowCookie('flow-value');
    expect(cookie).toContain(`${LOGIN_FLOW_COOKIE_NAME}=flow-value`);
    expect(cookie).toContain(`Max-Age=${LOGIN_FLOW_TTL_SECONDS}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
  });
});

describe('clearLoginFlowCookie', () => {
  it('expires the cookie while keeping the attributes', () => {
    const cookie = clearLoginFlowCookie();
    expect(cookie).toContain(`${LOGIN_FLOW_COOKIE_NAME}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });
});
