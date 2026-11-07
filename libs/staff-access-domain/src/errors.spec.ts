/**
 * Ghim taxonomy domain error: factory doc dung nguon message, guard khong
 * nhan code tu prototype chain, va error object khong co cho cho payload.
 */

import { describe, expect, it } from 'vitest';

import {
  STAFF_ACCESS_DOMAIN_ERROR_MESSAGES,
  isStaffAccessDomainError,
  staffAccessDomainError,
  type StaffAccessDomainErrorCode,
} from './errors';

describe('staffAccessDomainError', () => {
  it('pairs every declared code with its table message', () => {
    for (const code of Object.keys(STAFF_ACCESS_DOMAIN_ERROR_MESSAGES)) {
      const error = staffAccessDomainError(code as StaffAccessDomainErrorCode);
      expect(error.code).toEqual(code);
      expect(error.message).toEqual(
        STAFF_ACCESS_DOMAIN_ERROR_MESSAGES[code as StaffAccessDomainErrorCode],
      );
    }
  });

  it('rejects a code outside the taxonomy with a TypeError', () => {
    // @ts-expect-error -- cast a value that is not in the union on purpose.
    expect(() => staffAccessDomainError('totally_unknown_code')).toThrow(TypeError);
  });
});

describe('isStaffAccessDomainError', () => {
  it('accepts only objects whose code is in the taxonomy', () => {
    const error = staffAccessDomainError('staff_not_found');
    expect(isStaffAccessDomainError(error)).toBe(true);
    expect(isStaffAccessDomainError({ code: 'toString' })).toBe(false);
    expect(isStaffAccessDomainError({ code: 'staff_not_found', extra: 'payload' })).toBe(false);
    expect(isStaffAccessDomainError(null)).toBe(false);
    expect(isStaffAccessDomainError('staff_not_found')).toBe(false);
  });
});
