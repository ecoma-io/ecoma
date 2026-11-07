import { describe, expect, it } from 'vitest';

import {
  isFiniteNumber,
  isNonEmptyString,
  isPositiveInteger,
  isTransport,
  TRANSPORT,
  TRANSPORT_VALUES,
} from './shared';
import { PROVIDER_TYPE_VALUES } from './provider';

describe('Transport vocabulary is closed and disjoint from ProviderType', () => {
  it('accepts every declared Transport', () => {
    for (const transport of TRANSPORT_VALUES) {
      expect(isTransport(transport)).toBe(true);
    }
  });

  it('rejects every ProviderType as a Transport', () => {
    for (const providerType of PROVIDER_TYPE_VALUES) {
      expect(isTransport(providerType)).toBe(false);
    }
  });

  it('rejects junk values as a Transport', () => {
    for (const value of ['web push', 'WEB', '', ' app', null, undefined, 1, {}]) {
      expect(isTransport(value)).toBe(false);
    }
  });

  it('declares exactly two transports', () => {
    expect(TRANSPORT_VALUES).toStrictEqual([TRANSPORT.Web, TRANSPORT.App]);
  });
});

describe('isNonEmptyString rejects blank and non-string values', () => {
  it('accepts a non-blank string and rejects blank strings', () => {
    expect(isNonEmptyString('a')).toBe(true);
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString('   ')).toBe(false);
    expect(isNonEmptyString('\t\n')).toBe(false);
  });

  it('rejects non-string values', () => {
    for (const value of [null, undefined, 0, {}, [], true]) {
      expect(isNonEmptyString(value)).toBe(false);
    }
  });
});

describe('isPositiveInteger accepts only safe positive integers', () => {
  it('accepts safe positive integers', () => {
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('rejects zero, negatives, non-integers and unsafe numbers', () => {
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      null,
    ]) {
      expect(isPositiveInteger(value)).toBe(false);
    }
  });
});

describe('isFiniteNumber accepts zero and negatives but rejects non-finite', () => {
  it('accepts finite numbers including zero and negatives', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-5)).toBe(true);
    expect(isFiniteNumber(1.5)).toBe(true);
  });

  it('rejects non-finite numbers and non-numbers', () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      '0',
      null,
    ]) {
      expect(isFiniteNumber(value)).toBe(false);
    }
  });
});
