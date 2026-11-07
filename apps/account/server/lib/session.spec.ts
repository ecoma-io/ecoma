/**
 * Unit test cho `server/lib/session.ts` — phần thuần: identifier/token, hash,
 * mốc thời gian, cookie builder và double-submit CSRF.
 *
 * Các hàm persistence (`insertAuthenticatedSession`, `touchSession`, ...) chạy
 * trong integration test (testcontainers) vì giá trị của chúng nằm ở transaction
 * và hàng thật trong PostgreSQL.
 */

import { describe, expect, it } from 'vitest';

import { ACR } from '@ecoma-io/account-domain';

import { LOGIN_HANDOFF_TTL_SECONDS } from './handoff';

import {
  ANONYMOUS_SESSION_TTL_SECONDS,
  createCsrfToken,
  createSessionIdentifier,
  csrfCookie,
  clearCsrfCookie,
  csrfMatches,
  clearSessionCookie,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_SECONDS,
  sessionCookie,
  sessionDeadlines,
  OTP_ACR,
  isSessionLive,
} from './session';

describe('session policy constants', () => {
  it('locks the task-mandated windows and cookie names', () => {
    // Idle 12h, absolute 7d, cookie `__Host-` — hợp đồng của nhiệm vụ; đổi số
    // hay tên cookie phải qua test này.
    expect(SESSION_IDLE_SECONDS).toBe(12 * 3600);
    expect(SESSION_ABSOLUTE_SECONDS).toBe(7 * 24 * 3600);
    expect(SESSION_COOKIE_NAME).toBe('__Host-account-session');
    expect(CSRF_COOKIE_NAME).toBe('__Host-account-csrf');
    expect(CSRF_HEADER_NAME).toBe('x-ecoma-csrf');
  });

  it('pins the OTP ACR to the domain-lib constant', () => {
    // Không string literal tại call site: cột `acr` nhận đúng URN từ ACR lib —
    // nếu lib đổi cách biểu diễn, test này bắt ngay.
    expect(OTP_ACR).toBe(ACR.EmailOtp);
    expect(OTP_ACR).toBe('urn:ecoma:acr:email-otp');
  });

  it('pins the anonymous session TTL to the same 10-minute mark as the handoff binding', () => {
    // Session anonymous chỉ là vật chứa của binding handoff (FR-006c): TTL của
    // nó cùng mốc 10 phút với `LOGIN_HANDOFF_TTL_SECONDS` — binding không sống
    // sót quá container session trình nó. Đổi một trong hai mốc mà không đổi
    // mốc kia là hỏng cặp bất biến này; test này buộc hai bên cùng biết.
    expect(ANONYMOUS_SESSION_TTL_SECONDS).toBe(600);
    expect(ANONYMOUS_SESSION_TTL_SECONDS).toBe(LOGIN_HANDOFF_TTL_SECONDS);
  });
});

