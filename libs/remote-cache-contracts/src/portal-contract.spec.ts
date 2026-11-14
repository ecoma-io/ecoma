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
    expectRejectedBy(missing, 'invalid_payload', 'name');

    const malformed = validatePortalCreateProjectRequest({ name: 'Orders' });
    expectRejectedBy(malformed, 'invalid_project_name', 'DNS-like');
  });

  it('rejects any field outside the contract — the portal never takes credential choices', () => {
    const trusted = validatePortalCreateProjectRequest({ name: 'orders', trusted_ci: true });
    expectRejectedBy(trusted, 'forbidden_field', 'trusted CI');

    const scopes = validatePortalCreateProjectRequest({ name: 'orders', scopes: ['write'] });
    expectRejectedBy(scopes, 'forbidden_field', 'developer credentials only');
  });

  it('rejects non-object payloads', () => {
    expectRejectedBy(
      validatePortalCreateProjectRequest('orders'),
      'invalid_payload',
      'JSON object',
    );
    expectRejectedBy(validatePortalCreateProjectRequest(null), 'invalid_payload', 'JSON object');
  });
});

describe('portal create-key request', () => {
  it('accepts only the empty object', () => {
    expect(validatePortalCreateApiKeyRequest({})).toEqual({ ok: true, payload: {} });
  });

  it('rejects every field — scopes and credential class are never caller choices', () => {
    const scoped = validatePortalCreateApiKeyRequest({ scopes: ['write'] });
    expectRejectedBy(scoped, 'forbidden_field', 'fixed read scope');

    const trusted = validatePortalCreateApiKeyRequest({ trusted_ci: true });
    expectRejectedBy(trusted, 'forbidden_field', 'never trusted CI');
  });

  it('rejects non-object payloads', () => {
    expectRejectedBy(validatePortalCreateApiKeyRequest(null), 'invalid_payload', 'JSON object');
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
      expectRejectedBy(leaked, 'forbidden_field', 'credential secret or hash');
    }
  });

  it('rejects a field outside the contract', () => {
    // `token_hash: undefined` vẫn mang key (excess check của object literal) —
    // hợp đồng từ chối theo đúng luật credential-field trước luật field-lạ.
    const extra = validatePortalApiKeyMetadata({ ...VALID_METADATA, token_hash: undefined });
    expectRejectedBy(extra, 'forbidden_field', 'credential secret or hash');

    const unknown = validatePortalApiKeyMetadata({ ...VALID_METADATA, usage: 5 });
    expectRejectedBy(unknown, 'forbidden_field', 'usage');
  });

  it('rejects a missing or malformed required field', () => {
    const noProject = validatePortalApiKeyMetadata({ ...VALID_METADATA, project_id: undefined });
    expectRejectedBy(noProject, 'invalid_payload', 'project_id');

    const badId = validatePortalApiKeyMetadata({ ...VALID_METADATA, id: 'not-a-uuid' });
    expectRejectedBy(badId, 'invalid_payload', 'UUID');

    const badScope = validatePortalApiKeyMetadata({ ...VALID_METADATA, scopes: ['admin'] });
    expectRejectedBy(badScope, 'invalid_scopes', 'read/write');

    const emptyScope = validatePortalApiKeyMetadata({ ...VALID_METADATA, scopes: [] });
    expectRejectedBy(emptyScope, 'invalid_scopes', 'read/write');

    const duplicateScope = validatePortalApiKeyMetadata({
      ...VALID_METADATA,
      scopes: ['read', 'read'],
    });
    expectRejectedBy(duplicateScope, 'invalid_scopes', 'read/write');

    const badClass = validatePortalApiKeyMetadata({ ...VALID_METADATA, credential_class: 'root' });
    expectRejectedBy(badClass, 'invalid_payload', 'developer, trusted_ci');

    const badRevoked = validatePortalApiKeyMetadata({ ...VALID_METADATA, revoked_at: 'yesterday' });
    expectRejectedBy(badRevoked, 'invalid_payload', 'ISO timestamp');

    const badCreated = validatePortalApiKeyMetadata({ ...VALID_METADATA, created_at: 7 });
    expectRejectedBy(badCreated, 'invalid_payload', 'ISO timestamp');
  });

  it('rejects non-object payloads', () => {
    expectRejectedBy(validatePortalApiKeyMetadata('metadata'), 'invalid_payload', 'object');
    expectRejectedBy(validatePortalApiKeyMetadata(null), 'invalid_payload', 'object');
  });
});
