/**
 * Ghim biên của admission timestamp: epoch millis là số nguyên an toàn **và**
 * dựng được thành `Date`, vì ngoài biên `Date` thì không quy được về local
 * wall-clock và mọi quyết định peak/off-peak sẽ sai một cách âm thầm.
 */

import { describe, expect, it } from 'vitest';

import { MAX_EPOCH_MILLIS, isEpochMillis } from './instant';

describe('isEpochMillis', () => {
  it('accepts safe integers inside the Date range, including negative instants', () => {
    expect(isEpochMillis(0)).toBe(true);
    expect(isEpochMillis(Date.parse('2026-03-02T02:00:00Z'))).toBe(true);
    expect(isEpochMillis(-1_000)).toBe(true);
    expect(isEpochMillis(MAX_EPOCH_MILLIS)).toBe(true);
    expect(isEpochMillis(-MAX_EPOCH_MILLIS)).toBe(true);
  });

  it('rejects values outside the Date range', () => {
    expect(isEpochMillis(MAX_EPOCH_MILLIS + 1)).toBe(false);
    expect(isEpochMillis(-(MAX_EPOCH_MILLIS + 1))).toBe(false);
  });

  it('rejects fractional, non-finite and non-number values', () => {
    expect(isEpochMillis(1.5)).toBe(false);
    expect(isEpochMillis(Number.NaN)).toBe(false);
    expect(isEpochMillis(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isEpochMillis('1700000000000')).toBe(false);
    expect(isEpochMillis(null)).toBe(false);
  });
});
