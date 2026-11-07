import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_MESSAGES, domainError, isDomainError, type DomainErrorCode } from './errors';

const ALL_CODES = Object.keys(DOMAIN_ERROR_MESSAGES) as DomainErrorCode[];

describe('domainError', () => {
  it('returns a stable code with a short Vietnamese message', () => {
    const error = domainError('session_expired');
    expect(error.code).toBe('session_expired');
    expect(error.message).toBe('Phiên đã hết hạn.');
  });

  it('gives every taxonomy code a non-empty message', () => {
    for (const code of ALL_CODES) {
      const error = domainError(code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).toBe(DOMAIN_ERROR_MESSAGES[code]);
    }
  });

  it('is deterministic: the same code always yields the same object shape', () => {
    for (const code of ALL_CODES) {
      expect(domainError(code)).toEqual(domainError(code));
    }
  });

  it('carries only code and message — no field for secrets or identifiers', () => {
    // Bảo vệ invariant 9 (không log cookie/token/handle/code_verifier): error đi
    // thẳng ra log và ra response, nên nó không được mang thêm chỗ cho dữ liệu.
    for (const code of ALL_CODES) {
      const keys = Object.keys(domainError(code));
      expect(keys).toHaveLength(2);
      expect(keys).toContain('code');
      expect(keys).toContain('message');
    }
  });

  it('rejects a code outside the taxonomy', () => {
    expect(() => domainError('nope' as DomainErrorCode)).toThrow(TypeError);
  });

  it('does not let a caller smuggle data through the message', () => {
    // Không có tham số tuỳ ý nào ở đây — đó là chủ ý, xem JSDoc module.
    expect(domainError.length).toBe(1);
  });
});

describe('DOMAIN_ERROR_MESSAGES', () => {
  it('covers the codes the identity domain actually raises', () => {
    expect(ALL_CODES).toContain('invalid_subject');
    expect(ALL_CODES).toContain('session_expired');
    expect(ALL_CODES).toContain('session_revoked');
    expect(ALL_CODES).toContain('reauthentication_required');
    expect(ALL_CODES).toContain('acr_insufficient');
    expect(ALL_CODES).toContain('account_deleted');
    expect(ALL_CODES).toContain('account_suspended');
    expect(ALL_CODES).toContain('invalid_transition');
  });
});

describe('isDomainError', () => {
  it('accepts an error built by domainError', () => {
    for (const code of ALL_CODES) {
      expect(isDomainError(domainError(code))).toBe(true);
    }
  });

  it.each([
    ['a plain object with an unknown code', { code: 'not_a_code', message: 'x' }],
    ['a plain object with no code', { message: 'x' }],
    ['a string', 'session_expired'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['an Error instance', new Error('boom')],
  ])('rejects %s', (_label, value) => {
    expect(isDomainError(value)).toBe(false);
  });

  it.each([['toString'], ['constructor'], ['hasOwnProperty']])(
    'rejects an object whose code is the inherited Object.prototype key %s',
    (code) => {
      // `in` sẽ đi prototype chain và trả true sai cho những key này; guard phải
      // chỉ nhìn own property của taxonomy.
      expect(isDomainError({ code, message: 'x' })).toBe(false);
    },
  );
});
