import { describe, expect, it } from 'vitest';

import {
  domainErrorKeys,
  isLLMUsageDomainError,
  llmUsageDomainError,
  LLM_USAGE_DOMAIN_ERROR_MESSAGES,
  type DomainErrorCode,
} from './index';

describe('LLM_USAGE_DOMAIN_ERROR_MESSAGES', () => {
  it('covers every error code', () => {
    const codes: DomainErrorCode[] = [
      'invalid_usage',
      'invalid_token_count',
      'invalid_correction',
      'unknown_normalizer_version',
      'usage_missing',
      'usage_malformed',
    ];
    for (const code of codes) {
      expect(LLM_USAGE_DOMAIN_ERROR_MESSAGES[code]).toBeDefined();
      expect(typeof LLM_USAGE_DOMAIN_ERROR_MESSAGES[code]).toBe('string');
      expect(LLM_USAGE_DOMAIN_ERROR_MESSAGES[code].length).toBeGreaterThan(0);
    }
  });
});

describe('llmUsageDomainError', () => {
  it('builds error from code with canonical English message', () => {
    const error = llmUsageDomainError('usage_missing');
    expect(error.code).toBe('usage_missing');
    expect(error.message).toBe('Usage is missing from provider.');
    expect(LLM_USAGE_DOMAIN_ERROR_MESSAGES['usage_missing']).toBe(error.message);
  });

  it.each([
    'invalid_usage',
    'invalid_token_count',
    'invalid_correction',
    'unknown_normalizer_version',
    'usage_malformed',
  ])('builds error for %s', (code) => {
    const error = llmUsageDomainError(code as DomainErrorCode);
    expect(error.code).toBe(code);
  });

  it('carries only code and message fields (no secret-shaped fields)', () => {
    const error: unknown = llmUsageDomainError('invalid_token_count');
    expect(Object.keys(error as Record<string, unknown>).toSorted()).toEqual(['code', 'message']);
  });
});

describe('isLLMUsageDomainError', () => {
  it('recognizes its own errors and rejects foreign shapes', () => {
    expect(isLLMUsageDomainError(llmUsageDomainError('usage_malformed'))).toBe(true);
    expect(isLLMUsageDomainError({ code: 'unknown_code', message: 'x' })).toBe(false);
    expect(isLLMUsageDomainError({ code: 'usage_missing' })).toBe(false); // missing message
    expect(isLLMUsageDomainError(null)).toBe(false);
    expect(isLLMUsageDomainError('usage_missing')).toBe(false);
    expect(isLLMUsageDomainError(new Error('plain'))).toBe(false);
  });
});

describe('domainErrorKeys', () => {
  it('returns exactly code and message', () => {
    expect(domainErrorKeys(llmUsageDomainError('invalid_usage')).toSorted()).toEqual([
      'code',
      'message',
    ]);
  });
});
