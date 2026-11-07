import { describe, expect, it } from 'vitest';

import { classifyUsage, USAGE_STATUS } from './index';

describe('USAGE_STATUS', () => {
  it('exposes exactly the four statuses', () => {
    expect(Object.keys(USAGE_STATUS).toSorted()).toEqual(
      ['known', 'malformed', 'missing', 'partial'].toSorted(),
    );
  });
});

describe('classifyUsage', () => {
  it.each([
    [null, 'missing'],
    [undefined, 'missing'],
    [{}, 'partial'],
    [{ input_tokens: 100 }, 'known'],
    [{ output_tokens: 50 }, 'known'],
    [{ input_tokens: 100, output_tokens: 50, cached_tokens: 20 }, 'known'],
    [{ input_tokens: null, output_tokens: null }, 'known'],
    [{ raw_usage: 'garbage' }, 'partial'],
    ['string', 'malformed'],
    [42, 'malformed'],
    [true, 'malformed'],
    [[], 'malformed'],
  ])('classify %j → %s', (input, expected) => {
    expect(classifyUsage(input)).toBe(expected);
  });

  it('does not mutate input', () => {
    const input = { input_tokens: 100, output_tokens: 50 };
    const before = JSON.stringify(input);
    classifyUsage(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
