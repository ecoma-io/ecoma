/**
 * Ghim phép tính giá: cả hai dimension cộng dồn, subset không bị double-count,
 * chỉ một điểm làm tròn, và overflow trả lỗi thay vì một con số bị cắt.
 *
 * Các con số kỳ vọng được tính tay từ công thức canonical
 * (`docs/domains/llm-seller-pricing/domain-model.md` §3).
 */

import { describe, expect, it } from 'vitest';

import { calculatePrice, type PriceCalculation } from './calculate-price';
import type { ResolvedPriceSet } from './price';
import type { TokenUsage } from './token-usage';

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

/**
 * Giá ở price scale 6 (đơn vị 10^-6):
 * per-request 1.000000, input 0.000010, cached 0.000002,
 * output 0.000030, reasoning 0.000060.
 */
const PRICES: ResolvedPriceSet = {
  perRequest: 1_000_000n,
  input: 10n,
  cached: 2n,
  output: 30n,
  reasoning: 60n,
};

const USAGE: TokenUsage = {
  inputTokens: 1000n,
  cachedTokens: 200n,
  outputTokens: 500n,
  reasoningTokens: 100n,
};

function calculation(overrides: Partial<PriceCalculation> = {}): PriceCalculation {
  return {
    requestCount: 1n,
    usage: USAGE,
    prices: PRICES,
    priceScale: 6,
    amountScale: 6,
    rounding: 'half_up',
    ...overrides,
  };
}

/** Tổng của usage chuẩn, chuyển về amount scale 2 theo `rounding`. */
function scaleToTwo(rounding: PriceCalculation['rounding']): bigint {
  return expectOk(calculatePrice(calculation({ amountScale: 2, rounding }), 'VND')).amount;
}

