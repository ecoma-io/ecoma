/**
 * Ghim validation của bộ giá: per-request/input/output bắt buộc, cached và
 * reasoning phải là giá riêng hoặc fallback tường minh, và fallback resolve ra
 * giá cụ thể.
 */

import { describe, expect, it } from 'vitest';

import { readPriceSet, readSubsetPriceRule, resolvePriceSet, type PriceSet } from './price';

function expectOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: { code: string } },
): Value {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function expectRejection(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) {
    throw new Error('expected rejection, got ok');
  }
  return result.error.code;
}

const VALID_PRICES = {
  perRequest: 1000n,
  input: 250n,
  output: 750n,
  cached: { kind: 'fallback' },
  reasoning: { kind: 'fallback' },
} as const;

describe('readSubsetPriceRule', () => {
  it('accepts an explicit non-negative price', () => {
    const rule = expectOk(readSubsetPriceRule({ kind: 'explicit', price: 50n }));
    expect(rule).toEqual({ kind: 'explicit', price: 50n });
    expect(Object.isFrozen(rule)).toBe(true);
  });

  it('accepts an explicit price given as a decimal string', () => {
    expect(expectOk(readSubsetPriceRule({ kind: 'explicit', price: '50' }))).toEqual({
      kind: 'explicit',
      price: 50n,
    });
  });

  it('accepts a bare fallback declaration', () => {
    expect(expectOk(readSubsetPriceRule({ kind: 'fallback' }))).toEqual({ kind: 'fallback' });
  });

  it('rejects a fallback that also carries a price', () => {
    expect(expectRejection(readSubsetPriceRule({ kind: 'fallback', price: 50n }))).toEqual(
      'invalid_price_rule',
    );
  });

  it('rejects unknown kinds and negative explicit prices', () => {
    expect(expectRejection(readSubsetPriceRule({ kind: 'default' }))).toEqual('invalid_price_rule');
    expect(expectRejection(readSubsetPriceRule({ kind: 'explicit', price: -1n }))).toEqual(
      'invalid_price_rule',
    );
    expect(expectRejection(readSubsetPriceRule({ kind: 'explicit' }))).toEqual(
      'invalid_price_rule',
    );
    expect(expectRejection(readSubsetPriceRule(null))).toEqual('invalid_price_rule');
  });
});

describe('readPriceSet', () => {
  it('accepts a complete price set', () => {
    const prices = expectOk(readPriceSet(VALID_PRICES));
    expect(prices.perRequest).toEqual(1000n);
    expect(prices.input).toEqual(250n);
    expect(prices.output).toEqual(750n);
    expect(Object.isFrozen(prices)).toBe(true);
  });

  it('rejects a missing per-request, input or output price', () => {
    expect(
      expectRejection(
        readPriceSet({
          input: 250n,
          output: 750n,
          cached: { kind: 'fallback' },
          reasoning: { kind: 'fallback' },
        }),
      ),
    ).toEqual('invalid_price');
    expect(
      expectRejection(
        readPriceSet({
          perRequest: 1000n,
          output: 750n,
          cached: { kind: 'fallback' },
          reasoning: { kind: 'fallback' },
        }),
      ),
    ).toEqual('invalid_price');
    expect(
      expectRejection(
        readPriceSet({
          perRequest: 1000n,
          input: 250n,
          cached: { kind: 'fallback' },
          reasoning: { kind: 'fallback' },
        }),
      ),
    ).toEqual('invalid_price');
  });

  it('rejects a negative or fractional price instead of coercing it to zero', () => {
    expect(expectRejection(readPriceSet({ ...VALID_PRICES, input: -1n }))).toEqual('invalid_price');
    expect(expectRejection(readPriceSet({ ...VALID_PRICES, output: 1.5 }))).toEqual(
      'invalid_price',
    );
    expect(expectRejection(readPriceSet({ ...VALID_PRICES, perRequest: 'abc' }))).toEqual(
      'invalid_price',
    );
  });

  it('rejects a missing cached or reasoning rule', () => {
    expect(expectRejection(readPriceSet({ ...VALID_PRICES, cached: undefined }))).toEqual(
      'invalid_price_rule',
    );
    expect(expectRejection(readPriceSet({ ...VALID_PRICES, reasoning: undefined }))).toEqual(
      'invalid_price_rule',
    );
  });
});

describe('resolvePriceSet', () => {
  it('resolves cached to the input price and reasoning to the output price on fallback', () => {
    const prices: PriceSet = {
      perRequest: 1000n,
      input: 250n,
      output: 750n,
      cached: { kind: 'fallback' },
      reasoning: { kind: 'fallback' },
    };
    expect(resolvePriceSet(prices)).toEqual({
      perRequest: 1000n,
      input: 250n,
      cached: 250n,
      output: 750n,
      reasoning: 750n,
    });
  });

  it('keeps explicit cached and reasoning prices', () => {
    const prices: PriceSet = {
      perRequest: 1000n,
      input: 250n,
      output: 750n,
      cached: { kind: 'explicit', price: 50n },
      reasoning: { kind: 'explicit', price: 2000n },
    };
    const resolved = resolvePriceSet(prices);
    expect(resolved).toEqual({
      perRequest: 1000n,
      input: 250n,
      cached: 50n,
      output: 750n,
      reasoning: 2000n,
    });
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('supports a mixed configuration of one explicit and one fallback rule', () => {
    const prices: PriceSet = {
      perRequest: 0n,
      input: 100n,
      output: 200n,
      cached: { kind: 'explicit', price: 10n },
      reasoning: { kind: 'fallback' },
    };
    expect(resolvePriceSet(prices)).toEqual({
      perRequest: 0n,
      input: 100n,
      cached: 10n,
      output: 200n,
      reasoning: 200n,
    });
  });
});
