/**
 * Ghim taxonomy domain error: factory đọc đúng nguồn message, guard không nhận
 * code từ prototype chain, và error object không có chỗ cho payload.
 */

import { describe, expect, it } from 'vitest';

import {
  LLM_TENANT_DOMAIN_ERROR_MESSAGES,
  isLlmTenantDomainError,
  llmTenantDomainError,
  type LlmTenantDomainErrorCode,
} from './errors';

describe('llmTenantDomainError', () => {
  it('pairs every declared code with its table message', () => {
    for (const code of Object.keys(LLM_TENANT_DOMAIN_ERROR_MESSAGES)) {
      const error = llmTenantDomainError(code as LlmTenantDomainErrorCode);
      expect(error.code).toEqual(code);
      expect(error.message).toEqual(
        LLM_TENANT_DOMAIN_ERROR_MESSAGES[code as LlmTenantDomainErrorCode],
      );
    }
  });

  it('keeps every message in English', () => {
    for (const message of Object.values(LLM_TENANT_DOMAIN_ERROR_MESSAGES)) {
      expect(message).toMatch(/^[A-Z][\x20-\x7e]*\.$/u);
    }
  });

  it('rejects a code outside the taxonomy with a TypeError', () => {
    // @ts-expect-error -- cast a value that is not in the union on purpose.
    expect(() => llmTenantDomainError('totally_unknown_code')).toThrow(TypeError);
  });
});

describe('isLlmTenantDomainError', () => {
  it('accepts only objects whose code is in the taxonomy', () => {
    expect(isLlmTenantDomainError(llmTenantDomainError('invalid_tenant_id'))).toBe(true);
    expect(isLlmTenantDomainError({ code: 'toString' })).toBe(false);
    expect(isLlmTenantDomainError({ code: 'invalid_tenant_id', extra: 'payload' })).toBe(false);
    expect(isLlmTenantDomainError(null)).toBe(false);
    expect(isLlmTenantDomainError('invalid_tenant_id')).toBe(false);
  });
});
