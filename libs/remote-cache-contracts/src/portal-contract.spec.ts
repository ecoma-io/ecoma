import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS,
  PORTAL_API_KEY_SCOPES,
  PORTAL_CREDENTIAL_CLASSES,
  portalCredentialClassOf,
  validatePortalApiKeyMetadata,
  validatePortalCreateApiKeyRequest,
  validatePortalCreateProjectRequest,
  type PortalApiKeyMetadata,
  type RemoteCacheControlPlaneRejectionReason,
  type RemoteCacheControlPlaneValidation,
} from './portal-contract';

const VALID_METADATA: PortalApiKeyMetadata = {
  id: '0f0e0d0c-0b0a-4948-8276-5f4e3d2c1b0a',
  project_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  scopes: ['read'],
  credential_class: 'developer',
  revoked_at: null,
  created_at: '2026-11-14T00:00:00Z',
};

/** Assert payload bị từ chối với `reason` và `detail` chứa `fragment`. */
function expectRejectedBy(
  result: RemoteCacheControlPlaneValidation<unknown>,
  reason: RemoteCacheControlPlaneRejectionReason,
  fragment: string,
): void {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok) {
    throw new Error('Expected the payload to be rejected, but it was accepted.');
  }
  expect(result.detail).toContain(fragment);
}

describe('portal credential classes', () => {
  it('maps the trusted_ci column to the wire class', () => {
    expect(portalCredentialClassOf(false)).toBe('developer');
    expect(portalCredentialClassOf(true)).toBe('trusted_ci');
    expect(PORTAL_CREDENTIAL_CLASSES).toEqual(['developer', 'trusted_ci']);
  });

  it('pins the portal mint scope to read-only', () => {
    expect(PORTAL_API_KEY_SCOPES).toEqual(['read']);
  });
});

describe('portal create-project request', () => {
  it('accepts a lowercase DNS-like name and nothing else', () => {
    expect(validatePortalCreateProjectRequest({ name: 'orders-cache' })).toEqual({
      ok: true,
      payload: { name: 'orders-cache' },
    });
  });

  it('rejects a missing or malformed name', () => {
    const missing = validatePortalCreateProjectRequest({});
    expect(missing.ok).toBe(false);
    expectRejectedBy(missing, 'invalid_payload', 'name');

    const malformed = validatePortalCreateProjectRequest({ name: 'Orders' });
    expect(malformed.ok).toBe(false);
    expectRejectedBy(malformed, 'invalid_project_name', 'DNS-like');
  });

  it('rejects any field outside the contract — the portal never takes credential choices', () => {
    const trusted = validatePortalCreateProjectRequest({ name: 'orders', trusted_ci: true });
    expect(trusted.ok).toBe(false);
    expectRejectedBy(trusted, 'forbidden_field', 'trusted CI');

    const scopes = validatePortalCreateProjectRequest({ name: 'orders', scopes: ['write'] });
    expect(scopes.ok).toBe(false);
    expectRejectedBy(scopes, 'forbidden_field', 'developer credentials only');
  });

  it('rejects non-object payloads', () => {
    const text = validatePortalCreateProjectRequest('orders');
    expect(text.ok).toBe(false);
    expectRejectedBy(text, 'invalid_payload', 'JSON object');

    const none = validatePortalCreateProjectRequest(null);
    expect(none.ok).toBe(false);
    expectRejectedBy(none, 'invalid_payload', 'JSON object');
  });
});

describe('portal create-key request', () => {
  it('accepts only the empty object', () => {
    expect(validatePortalCreateApiKeyRequest({})).toEqual({ ok: true, payload: {} });
  });

  it('rejects every field — scopes and credential class are never caller choices', () => {
    const scoped = validatePortalCreateApiKeyRequest({ scopes: ['write'] });
    expect(scoped.ok).toBe(false);
    expectRejectedBy(scoped, 'forbidden_field', 'fixed read scope');

    const trusted = validatePortalCreateApiKeyRequest({ trusted_ci: true });
    expect(trusted.ok).toBe(false);
    expectRejectedBy(trusted, 'forbidden_field', 'never trusted CI');
  });

  it('rejects non-object payloads', () => {
    const none = validatePortalCreateApiKeyRequest(null);
    expect(none.ok).toBe(false);
    expectRejectedBy(none, 'invalid_payload', 'JSON object');
  });
});

