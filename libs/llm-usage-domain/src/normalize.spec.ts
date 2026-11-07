import { describe, expect, it } from 'vitest';

import { normalizeUsage, type ParsedProviderUsage } from './index';

function providerUsage(overrides: Partial<ParsedProviderUsage> = {}): ParsedProviderUsage {
  return {
    provider: 'provider-a',
    model: 'model-x',
    input_tokens: 100,
    output_tokens: 50,
    cached_tokens: 20,
    reasoning_tokens: 10,
    request_count: 1,
    raw_usage: { foo: 'bar' },
    ...overrides,
  } as ParsedProviderUsage;
}

describe('normalizeUsage', () => {
  it('normalizes a full provider usage deterministically', () => {
    const a = normalizeUsage(providerUsage(), '1.0.0');
    const b = normalizeUsage(providerUsage(), '1.0.0');
    expect(a).toEqual(b);
    expect(a).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 20,
      reasoning_tokens: 10,
      request_count: 1,
    });
  });

  it('maps missing fields to null (unknown), never to 0', () => {
    const result = normalizeUsage(
      providerUsage({ input_tokens: undefined, output_tokens: undefined }),
      '1.0.0',
    );
    expect(result.input_tokens).toBe(null);
    expect(result.output_tokens).toBe(null);
  });

  it('is deterministic: same input + version → same output', () => {
    const inputs = [
      providerUsage({ input_tokens: 1, output_tokens: 2 }),
      providerUsage({ input_tokens: 3, output_tokens: 4 }),
    ];
    const results = inputs.map((u) => normalizeUsage(u, '2.0.0'));
    const again = inputs.map((u) => normalizeUsage(u, '2.0.0'));
    expect(results).toEqual(again);
  });

  it('different version is allowed as input (version is opaque to domain)', () => {
    const v1 = normalizeUsage(providerUsage(), '1.0.0');
    const v2 = normalizeUsage(providerUsage(), '2.0.0');
    expect(v1).toEqual(v2); // version doesn't change normalization output
  });

  it.each([[''], ['   '], [null as unknown as string], [undefined as unknown as string]])(
    'throws TypeError for invalid normalizer_version %j',
    (version) => {
      expect(() => normalizeUsage(providerUsage(), version)).toThrow(TypeError);
    },
  );

  it('does not mutate input', () => {
    const input = providerUsage();
    const before = JSON.stringify(input);
    normalizeUsage(input, '1.0.0');
    expect(JSON.stringify(input)).toBe(before);
  });
});
