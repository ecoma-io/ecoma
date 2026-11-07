import { describe, expect, it } from 'vitest';

import {
  isRemoteCacheDomainError,
  REMOTE_CACHE_DOMAIN_ERROR_MESSAGES,
  remoteCacheDomainError,
} from './errors';

describe('remote-cache domain errors', () => {
  it('builds an error from a code with the canonical English message', () => {
    const error = remoteCacheDomainError('tenant_suspended');
    expect(error.code).toBe('tenant_suspended');
    expect(error.message).toBe('Tenant is suspended.');
    expect(REMOTE_CACHE_DOMAIN_ERROR_MESSAGES['tenant_suspended']).toBe(error.message);
  });

  it('recognizes its own errors and rejects foreign shapes', () => {
    expect(isRemoteCacheDomainError(remoteCacheDomainError('api_key_revoked'))).toBe(true);
    expect(isRemoteCacheDomainError({ code: 'unknown_code', message: 'x' })).toBe(false);
    expect(isRemoteCacheDomainError({ code: 'tenant_deleted' })).toBe(false);
    expect(isRemoteCacheDomainError(null)).toBe(false);
    expect(isRemoteCacheDomainError('tenant_deleted')).toBe(false);
    expect(isRemoteCacheDomainError(new Error('plain'))).toBe(false);
  });

  it('carries no secret-shaped fields on the error object', () => {
    const error: unknown = remoteCacheDomainError('api_key_not_found');
    expect(Object.keys(error as Record<string, unknown>).toSorted()).toEqual(['code', 'message']);
  });
});
