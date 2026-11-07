/**
 * Ghim số học tiền và ranh giới denomination domain.
 *
 * Kỳ vọng được viết bằng tay, không tính lại bằng code đang được test.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_MONEY_MAGNITUDE,
  addMoney,
  compareMoney,
  createMoney,
  isMoney,
  isZeroMoney,
  readMoney,
  subtractMoney,
  sumMoney,
  zeroMoney,
} from './money';
import { failureCode, ec, uc, unwrap } from './test-fixtures';

describe('createMoney', () => {
  it('accepts bigint, safe integer and digit string', () => {
    expect(unwrap(createMoney('UC', 0n)).minor).toBe(0n);
    expect(unwrap(createMoney('UC', 42)).minor).toBe(42n);
    expect(unwrap(createMoney('UC', '9007199254740993')).minor).toBe(9_007_199_254_740_993n);
  });

  it('rejects negative, fractional, exponent and over-magnitude amounts', () => {
    expect(failureCode(createMoney('UC', -1n))).toBe('invalid_amount');
    expect(failureCode(createMoney('UC', 1.5))).toBe('invalid_amount');
    expect(failureCode(createMoney('UC', '1e9'))).toBe('invalid_amount');
    expect(failureCode(createMoney('UC', MAX_MONEY_MAGNITUDE + 1n))).toBe('amount_overflow');
  });

  it('rejects an unknown denomination', () => {
    expect(failureCode(createMoney('USD' as never, 1n))).toBe('invalid_denomination');
  });
});

describe('addMoney and subtractMoney', () => {
  it('adds two amounts of the same denomination', () => {
    expect(unwrap(addMoney(uc(1_000), uc(250))).minor).toBe(1_250n);
  });

  it('refuses to add UC to EC — the two domains never mix silently', () => {
    expect(failureCode(addMoney(uc(1), ec(1)))).toBe('denomination_mismatch');
    expect(failureCode(subtractMoney(ec(1), uc(1)))).toBe('denomination_mismatch');
  });

  it('rejects a subtraction that would produce a negative balance', () => {
    expect(failureCode(subtractMoney(uc(10), uc(11)))).toBe('insufficient_funds');
  });

  it('rejects a sum beyond the representable magnitude', () => {
    expect(failureCode(addMoney(uc(MAX_MONEY_MAGNITUDE), uc(1)))).toBe('amount_overflow');
  });

  it('allows an exact zero result at the boundary', () => {
    expect(unwrap(subtractMoney(uc(7), uc(7))).minor).toBe(0n);
  });
});

describe('compareMoney, zero and sum', () => {
  it('orders amounts within one denomination', () => {
    expect(compareMoney(uc(1), uc(2))).toBe(-1);
    expect(compareMoney(uc(2), uc(2))).toBe(0);
    expect(compareMoney(uc(3), uc(2))).toBe(1);
  });

  it('returns null when denominations differ', () => {
    expect(compareMoney(uc(1), ec(1))).toBeNull();
  });

  it('recognises zero without treating it as unknown', () => {
    expect(isZeroMoney(zeroMoney('UC'))).toBe(true);
    expect(isZeroMoney(uc(1))).toBe(false);
  });

  it('sums an empty list to zero of the requested denomination', () => {
    expect(unwrap(sumMoney('EC', [])).minor).toBe(0n);
  });

  it('cancels the whole sum when one element has another denomination', () => {
    expect(failureCode(sumMoney('EC', [ec(1), uc(1)]))).toBe('denomination_mismatch');
  });
});

describe('readMoney', () => {
  it('reads an external record with a string minor', () => {
    expect(unwrap(readMoney({ denomination: 'EC', minor: '123' })).minor).toBe(123n);
  });

  it('rejects an unknown denomination and a malformed minor', () => {
    expect(failureCode(readMoney({ denomination: 'VND', minor: '1' }))).toBe(
      'invalid_denomination',
    );
    expect(failureCode(readMoney({ denomination: 'EC', minor: ' 1' }))).toBe('invalid_amount');
  });
});

describe('isMoney', () => {
  it('accepts a frozen value object and rejects a negative minor', () => {
    expect(isMoney(uc(1))).toBe(true);
    expect(isMoney({ denomination: 'UC', minor: -1n })).toBe(false);
    expect(isMoney({ denomination: 'UC', minor: 1 })).toBe(false);
  });
});