describe('portal api-key metadata', () => {
  it('accepts a valid developer key metadata', () => {
    expect(validatePortalApiKeyMetadata(VALID_METADATA)).toEqual({
      ok: true,
      payload: VALID_METADATA,
    });
  });

  it('accepts a trusted CI key metadata with a read+write scope set', () => {
    const trusted: PortalApiKeyMetadata = {
      ...VALID_METADATA,
      scopes: ['read', 'write'],
      credential_class: 'trusted_ci',
    };
    expect(validatePortalApiKeyMetadata(trusted)).toEqual({ ok: true, payload: trusted });
  });

  it('accepts a revoked key with an ISO revoked_at timestamp', () => {
    const revoked: PortalApiKeyMetadata = {
      ...VALID_METADATA,
      revoked_at: '2026-11-15T10:00:00Z',
    };
    expect(validatePortalApiKeyMetadata(revoked)).toEqual({ ok: true, payload: revoked });
  });

  it('rejects every forbidden credential field by name', () => {
    for (const field of FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS) {
      const leaked = validatePortalApiKeyMetadata({ ...VALID_METADATA, [field]: 'leak' });
      expect(leaked.ok).toBe(false);
      expectRejectedBy(leaked, 'forbidden_field', 'credential secret or hash');
    }
  });

  it('rejects a field outside the contract', () => {
    // `token_hash: undefined` vẫn mang key (excess check của object literal) —
    // hợp đồng từ chối theo đúng luật credential-field trước luật field-lạ.
    const extra = validatePortalApiKeyMetadata({ ...VALID_METADATA, token_hash: undefined });
    expect(extra.ok).toBe(false);
    expectRejectedBy(extra, 'forbidden_field', 'credential secret or hash');

    const unknown = validatePortalApiKeyMetadata({ ...VALID_METADATA, usage: 5 });
    expect(unknown.ok).toBe(false);
    expectRejectedBy(unknown, 'forbidden_field', 'usage');
  });

  it('rejects a missing or malformed required field', () => {
    const noProject = validatePortalApiKeyMetadata({ ...VALID_METADATA, project_id: undefined });
    expect(noProject.ok).toBe(false);
    expectRejectedBy(noProject, 'invalid_payload', 'project_id');

    const badId = validatePortalApiKeyMetadata({ ...VALID_METADATA, id: 'not-a-uuid' });
    expect(badId.ok).toBe(false);
    expectRejectedBy(badId, 'invalid_payload', 'UUID');

    const badScope = validatePortalApiKeyMetadata({ ...VALID_METADATA, scopes: ['admin'] });
    expect(badScope.ok).toBe(false);
    expectRejectedBy(badScope, 'invalid_scopes', 'read/write');

    const emptyScope = validatePortalApiKeyMetadata({ ...VALID_METADATA, scopes: [] });
    expect(emptyScope.ok).toBe(false);
    expectRejectedBy(emptyScope, 'invalid_scopes', 'read/write');

    const duplicateScope = validatePortalApiKeyMetadata({
      ...VALID_METADATA,
      scopes: ['read', 'read'],
    });
    expect(duplicateScope.ok).toBe(false);
    expectRejectedBy(duplicateScope, 'invalid_scopes', 'read/write');

    const badClass = validatePortalApiKeyMetadata({ ...VALID_METADATA, credential_class: 'root' });
    expect(badClass.ok).toBe(false);
    expectRejectedBy(badClass, 'invalid_payload', 'developer, trusted_ci');

    const badRevoked = validatePortalApiKeyMetadata({ ...VALID_METADATA, revoked_at: 'yesterday' });
    expect(badRevoked.ok).toBe(false);
    expectRejectedBy(badRevoked, 'invalid_payload', 'ISO timestamp');

    const badCreated = validatePortalApiKeyMetadata({ ...VALID_METADATA, created_at: 7 });
    expect(badCreated.ok).toBe(false);
    expectRejectedBy(badCreated, 'invalid_payload', 'ISO timestamp');
  });

  it('rejects non-object payloads', () => {
    const text = validatePortalApiKeyMetadata('metadata');
    expect(text.ok).toBe(false);
    expectRejectedBy(text, 'invalid_payload', 'object');

    const none = validatePortalApiKeyMetadata(null);
    expect(none.ok).toBe(false);
    expectRejectedBy(none, 'invalid_payload', 'object');
  });
});