describe('createSessionIdentifier', () => {
  it('encodes 32 random bytes as base64url without padding', () => {
    const identifier = createSessionIdentifier();
    // 32 byte → 43 ký tự base64url (256 bit entropy, FR-004).
    expect(identifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('is base64url, not plain base64', () => {
    // Feed byte buộc xuất hiện '+', '/', '=' trong base64 thuần để chắc phép
    // chuyển đổi làm sạch chúng.
    const bytes = new Uint8Array(32).fill(0xff);
    const identifier = createSessionIdentifier(bytes);
    expect(identifier).not.toMatch(/[+/=]/u);
    expect(identifier.length).toBe(43);
  });

  it('is deterministic when the caller provides the entropy', () => {
    const bytes = new Uint8Array(32).map((_, i) => i);
    expect(createSessionIdentifier(bytes)).toBe(createSessionIdentifier(bytes));
  });

  it('draws from the CSPRNG by default (two calls differ)', () => {
    expect(createSessionIdentifier()).not.toBe(createSessionIdentifier());
  });
});

describe('createCsrfToken', () => {
  it('has the same 256-bit shape as the session identifier', () => {
    expect(createCsrfToken()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});

describe('hashSessionIdentifier', () => {
  it('is the SHA-256 hex of the identifier', async () => {
    // Vector neo: SHA-256 của một base64url 43 ký tự — thứ được ghi DB phải là
    // hex 64, không phải identifier, không phải base64.
    const identifier = 'a'.repeat(43);
    const { createHash } = (await import('node:crypto')) as typeof import('node:crypto');
    const expected = createHash('sha256').update(identifier).digest('hex');
    const { hashSessionIdentifier } = await import('./session');
    expect(await hashSessionIdentifier(identifier)).toBe(expected);
  });
});

describe('sessionDeadlines', () => {
  it('stores the idle deadline in expires_at and keeps absolute pinned to created_at', () => {
    const now = 1_700_000_000_000;
    const createdAt = now - 3 * 24 * 3600_000;
    const deadlines = sessionDeadlines(now, createdAt);
    expect(deadlines.idleExpiresAtMs).toBe(now + SESSION_IDLE_SECONDS * 1000);
    // Absolute = created_at + 7d, KHÔNG trượt theo now — đây là điểm phân biệt
    // hai khái niệm; sai ở đây là session sống vô hạn khi được dùng liên tục.
    expect(deadlines.absoluteExpiresAtMs).toBe(createdAt + SESSION_ABSOLUTE_SECONDS * 1000);
  });
});

describe('isSessionLive', () => {
  const created = new Date(1_700_000_000_000);
  const hour = 3600_000;

  const row = (overrides: {
    expires_at?: Date;
    revoked_at?: Date | null;
    created_at?: Date;
  }): { expires_at: Date; created_at: Date; revoked_at: Date | null } => ({
    expires_at: new Date(created.getTime() + 2 * hour),
    created_at: created,
    revoked_at: null,
    ...overrides,
  });

  it('is live inside both windows and unrevoked', () => {
    expect(isSessionLive(row(), created.getTime() + hour)).toBe(true);
  });

  it('dies at the idle boundary', () => {
    expect(isSessionLive(row(), created.getTime() + 2 * hour)).toBe(false);
  });

  it('dies past the absolute lifetime even when idle keeps sliding', () => {
    // Sliding expiry mới (luôn sống theo idle) nhưng đã 8 ngày từ created_at:
    // absolute chặn — test nghẽn bug "expires_at trượt và kéo theo absolute".
    const expires_at = new Date(created.getTime() + 8 * 24 * hour);
    const eightDaysLater = created.getTime() + 8 * 24 * hour + hour;
    expect(isSessionLive(row({ expires_at }), eightDaysLater)).toBe(false);
  });

  it('stays alive up to the last millisecond before the absolute deadline', () => {
    const expires_at = new Date(created.getTime() + 8 * 24 * hour);
    const justBefore = created.getTime() + SESSION_ABSOLUTE_SECONDS * 1000 - 1;
    expect(isSessionLive(row({ expires_at }), justBefore)).toBe(true);
  });

  it('dies when revoked regardless of remaining windows', () => {
    const revoked = row({ revoked_at: new Date(created.getTime() + hour) });
    expect(isSessionLive(revoked, created.getTime() + hour + 1)).toBe(false);
  });
});

describe('sessionCookie', () => {
  it('carries every FR-004 attribute', () => {
    const cookie = sessionCookie('opaque-value');
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=opaque-value`);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain');
    // Max-Age = absolute lifetime: cookie chết cùng mốc absolute kể cả idle refresh.
    expect(cookie).toContain(`Max-Age=${SESSION_ABSOLUTE_SECONDS}`);
  });
});

describe('clearSessionCookie', () => {
  it('expires the cookie while keeping the attributes', () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });
});

describe('csrfCookie', () => {
  it('is readable by client JS (no HttpOnly) for double-submit echo', () => {
    const cookie = csrfCookie('token-value');
    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=token-value`);
    expect(cookie).not.toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });
});

describe('clearCsrfCookie', () => {
  it('expires the csrf cookie with the same attributes minus HttpOnly', () => {
    const cookie = clearCsrfCookie();
    expect(cookie).toContain(`${CSRF_COOKIE_NAME}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).not.toContain('HttpOnly');
  });
});

describe('csrfMatches', () => {
  it('matches equal values', () => {
    expect(csrfMatches('token', 'token')).toBe(true);
  });

  it('rejects a missing cookie or header', () => {
    expect(csrfMatches(undefined, 'token')).toBe(false);
    expect(csrfMatches('token', undefined)).toBe(false);
    expect(csrfMatches(undefined, undefined)).toBe(false);
  });

  it('rejects empty values', () => {
    expect(csrfMatches('', '')).toBe(false);
  });

  it('rejects mismatched values of equal length', () => {
    expect(csrfMatches('token-a', 'token-b')).toBe(false);
  });

  it('rejects length-mismatched values without a timing oracle concern', () => {
    // So sánh không timing-safe là quyết định có chủ đích (token 256-bit ngẫu
    // nhiên, không phải secret người dùng chọn) — nhưng độ dài lệch vẫn phải bị
    // từ chối ngay.
    expect(csrfMatches('short', 'a-much-longer-value')).toBe(false);
  });
});
