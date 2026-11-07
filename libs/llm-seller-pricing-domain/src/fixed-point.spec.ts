/**
 * Ghim bốn quy tắc làm tròn và hành vi overflow của số học fixed-point.
 *
 * Đây là tầng duy nhất được phép làm tròn; mọi giá trị dưới đây là số nguyên
 * chính xác ở price scale, nên kỳ vọng được viết ra bằng tay chứ không tính lại
 * bằng code đang được test.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_FIXED_POINT_MAGNITUDE,
  PRICE_SCALE_MAX,
  checkedAdd,
  checkedMultiply,
  isAmountScale,
  isFixedPointAmount,
  isPriceScale,
  isRoundingRule,
  powerOfTen,
  readNonNegativeInteger,
  rescaleFixedPoint,
} from './fixed-point';

describe('rescaleFixedPoint', () => {
  it('scales up exactly when the target scale is larger', () => {
    expect(rescaleFixedPoint(1234n, 2, 6, 'half_up')).toEqual(12_340_000n);
  });

  it('returns the value unchanged when both scales match', () => {
    for (const rule of ['half_up', 'half_even', 'floor', 'ceil'] as const) {
      expect(rescaleFixedPoint(987_654n, 6, 6, rule)).toEqual(987_654n);
    }
  });

  it('does not round when the conversion is exact', () => {
    for (const rule of ['half_up', 'half_even', 'floor', 'ceil'] as const) {
      expect(rescaleFixedPoint(1_234_500n, 4, 2, rule)).toEqual(12_345n);
    }
  });

  it('rounds 123.4567 to two decimals in both directions', () => {
    const value = 1_234_567n; // 123.4567 ở price scale 4.
    expect(rescaleFixedPoint(value, 4, 2, 'floor')).toEqual(12_345n);
    expect(rescaleFixedPoint(value, 4, 2, 'ceil')).toEqual(12_346n);
    expect(rescaleFixedPoint(value, 4, 2, 'half_up')).toEqual(12_346n);
    expect(rescaleFixedPoint(value, 4, 2, 'half_even')).toEqual(12_346n);
  });

  it('rounds an exact half up, away from zero', () => {
    // 123.4550 → 12345.50 ở amount scale 2.
    expect(rescaleFixedPoint(1_234_550n, 4, 2, 'half_up')).toEqual(12_346n);
    expect(rescaleFixedPoint(1_234_550n, 4, 2, 'floor')).toEqual(12_345n);
    expect(rescaleFixedPoint(1_234_550n, 4, 2, 'ceil')).toEqual(12_346n);
  });

  it('rounds an exact half to even for half_even', () => {
    // 12345 lẻ → lên 12346; 12344 chẵn → giữ 12344.
    expect(rescaleFixedPoint(1_234_550n, 4, 2, 'half_even')).toEqual(12_346n);
    expect(rescaleFixedPoint(1_234_450n, 4, 2, 'half_even')).toEqual(12_344n);
    expect(rescaleFixedPoint(1_234_450n, 4, 2, 'half_up')).toEqual(12_345n);
  });

  it('rounds a value below the half boundary down for half rules', () => {
    // 123.4549 → 12345.49 ở amount scale 2.
    expect(rescaleFixedPoint(1_234_549n, 4, 2, 'half_up')).toEqual(12_345n);
    expect(rescaleFixedPoint(1_234_549n, 4, 2, 'half_even')).toEqual(12_345n);
  });

  it('rounds a single minor unit up for ceil even when it is tiny', () => {
    expect(rescaleFixedPoint(1n, 6, 2, 'ceil')).toEqual(1n);
    expect(rescaleFixedPoint(1n, 6, 2, 'floor')).toEqual(0n);
  });
});

describe('checked arithmetic', () => {
  it('reports overflow instead of returning a truncated value', () => {
    expect(() => checkedMultiply(MAX_FIXED_POINT_MAGNITUDE, 2n)).toThrow(
      'Fixed-point arithmetic exceeded the supported magnitude.',
    );
    expect(() => checkedAdd(MAX_FIXED_POINT_MAGNITUDE, 1n)).toThrow(
      'Fixed-point arithmetic exceeded the supported magnitude.',
    );
  });

  it('accepts a value exactly at the magnitude boundary', () => {
    expect(checkedAdd(MAX_FIXED_POINT_MAGNITUDE - 1n, 1n)).toEqual(MAX_FIXED_POINT_MAGNITUDE);
  });

  it('computes powers of ten exactly', () => {
    expect(powerOfTen(0)).toEqual(1n);
    expect(powerOfTen(6)).toEqual(1_000_000n);
    expect(powerOfTen(18)).toEqual(1_000_000_000_000_000_000n);
  });
});

describe('scale and value guards', () => {
  it('accepts scales inside the supported range', () => {
    expect(isPriceScale(0)).toBe(true);
    expect(isPriceScale(PRICE_SCALE_MAX)).toBe(true);
    expect(isAmountScale(2)).toBe(true);
  });

  it('rejects scales outside the supported range', () => {
    expect(isPriceScale(-1)).toBe(false);
    expect(isPriceScale(PRICE_SCALE_MAX + 1)).toBe(false);
    expect(isPriceScale(1.5)).toBe(false);
    expect(isAmountScale('2')).toBe(false);
  });

  it('accepts only known rounding rules', () => {
    expect(isRoundingRule('half_up')).toBe(true);
    expect(isRoundingRule('bankers')).toBe(false);
    expect(isRoundingRule(undefined)).toBe(false);
  });

  it('rejects negative and out-of-range fixed-point amounts', () => {
    expect(isFixedPointAmount(0n)).toBe(true);
    expect(isFixedPointAmount(-1n)).toBe(false);
    expect(isFixedPointAmount(MAX_FIXED_POINT_MAGNITUDE + 1n)).toBe(false);
    expect(isFixedPointAmount(1)).toBe(false);
  });
});

describe('readNonNegativeInteger', () => {
  it('reads bigint, safe integer and digit-only string forms', () => {
    expect(readNonNegativeInteger(12n)).toEqual(12n);
    expect(readNonNegativeInteger(12)).toEqual(12n);
    expect(readNonNegativeInteger('12')).toEqual(12n);
    expect(readNonNegativeInteger(0)).toEqual(0n);
  });

  it('rejects negative, fractional and exponent forms', () => {
    expect(readNonNegativeInteger(-1)).toBeNull();
    expect(readNonNegativeInteger(1.5)).toBeNull();
    expect(readNonNegativeInteger('1.5')).toBeNull();
    expect(readNonNegativeInteger('1e6')).toBeNull();
    expect(readNonNegativeInteger('-1')).toBeNull();
    expect(readNonNegativeInteger('')).toBeNull();
  });

  it('rejects a value above the supported magnitude', () => {
    expect(readNonNegativeInteger(String(MAX_FIXED_POINT_MAGNITUDE))).toEqual(
      MAX_FIXED_POINT_MAGNITUDE,
    );
    expect(readNonNegativeInteger('1' + '0'.repeat(30))).toBeNull();
  });
});
