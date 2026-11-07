import { describe, expect, it } from 'vitest';

import {
  ROUTING_DOMAIN_ERROR_MESSAGES,
  isRoutingDomainError,
  routingDomainError,
  type RoutingDomainErrorCode,
} from './errors';

describe('domain errors', () => {
  it('builds an error from a code with the canonical English message', () => {
    const error = routingDomainError('fallback_not_allowed');
    expect(error.code).toBe('fallback_not_allowed');
    expect(error.message).toBe('Fallback is not allowed for the current attempt evidence.');
    expect(ROUTING_DOMAIN_ERROR_MESSAGES['fallback_not_allowed']).toBe(error.message);
  });

  it('recognizes its own errors and rejects foreign shapes', () => {
    expect(isRoutingDomainError(routingDomainError('no_eligible_candidate'))).toBe(true);
    expect(isRoutingDomainError({ code: 'unknown_code', message: 'x' })).toBe(false);
    expect(isRoutingDomainError({ code: 'alias_retired' })).toBe(false);
    expect(isRoutingDomainError(null)).toBe(false);
    expect(isRoutingDomainError('alias_retired')).toBe(false);
    expect(isRoutingDomainError(new Error('plain'))).toBe(false);
  });

  it('carries only code and message — no secret-shaped fields', () => {
    const error: unknown = routingDomainError('alias_not_found');
    expect(Object.keys(error as Record<string, unknown>).toSorted()).toEqual(['code', 'message']);
  });

  it('covers all error codes with non-empty English messages', () => {
    const codes: readonly RoutingDomainErrorCode[] = [
      'invalid_alias',
      'alias_not_found',
      'alias_retired',
      'invalid_policy_version',
      'invalid_candidate',
      'no_eligible_candidate',
      'fallback_not_allowed',
      'fallback_exhausted',
      'invalid_strategy_input',
      'invalid_snapshot',
    ];
    for (const code of codes) {
      const msg = ROUTING_DOMAIN_ERROR_MESSAGES[code];
      expect(typeof msg).toBe('string');
      expect(msg.trim().length).toBeGreaterThan(0);
    }
  });
});
