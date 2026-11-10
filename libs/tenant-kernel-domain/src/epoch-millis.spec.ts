import { describe, expect, it } from 'vitest';

import { isEpochMillis } from './epoch-millis';

describe('isEpochMillis', () => {
  it('accepts zero and safe integers', () => {
    expect(isEpochMillis(0)).toBe(true);
    expect(isEpochMillis(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isEpochMillis(Number.MIN_SAFE_INTEGER)).toBe(true);
    expect(isEpochMillis(-1_775_000_000_000)).toBe(true);
  });

  it('rejects NaN, Infinity and -Infinity', () => {
    expect(isEpochMillis(NaN)).toBe(false);
    expect(isEpochMillis(Infinity)).toBe(false);
    expect(isEpochMillis(-Infinity)).toBe(false);
  });

  it('rejects fractional numbers', () => {
    expect(isEpochMillis(1.5)).toBe(false);
    expect(isEpochMillis(-0.5)).toBe(false);
  });

  it('rejects strings, null, undefined and objects', () => {
    expect(isEpochMillis('1700000000000')).toBe(false);
    expect(isEpochMillis(null)).toBe(false);
    expect(isEpochMillis(undefined)).toBe(false);
    expect(isEpochMillis({})).toBe(false);
  });
});
