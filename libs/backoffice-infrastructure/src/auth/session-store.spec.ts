/**
 * Test policy + helpers của session store BFF — thuần (không DB): matrix ghim
 * TTL, two-values-one-hash, live/dead matrix của `isSessionLive`, cookie
 * attributes và double-submit CSRF. Hợp đồng SQL của insert/touch/revoke được
 * phủ integration khi có Docker; ở đây ghim policy mà middleware authn dựa
 * vào.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_SECONDS,
  createCsrfToken,
  createSessionIdentifier,
  csrfCookie,
  csrfMatches,
  clearCsrfCookie,
  clearSessionCookie,
  hashSessionIdentifier,
  isSessionLive,
  sessionCookie,
  sessionDeadlines,
} from './session-store';
import type { BackofficeSessionRow } from './session-store';

const IDLE = SESSION_IDLE_SECONDS * 1000;
const ABSOLUTE = SESSION_ABSOLUTE_SECONDS * 1000;

describe('session policy constants', () => {
  it('pins the 12-hour idle and 7-day absolute windows', () => {
    expect(SESSION_IDLE_SECONDS).toBe(12 * 3600);
    expect(SESSION_ABSOLUTE_SECONDS).toBe(7 * 24 * 3600);
  });

  it('pins the __Host- cookie names and CSRF header', () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-backoffice-session');
    expect(CSRF_COOKIE_NAME).toBe('__Host-backoffice-csrf');
    expect(CSRF_HEADER_NAME).toBe('x-ecoma-csrf');
  });
});

describe('createSessionIdentifier / createCsrfToken', () => {
  it('encodes 32 random bytes as base64url without padding', () => {
    expect(createSessionIdentifier()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(createCsrfToken()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('is deterministic when the caller provides the entropy', () => {
    const entropy = new Uint8Array(32).fill(9);
    expect(createSessionIdentifier(entropy)).toBe(createSessionIdentifier(entropy));
  });

  it('draws from the CSPRNG by default (two calls differ)', () => {
    expect(createSessionIdentifier()).not.toBe(createSessionIdentifier());
    expect(createCsrfToken()).not.toBe(createCsrfToken());
  });
});

describe('hashSessionIdentifier', () => {
  it('is the SHA-256 hex of the cookie value — two values, one hash', async () => {
    const identifier = 'session-cookie-value';
    const expected = createHash('sha256').update(identifier, 'utf8').digest('hex');
    expect(await hashSessionIdentifier(identifier)).toBe(expected);
    expect(await hashSessionIdentifier(identifier)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('sessionDeadlines', () => {
  it('takes both deadlines from the caller clock at creation', () => {
    const now = 1_700_000_000_000;
    const deadlines = sessionDeadlines(now);
    expect(deadlines.idleExpiresAtMs).toBe(now + IDLE);
    expect(deadlines.absoluteExpiresAtMs).toBe(now + ABSOLUTE);
  });
});

describe('isSessionLive', () => {
  const created = new Date(1_700_000_000_000);

  function row(overrides: Partial<BackofficeSessionRow> = {}): BackofficeSessionRow {
    return {
      id_hash: '0'.repeat(64),
      account_sub: `sub_${'a'.repeat(32)}`,
      access_token: 'at',
      refresh_token: null,
      auth_time: null,
      acr: null,
      created_at: created,
      expires_at: new Date(created.getTime() + IDLE),
      revoked_at: null,
      ...overrides,
    };
  }

  it('is live inside both windows and unrevoked', () => {
    expect(isSessionLive(row(), created.getTime() + IDLE - 1)).toBe(true);
  });

  it('dies at the idle boundary (expires_at is the sliding idle deadline)', () => {
    expect(isSessionLive(row(), created.getTime() + IDLE)).toBe(false);
  });

  it('dies past the absolute lifetime even when a touch slid expires_at forward', () => {
    const touched = row({ expires_at: new Date(created.getTime() + IDLE * 2) });
    expect(isSessionLive(touched, created.getTime() + ABSOLUTE)).toBe(false);
  });

  it('stays alive up to the last millisecond before the absolute deadline', () => {
    // Touches liên tục trượt expires_at qua mốc absolute — absolute là ràng
    // buộc còn sống cuối cùng, không phải expires_at.
    const touched = row({ expires_at: new Date(created.getTime() + ABSOLUTE + IDLE) });
    expect(isSessionLive(touched, created.getTime() + ABSOLUTE - 1)).toBe(true);
  });

  it('dies when revoked regardless of remaining windows', () => {
    const revoked = row({ revoked_at: new Date(created.getTime() + 1) });
    expect(isSessionLive(revoked, created.getTime() + 2)).toBe(false);
  });
});

describe('sessionCookie / clearSessionCookie', () => {
  it('carries every __Host- attribute with the absolute Max-Age', () => {
    const cookie = sessionCookie('cookie-value');
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=cookie-value`);
    expect(cookie).toContain(`Max-Age=${SESSION_ABSOLUTE_SECONDS}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Domain=');
  });

  it('expires the cookie while keeping the attributes', () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });
});

describe('csrfCookie / clearCsrfCookie', () => {
  it('is readable by client JS (no HttpOnly) for double-submit echo', () => {
    const cookie = csrfCookie('csrf-value');
    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=csrf-value`);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('HttpOnly');
  });

  it('expires the csrf cookie with the same attributes minus HttpOnly', () => {
    const cookie = clearCsrfCookie();
    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).not.toContain('HttpOnly');
  });
});

describe('csrfMatches', () => {
  it('accepts the exact echo', () => {
    expect(csrfMatches('token-1', 'token-1')).toBe(true);
  });

  it('rejects a missing cookie or header', () => {
    expect(csrfMatches(undefined, 'token-1')).toBe(false);
    expect(csrfMatches('token-1', undefined)).toBe(false);
    expect(csrfMatches(undefined, undefined)).toBe(false);
  });

  it('rejects empty or mismatched values', () => {
    expect(csrfMatches('', 'token-1')).toBe(false);
    expect(csrfMatches('token-1', 'token-2')).toBe(false);
    expect(csrfMatches('token-1', 'token-11')).toBe(false);
  });
});
