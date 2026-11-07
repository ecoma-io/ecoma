/**
 * Ghim taxonomy lỗi: code đóng, message từ bảng, không path nào chèn payload
 * vào error object.
 */

import { describe, expect, it } from 'vitest';

import {
  BACKOFFICE_DOMAIN_ERROR_MESSAGES,
  backofficeDomainError,
  isBackofficeDomainError,
  type BackofficeDomainErrorCode,
} from './errors';

describe('taxonomy is closed and single-source', () => {
  it('has a message for every declared code', () => {
    for (const code of Object.keys(
      BACKOFFICE_DOMAIN_ERROR_MESSAGES,
    ) as BackofficeDomainErrorCode[]) {
      const error = backofficeDomainError(code);
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).toBe(BACKOFFICE_DOMAIN_ERROR_MESSAGES[code]);
    }
  });

  it('rejects unknown codes at build time', () => {
    expect(() => backofficeDomainError('toString' as BackofficeDomainErrorCode)).toThrow(TypeError);
  });

  it('carries only code and message — no slot for payload or secret', () => {
    const error = backofficeDomainError('invalid_account_id');
    expect(Object.keys(error).toSorted()).toEqual(['code', 'message']);
  });
});

describe('type guard', () => {
  it('accepts objects whose code is in the taxonomy', () => {
    expect(isBackofficeDomainError(backofficeDomainError('staff_terminated'))).toBe(true);
    expect(isBackofficeDomainError({ code: 'invalid_transition' })).toBe(true);
  });

  it('rejects non-objects and codes outside the taxonomy — including inherited keys', () => {
    // `Object.hasOwn` thay vì `in`: `'toString'` nằm trên prototype chain của
    // mọi object, `in` sẽ cho true và guard nhận `{ code: 'toString' }` là hợp lệ.
    expect(isBackofficeDomainError({ code: 'toString' })).toBe(false);
    expect(isBackofficeDomainError(null)).toBe(false);
    expect(isBackofficeDomainError('invalid_account_id')).toBe(false);
    expect(isBackofficeDomainError(undefined)).toBe(false);
    expect(isBackofficeDomainError({ code: 5 })).toBe(false);
  });
});
