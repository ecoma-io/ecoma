/**
 * Ghim taxonomy domain error: factory đọc đúng bảng message, guard không nhận
 * code từ prototype chain, và error object không có chỗ cho payload.
 */

import { describe, expect, it } from 'vitest';

import {
  LLM_PRICING_DOMAIN_ERROR_MESSAGES,
  isLlmPricingDomainError,
  llmPricingDomainError,
  type LlmPricingDomainErrorCode,
} from './errors';

describe('llmPricingDomainError', () => {
  it('pairs every declared code with its table message', () => {
    for (const code of Object.keys(LLM_PRICING_DOMAIN_ERROR_MESSAGES)) {
      const error = llmPricingDomainError(code as LlmPricingDomainErrorCode);
      expect(error.code).toEqual(code);
      expect(error.message).toEqual(
        LLM_PRICING_DOMAIN_ERROR_MESSAGES[code as LlmPricingDomainErrorCode],
      );
    }
  });

  it('carries exactly the code and message fields', () => {
    expect(Object.keys(llmPricingDomainError('invalid_price')).toSorted()).toEqual([
      'code',
      'message',
    ]);
  });

  it('writes every message in English', () => {
    for (const message of Object.values(LLM_PRICING_DOMAIN_ERROR_MESSAGES)) {
      expect(message).toMatch(/^[\x20-\x7e]+$/u);
    }
  });

  it('rejects a code outside the taxonomy with a TypeError', () => {
    // @ts-expect-error -- cast a value that is not in the union on purpose.
    expect(() => llmPricingDomainError('totally_unknown_code')).toThrow(TypeError);
  });

  it('rejects an inherited prototype key instead of returning it', () => {
    // @ts-expect-error -- 'toString' is reachable through the prototype chain.
    expect(() => llmPricingDomainError('toString')).toThrow(TypeError);
  });
});

describe('isLlmPricingDomainError', () => {
  it('accepts only objects whose code is in the taxonomy', () => {
    expect(isLlmPricingDomainError(llmPricingDomainError('invalid_price'))).toBe(true);
    expect(isLlmPricingDomainError({ code: 'toString', message: 'x' })).toBe(false);
    expect(isLlmPricingDomainError({ code: 'invalid_price' })).toBe(false);
    expect(isLlmPricingDomainError({ code: 'invalid_price', message: 1 })).toBe(false);
    expect(isLlmPricingDomainError(null)).toBe(false);
    expect(isLlmPricingDomainError('invalid_price')).toBe(false);
  });

  it('rejects an error object carrying an extra payload field', () => {
    expect(
      isLlmPricingDomainError({
        code: 'invalid_price',
        message: 'Price is not valid.',
        offerId: 'offer-1',
      }),
    ).toBe(false);
  });

  it('rejects a message that is not the canonical table text', () => {
    // Error không mang payload: một object `{ code, message }` dựng lại từ log/cache/event payload
    // là đường dễ nhất để message tự do (kèm identifier) lọt vào. Guard chỉ nhận
    // đúng text canonical, tức là bảo đảm "error này do factory sinh ra".
    expect(
      isLlmPricingDomainError({
        code: 'invalid_price',
        message: 'Price is invalid for offer-42.',
      }),
    ).toBe(false);
    expect(
      isLlmPricingDomainError({
        code: 'invalid_price',
        message: LLM_PRICING_DOMAIN_ERROR_MESSAGES.invalid_price,
      }),
    ).toBe(true);
  });
});

describe('LLM_PRICING_DOMAIN_ERROR_MESSAGES', () => {
  it('is frozen so a call site cannot rewrite canonical messages', () => {
    expect(Object.isFrozen(LLM_PRICING_DOMAIN_ERROR_MESSAGES)).toBe(true);
  });
});
