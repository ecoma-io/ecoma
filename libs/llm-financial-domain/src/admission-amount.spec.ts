/**
 * Spec của `admissionUpperBoundAmount` — công thức cận trên ADR-0028 §5.
 *
 * Ghim bốn bất biến: ceil-mỗi-term đúng một lần (một điểm làm tròn), cận trên
 * (giữ ≥ charge thật), fail-closed cho input âm, và overflow fail-closed thay
 * vì wrap. Số học bigint nguyên — không có float drift để test.
 */

import { describe, expect, it } from 'vitest';

import { admissionUpperBoundAmount } from './admission-amount';
import { failureCode, unwrap } from './test-fixtures';

const BASE = {
  denomination: 'UC',
  perRequestMinor: 0n,
  inputRatePerMillionMinor: 5000n,
  outputRatePerMillionMinor: 15000n,
} as const;

describe('admissionUpperBoundAmount', () => {
  it('prices fractional token blocks with a single ceil per term', () => {
    // 1 input token × 5000/1M → ceil → 1; 1 output token × 15000/1M → ceil → 1.
    // Một điểm làm tròn duy nhất: không có chia lần hai sau cộng.
    const result = admissionUpperBoundAmount({ ...BASE, inputTokens: 1n, outputTokens: 1n });
    expect(unwrap(result).minor).toBe(2n);
  });

  it('rounds each term up exactly at the million-token boundary', () => {
    // 1_000_000 input tokens × 5000 → đúng 5_000; 1_000_001 → ceil → 5_001.
    const exact = admissionUpperBoundAmount({
      ...BASE,
      inputTokens: 1_000_000n,
      outputTokens: 0n,
    });
    expect(unwrap(exact).minor).toBe(5000n);
    const over = admissionUpperBoundAmount({ ...BASE, inputTokens: 1_000_001n, outputTokens: 0n });
    expect(unwrap(over).minor).toBe(5001n);
  });

  it('adds the per-request price once, before rounding terms', () => {
    const result = admissionUpperBoundAmount({
      ...BASE,
      perRequestMinor: 7n,
      inputTokens: 1n,
      outputTokens: 1n,
    });
    expect(unwrap(result).minor).toBe(9n);
  });

  it('is zero only when every input is zero', () => {
    const result = admissionUpperBoundAmount({ ...BASE, inputTokens: 0n, outputTokens: 0n });
    expect(unwrap(result).minor).toBe(0n);
  });

  it('produces an upper bound at or above the exact unrounded price', () => {
    // Cận trên: ceil(x) ≥ x với mọi khối lẻ — ghim một ví dụ cụ thể thay vì
    // bất ổn định tổng quát. Giá không làm tròn: 3×5000/1M + 7×15000/1M
    // = 0.015 + 0.105 = 0.12 → ceil mỗi term 1 + 1 = 2.
    const result = admissionUpperBoundAmount({ ...BASE, inputTokens: 3n, outputTokens: 7n });
    expect(unwrap(result).minor).toBe(2n);
  });

  it('fails closed on a negative rate or negative token count', () => {
    expect(
      failureCode(
        admissionUpperBoundAmount({
          ...BASE,
          inputRatePerMillionMinor: -1n,
          inputTokens: 1n,
          outputTokens: 1n,
        }),
      ),
    ).toBe('invalid_amount');
    expect(
      failureCode(admissionUpperBoundAmount({ ...BASE, inputTokens: -1n, outputTokens: 0n })),
    ).toBe('invalid_amount');
    expect(
      failureCode(
        admissionUpperBoundAmount({
          ...BASE,
          perRequestMinor: -5n,
          inputTokens: 0n,
          outputTokens: 0n,
        }),
      ),
    ).toBe('invalid_amount');
  });

  it('fails closed with amount_overflow beyond MAX_MONEY_MAGNITUDE', () => {
    // Token count đủ lớn để SAU khi chia 1M, giá vẫn vượt trần magnitude:
    // 10^36 tokens × 5000 / 10^6 = 5×10^33 > 10^30 - 1.
    const huge = 10n ** 36n;
    const result = admissionUpperBoundAmount({ ...BASE, inputTokens: huge, outputTokens: 0n });
    expect(failureCode(result)).toBe('amount_overflow');
  });
});