describe('calculatePrice', () => {
  it('adds the per-request charge and both token dimensions', () => {
    // 1000000 + 800×10 + 200×2 + 400×30 + 100×60 = 1026400 ở price scale 6.
    const priced = expectOk(calculatePrice(calculation(), 'VND'));
    expect(priced.amount).toEqual(1_026_400n);
    expect(priced.amountScale).toEqual(6);
    expect(priced.currency).toEqual('VND');
    expect(Object.isFrozen(priced)).toBe(true);
  });

  it('charges only the non-cached input at the input price', () => {
    // 1000000 + 800×10 + 200×2 = 1008400; nếu cached bị tính thêm theo input
    // price thì tổng sẽ là 1010000.
    const priced = expectOk(
      calculatePrice(
        calculation({
          usage: { ...USAGE, outputTokens: 0n, reasoningTokens: 0n },
        }),
        'VND',
      ),
    );
    expect(priced.amount).toEqual(1_008_400n);
  });

  it('charges only the non-reasoning output at the output price', () => {
    const priced = expectOk(
      calculatePrice(
        calculation({
          prices: { ...PRICES, reasoning: 30n },
          usage: { ...USAGE, inputTokens: 0n, cachedTokens: 0n },
        }),
        'VND',
      ),
    );
    // 400×30 + 100×30 = 15000 → bằng 500×30, đúng vì giá bằng nhau.
    expect(priced.amount).toEqual(1_015_000n);
  });

  it('does not double count cached tokens', () => {
    // Khi cached price bằng input price, tách cached ra hay không phải cho cùng
    // một tổng. Nếu cached bị tính thêm lần nữa, tổng sẽ lớn hơn.
    const samePrice: ResolvedPriceSet = { ...PRICES, cached: PRICES.input };
    const split = expectOk(calculatePrice(calculation({ prices: samePrice }), 'VND'));
    const unsplit = expectOk(
      calculatePrice(
        calculation({ prices: samePrice, usage: { ...USAGE, cachedTokens: 0n } }),
        'VND',
      ),
    );
    expect(split.amount).toEqual(unsplit.amount);
    expect(split.amount).toEqual(1_028_000n);
  });

  it('does not double count reasoning tokens', () => {
    const samePrice: ResolvedPriceSet = { ...PRICES, reasoning: PRICES.output };
    const split = expectOk(calculatePrice(calculation({ prices: samePrice }), 'VND'));
    const unsplit = expectOk(
      calculatePrice(
        calculation({ prices: samePrice, usage: { ...USAGE, reasoningTokens: 0n } }),
        'VND',
      ),
    );
    expect(split.amount).toEqual(unsplit.amount);
    expect(split.amount).toEqual(1_023_400n);
  });

  it('multiplies by the request count', () => {
    const priced = expectOk(calculatePrice(calculation({ requestCount: 3n }), 'VND'));
    // 3×1000000 + 8000 + 400 + 12000 + 6000 = 3026400.
    expect(priced.amount).toEqual(3_026_400n);
  });

  it('charges zero when every input is zero', () => {
    const priced = expectOk(
      calculatePrice(
        calculation({
          requestCount: 0n,
          usage: { inputTokens: 0n, cachedTokens: 0n, outputTokens: 0n, reasoningTokens: 0n },
        }),
        'VND',
      ),
    );
    expect(priced.amount).toEqual(0n);
  });

  it('handles a zero price on a single dimension without affecting the others', () => {
    const priced = expectOk(
      calculatePrice(calculation({ prices: { ...PRICES, perRequest: 0n } }), 'VND'),
    );
    expect(priced.amount).toEqual(26_400n);
  });

  it('accounts for usage where every token is cached', () => {
    const priced = expectOk(
      calculatePrice(
        calculation({
          usage: { inputTokens: 1000n, cachedTokens: 1000n, outputTokens: 0n, reasoningTokens: 0n },
        }),
        'VND',
      ),
    );
    // 1000000 + 1000×2 = 1002000; input price không áp cho token nào.
    expect(priced.amount).toEqual(1_002_000n);
  });

  it('accounts for usage where every output token is reasoning', () => {
    const priced = expectOk(
      calculatePrice(
        calculation({
          usage: { inputTokens: 0n, cachedTokens: 0n, outputTokens: 500n, reasoningTokens: 500n },
        }),
        'VND',
      ),
    );
    expect(priced.amount).toEqual(1_030_000n);
  });

  it('rounds once on the total, not once per component', () => {
    // Mỗi thành phần 0.005 ở price scale 6; tổng 0.010.
    // Làm tròn từng thành phần sẽ cho 0.01 + 0.01 = 0.02 ở amount scale 2.
    const prices: ResolvedPriceSet = {
      perRequest: 5_000n,
      input: 5_000n,
      cached: 0n,
      output: 0n,
      reasoning: 0n,
    };
    const priced = expectOk(
      calculatePrice(
        calculation({
          prices,
          usage: { inputTokens: 1n, cachedTokens: 0n, outputTokens: 0n, reasoningTokens: 0n },
          amountScale: 2,
        }),
        'USD',
      ),
    );
    expect(priced.amount).toEqual(1n);
  });

  it('applies each rounding rule to the same total', () => {
    // Tổng 1.026400 đơn vị tiền ở amount scale 2 là 102.64 → 102 hoặc 103.
    expect(scaleToTwo('floor')).toEqual(102n);
    expect(scaleToTwo('ceil')).toEqual(103n);
    expect(scaleToTwo('half_up')).toEqual(103n);
    expect(scaleToTwo('half_even')).toEqual(103n);
  });

  it('reports overflow instead of returning a truncated amount', () => {
    const hugePrices: ResolvedPriceSet = {
      perRequest: 10n ** 20n,
      input: 0n,
      cached: 0n,
      output: 0n,
      reasoning: 0n,
    };
    const result = calculatePrice(
      calculation({
        prices: hugePrices,
        requestCount: 10n ** 11n,
        usage: { inputTokens: 0n, cachedTokens: 0n, outputTokens: 0n, reasoningTokens: 0n },
      }),
      'VND',
    );
    expect(expectRejection(result)).toEqual('amount_overflow');
  });

  it('rejects a currency that is not a three-letter ISO shape', () => {
    expect(expectRejection(calculatePrice(calculation(), 'vnd'))).toEqual('invalid_currency');
  });

  it('rejects an out-of-range scale or unknown rounding rule', () => {
    expect(expectRejection(calculatePrice(calculation({ priceScale: 19 }), 'VND'))).toEqual(
      'invalid_scale',
    );
    expect(expectRejection(calculatePrice(calculation({ amountScale: -1 }), 'VND'))).toEqual(
      'invalid_scale',
    );
    expect(
      expectRejection(
        // @ts-expect-error -- an unknown rounding rule must not reach the sum.
        calculatePrice(calculation({ rounding: 'bankers' }), 'VND'),
      ),
    ).toEqual('invalid_rounding_rule');
  });

  it('rejects a usage pair that violates the token subset invariant', () => {
    expect(
      expectRejection(
        calculatePrice(
          calculation({ usage: { ...USAGE, cachedTokens: USAGE.inputTokens + 1n } }),
          'VND',
        ),
      ),
    ).toEqual('token_subset_violation');
    expect(
      expectRejection(
        calculatePrice(
          calculation({ usage: { ...USAGE, reasoningTokens: USAGE.outputTokens + 1n } }),
          'VND',
        ),
      ),
    ).toEqual('token_subset_violation');
  });

  it('returns domain errors for a hand-built calculation instead of throwing', () => {
    // `calculatePrice` là hàm public và `PriceCalculation` là type, không phải
    // bất biến runtime: caller dựng tay có thể bỏ field hoặc dùng `number`.
    const nullUsage = calculatePrice(
      // @ts-expect-error -- a caller can build an invalid calculation.
      { ...calculation(), usage: null },
      'VND',
    );
    expect(expectRejection(nullUsage)).toEqual('invalid_usage');

    const incompleteUsage = calculatePrice(
      // @ts-expect-error -- a caller can drop a mandatory category.
      { ...calculation(), usage: { inputTokens: 1n, outputTokens: 1n } },
      'VND',
    );
    expect(expectRejection(incompleteUsage)).toEqual('incomplete_usage');

    const numberRequestCount = calculatePrice(
      // @ts-expect-error -- a caller can pass a number request count.
      { ...calculation(), requestCount: 3 },
      'VND',
    );
    // `number` nguyên an toàn là dạng wire hợp lệ cho count (cùng đường mà
    // `readRequestCount` dùng), nên kết quả vẫn phải là một phép tính đúng —
    // không phải rejection, và càng không phải `TypeError`.
    expect(expectOk(numberRequestCount)).toEqual({
      amount: 3_026_400n,
      amountScale: 6,
      currency: 'VND',
    });

    const stringPrices = calculatePrice(
      // @ts-expect-error -- a caller can pass string prices.
      { ...calculation(), prices: { ...PRICES, input: '10' } },
      'VND',
    );
    expect(expectRejection(stringPrices)).toEqual('invalid_price');

    const nullCalculation = calculatePrice(
      // @ts-expect-error -- a caller can pass a non-record.
      null,
      'VND',
    );
    expect(expectRejection(nullCalculation)).toEqual('invalid_usage');
  });

  it('rejects a negative request count or negative price', () => {
    expect(expectRejection(calculatePrice(calculation({ requestCount: -1n }), 'VND'))).toEqual(
      'invalid_usage',
    );
    expect(
      expectRejection(calculatePrice(calculation({ prices: { ...PRICES, input: -1n } }), 'VND')),
    ).toEqual('invalid_price');
  });

  it('is deterministic for the same inputs', () => {
    const first = expectOk(calculatePrice(calculation(), 'VND'));
    const second = expectOk(calculatePrice(calculation(), 'VND'));
    expect(first).toEqual(second);
  });
});
