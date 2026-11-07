import { describe, expect, it } from 'vitest';

import {
  computeTotalTokens,
  createNormalizedUsage,
  isNormalizedUsage,
  isValidTokenCount,
  validateUsageInvariants,
} from './normalized-usage';

describe('isValidTokenCount', () => {
  it.each([
    [0, true],
    [1, true],
    [1000, true],
    [null, true],
    [-1, false],
    [-0.5, false],
    [Infinity, false],
    [NaN, false],
    [undefined as unknown as number, false],
    ['5' as unknown as number, false],
  ])('accepts %j → %s', (value, expected) => {
    expect(isValidTokenCount(value)).toBe(expected);
  });
});

describe('createNormalizedUsage', () => {
  it.each([
    {
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 20,
      reasoning_tokens: 10,
      request_count: 1,
    },
    { input_tokens: 0, output_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, request_count: 0 },
    {
      input_tokens: null,
      output_tokens: null,
      cached_tokens: null,
      reasoning_tokens: null,
      request_count: null,
    },
    {
      input_tokens: 10,
      output_tokens: null,
      cached_tokens: null,
      reasoning_tokens: null,
      request_count: null,
    },
  ])('creates valid usage from %j', (input) => {
    const usage = createNormalizedUsage(input);
    expect(usage).toEqual(input);
    expect(isNormalizedUsage(usage)).toBe(true);
  });

  it.each([
    {
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 20,
      reasoning_tokens: 2,
      request_count: 1,
    },
    { input_tokens: 5, output_tokens: 5, cached_tokens: 6, reasoning_tokens: 0, request_count: 0 },
  ])('rejects cached_tokens > input_tokens (%j)', (input) => {
    expect(() => createNormalizedUsage(input)).toThrow(TypeError);
  });

  it.each([
    {
      input_tokens: -1,
      output_tokens: 5,
      cached_tokens: null,
      reasoning_tokens: null,
      request_count: null,
    },
    {
      input_tokens: 10,
      output_tokens: -5,
      cached_tokens: null,
      reasoning_tokens: null,
      request_count: null,
    },
    {
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: -1,
      reasoning_tokens: null,
      request_count: null,
    },
  ])('rejects negative token count (%j)', (input) => {
    expect(() => createNormalizedUsage(input)).toThrow(TypeError);
  });

  it('rejects non-finite token count', () => {
    expect(() =>
      createNormalizedUsage({
        input_tokens: Infinity,
        output_tokens: 5,
        cached_tokens: null,
        reasoning_tokens: null,
        request_count: null,
      }),
    ).toThrow(TypeError);
  });

  it('does not mutate input', () => {
    const input = {
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 2,
      reasoning_tokens: 1,
      request_count: 1,
    };
    const before = JSON.stringify(input);
    createNormalizedUsage(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('computeTotalTokens', () => {
  it.each([
    [
      {
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 20,
        reasoning_tokens: 10,
        request_count: 1,
      },
      150,
    ],
    [
      {
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        reasoning_tokens: 0,
        request_count: 0,
      },
      0,
    ],
    [
      {
        input_tokens: 10,
        output_tokens: null,
        cached_tokens: null,
        reasoning_tokens: null,
        request_count: null,
      },
      null,
    ],
    [
      {
        input_tokens: null,
        output_tokens: 5,
        cached_tokens: null,
        reasoning_tokens: null,
        request_count: null,
      },
      null,
    ],
    [
      {
        input_tokens: null,
        output_tokens: null,
        cached_tokens: null,
        reasoning_tokens: null,
        request_count: null,
      },
      null,
    ],
  ])('total for %j → %j', (usage, expected) => {
    expect(computeTotalTokens(usage)).toBe(expected);
  });

  it('does not double-count cached or reasoning tokens', () => {
    // input=100 (cached=20 subset), output=50 (reasoning=10 subset) → 150, not 170/180
    const usage = createNormalizedUsage({
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 20,
      reasoning_tokens: 10,
      request_count: 1,
    });
    expect(computeTotalTokens(usage)).toBe(150);
  });

  it('does not mutate input', () => {
    const usage = createNormalizedUsage({
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: null,
      reasoning_tokens: null,
      request_count: null,
    });
    const before = JSON.stringify(usage);
    computeTotalTokens(usage);
    expect(JSON.stringify(usage)).toBe(before);
  });
});

describe('validateUsageInvariants', () => {
  it.each([
    [
      {
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 20,
        reasoning_tokens: 10,
        request_count: 1,
      },
      true,
    ],
    [
      {
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: 10,
        reasoning_tokens: 0,
        request_count: 0,
      },
      true,
    ],
    [
      {
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: null,
        reasoning_tokens: null,
        request_count: null,
      },
      true,
    ],
    [
      {
        input_tokens: 10,
        output_tokens: 5,
        cached_tokens: 11,
        reasoning_tokens: 0,
        request_count: 0,
      },
      false,
    ],
  ])('validates %j → valid=%s', (usage, expectedValid) => {
    const result = validateUsageInvariants(usage);
    expect(result.valid).toBe(expectedValid);
    expect(result.violation === undefined).toBe(expectedValid);
  });

  it('does not mutate input', () => {
    const usage = createNormalizedUsage({
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 2,
      reasoning_tokens: 1,
      request_count: 1,
    });
    const before = JSON.stringify(usage);
    validateUsageInvariants(usage);
    expect(JSON.stringify(usage)).toBe(before);
  });
});

describe('isNormalizedUsage', () => {
  it('accepts valid NormalizedUsage and rejects others', () => {
    const valid = createNormalizedUsage({
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: 2,
      reasoning_tokens: 1,
      request_count: 1,
    });
    expect(isNormalizedUsage(valid)).toBe(true);
    expect(isNormalizedUsage(null)).toBe(false);
    expect(isNormalizedUsage(undefined)).toBe(false);
    expect(isNormalizedUsage('x')).toBe(false);
    expect(isNormalizedUsage({ input_tokens: -1, output_tokens: 0 } as unknown as never)).toBe(
      false,
    );
  });
});
