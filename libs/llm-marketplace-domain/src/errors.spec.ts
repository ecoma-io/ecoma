import { describe, expect, it } from 'vitest';

import {
  LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES,
  isLlmMarketplaceDomainError,
  llmMarketplaceDomainError,
  llmMarketplaceFailure,
  llmMarketplaceOk,
  type LlmMarketplaceDomainErrorCode,
} from './index';

const ALL_CODES: readonly LlmMarketplaceDomainErrorCode[] = Object.keys(
  LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES,
) as LlmMarketplaceDomainErrorCode[];

describe('LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES', () => {
  it('covers every declared code with a non-empty English message', () => {
    expect(ALL_CODES.length).toBeGreaterThan(0);
    for (const code of ALL_CODES) {
      expect(LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES[code]).toBeTypeOf('string');
      expect(LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
      expect(LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES[code].endsWith('.')).toBe(true);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(LLM_MARKETPLACE_DOMAIN_ERROR_MESSAGES)).toBe(true);
  });

  it('matches the declared code union exactly', () => {
    expect(ALL_CODES.toSorted()).toEqual(
      [
        'ambiguous_context',
        'credential_already_revoked',
        'credential_provider_mismatch',
        'credential_revoked',
        'credential_tenant_mismatch',
        'duplicate_endpoint_pool_id',
        'duplicate_fallback_entry',
        'duplicate_model_offer_id',
        'duplicate_provider_credential_id',
        'duplicate_provider_model',
        'duplicate_upstream_endpoint_id',
        'eligibility_tenant_mismatch',
        'endpoint_health_unchanged',
        'endpoint_not_in_pool',
        'endpoint_pool_mismatch',
        'endpoint_pool_missing',
        'endpoint_pool_not_healthy',
        'fallback_endpoint_not_in_pool',
        'fallback_pool_not_in_offer',
        'inconsistent_context',
        'invalid_actor',
        'invalid_capability',
        'invalid_capability_set',
        'invalid_credential_hash',
        'invalid_credential_plaintext',
        'invalid_eligibility_verdict',
        'invalid_endpoint_health',
        'invalid_endpoint_pool',
        'invalid_endpoint_pool_id',
        'invalid_endpoint_protocol',
        'invalid_endpoint_url',
        'invalid_endpoint_weight',
        'invalid_fallback_config',
        'invalid_model_offer',
        'invalid_model_offer_id',
        'invalid_normalized_model_id',
        'invalid_offer_transition',
        'invalid_provider_credential',
        'invalid_provider_credential_id',
        'invalid_provider_key',
        'invalid_provider_model_identity',
        'invalid_provider_model_name',
        'invalid_public_alias',
        'invalid_seller_tenant_id',
        'invalid_timestamp',
        'invalid_upstream_endpoint',
        'invalid_upstream_endpoint_id',
        'offer_already_active',
        'offer_already_inactive',
        'offer_retired',
        'pool_offer_mismatch',
        'public_alias_immutable',
        'seller_not_eligible',
        'timestamp_regression',
      ].toSorted(),
    );
  });
});

describe('llmMarketplaceDomainError', () => {
  it('builds a frozen error carrying only code and message', () => {
    const error = llmMarketplaceDomainError('offer_retired');
    expect(error.code).toBe('offer_retired');
    expect(error.message).toBe('The model offer is retired and can no longer change state.');
    expect(Object.keys(error).toSorted()).toEqual(['code', 'message']);
    expect(Object.isFrozen(error)).toBe(true);
  });

  it('throws TypeError for a code outside the taxonomy', () => {
    expect(() => llmMarketplaceDomainError('not_a_code' as LlmMarketplaceDomainErrorCode)).toThrow(
      TypeError,
    );
  });
});

describe('isLlmMarketplaceDomainError', () => {
  it('recognizes its own errors and rejects foreign shapes', () => {
    expect(isLlmMarketplaceDomainError(llmMarketplaceDomainError('invalid_timestamp'))).toBe(true);
    expect(isLlmMarketplaceDomainError({ code: 'offer_retired' })).toBe(false);
    expect(
      isLlmMarketplaceDomainError({ code: 'offer_retired', message: 'tampered', extra: 1 }),
    ).toBe(false);
    expect(
      isLlmMarketplaceDomainError({
        code: 'offer_retired',
        message: 'A different message.',
      }),
    ).toBe(false);
    expect(isLlmMarketplaceDomainError({ code: 'toString', message: 'x' })).toBe(false);
    expect(isLlmMarketplaceDomainError(null)).toBe(false);
    expect(isLlmMarketplaceDomainError('offer_retired')).toBe(false);
  });
});

describe('result helpers', () => {
  it('llmMarketplaceOk freezes the branch and returns the value', () => {
    const result = llmMarketplaceOk({ value: 1 });
    expect(result).toEqual({ ok: true, value: { value: 1 } });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('llmMarketplaceFailure freezes the branch and carries a canonical error', () => {
    const result = llmMarketplaceFailure('invalid_timestamp');
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected a failure branch');
    }
    expect(result.error.code).toBe('invalid_timestamp');
    expect(isLlmMarketplaceDomainError(result.error)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
