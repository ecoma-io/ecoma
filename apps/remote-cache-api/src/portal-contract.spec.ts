/**
 * Unit spec cho wire shapes portal (src/portal-contract.ts) — colocated,
 * khong cham DB (06-testing.md §4). Ghim nhung hop dong ma portal BFF (#180)
 * se phu thuoc: shape dong, khong truong la, va khong secret tren metadata.
 */
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS,
  PORTAL_API_KEY_SCOPES,
  PORTAL_CREDENTIAL_CLASSES,
  portalCredentialClassOf,
  validatePortalApiKeyMetadata,
  validatePortalCreateApiKeyRequest,
  validatePortalCreateProjectRequest,
} from './portal-contract';

const VALID_METADATA = {
  id: '0b6fd7e1-5b0a-4c1e-9c7f-2a3b4c5d6e7f',
  project_id: '1a2b3c4d-5e6f-4a1b-8c9d-0e1f2a3b4c5d',
  scopes: ['read'],
  credential_class: 'developer',
  revoked_at: null,
  created_at: '2026-11-14T00:00:00.000Z',
} as const;

describe('portal contract (unit)', () => {
  it('mints developer credentials only: fixed read scope and the two credential classes', () => {
    // R20: portal khong cap write hay trusted CI — tap nhat dinh.
    expect(PORTAL_API_KEY_SCOPES).toEqual(['read']);
    expect(PORTAL_CREDENTIAL_CLASSES).toEqual(['developer', 'trusted_ci']);
    expect(portalCredentialClassOf(false)).toBe('developer');
    expect(portalCredentialClassOf(true)).toBe('trusted_ci');
  });

  describe('validatePortalCreateProjectRequest', () => {
    it('accepts a request that carries exactly the name', () => {
      const checked = validatePortalCreateProjectRequest({ name: 'my-project' });
      expect(checked).toEqual({ ok: true, payload: { name: 'my-project' } });
    });

    it('rejects a non-object payload and a missing name', () => {
      expect(validatePortalCreateProjectRequest('nope').ok).toBe(false);
      expect(validatePortalCreateProjectRequest(null).ok).toBe(false);
      expect(validatePortalCreateProjectRequest([]).ok).toBe(false);
      expect(validatePortalCreateProjectRequest({}).ok).toBe(false);
      expect(validatePortalCreateProjectRequest({ name: '' }).ok).toBe(false);
    });

    it('rejects any field outside the contract, including trusted_ci and api_key_scopes', () => {
      // R20: caller khong duoc chon phan lop hay scope tren duong portal.
      expect(validatePortalCreateProjectRequest({ name: 'p', trusted_ci: true }).ok).toBe(false);
      expect(validatePortalCreateProjectRequest({ name: 'p', api_key_scopes: ['read'] }).ok).toBe(
        false,
      );
      const checked = validatePortalCreateProjectRequest({ name: 'p', trusted_ci: true });
      expect(!checked.ok && checked.reason).toBe('forbidden_field');
    });

    it('rejects a name outside the DNS-like lowercase pattern', () => {
      expect(validatePortalCreateProjectRequest({ name: 'UPPER' }).ok).toBe(false);
      expect(validatePortalCreateProjectRequest({ name: '-lead' }).ok).toBe(false);
      // Pattern cho phep dung 64 ky tu (1 + toi da 63) — 65 la tu choi.
      expect(validatePortalCreateProjectRequest({ name: 'a'.repeat(64) }).ok).toBe(true);
      expect(validatePortalCreateProjectRequest({ name: 'a'.repeat(65) }).ok).toBe(false);
      expect(validatePortalCreateProjectRequest({ name: 'has space' }).ok).toBe(false);
    });
  });

  describe('validatePortalCreateApiKeyRequest', () => {
    it('accepts only the empty object — the portal takes no scope or class choice', () => {
      const checked = validatePortalCreateApiKeyRequest({});
      expect(checked.ok).toBe(true);
    });

    it('rejects non-object payloads and any field', () => {
      expect(validatePortalCreateApiKeyRequest(null).ok).toBe(false);
      expect(validatePortalCreateApiKeyRequest('x').ok).toBe(false);
      expect(validatePortalCreateApiKeyRequest([]).ok).toBe(false);
      const checked = validatePortalCreateApiKeyRequest({ trusted_ci: true });
      expect(checked.ok).toBe(false);
      expect(!checked.ok && checked.reason).toBe('forbidden_field');
      const scopes = validatePortalCreateApiKeyRequest({ scopes: ['read', 'write'] });
      expect(scopes.ok).toBe(false);
    });
  });

  describe('validatePortalApiKeyMetadata', () => {
    it('accepts a well-formed developer key metadata', () => {
      const checked = validatePortalApiKeyMetadata({ ...VALID_METADATA });
      expect(checked.ok).toBe(true);
    });

    it('accepts a revoked trusted key metadata with an ISO revoked_at', () => {
      const checked = validatePortalApiKeyMetadata({
        ...VALID_METADATA,
        credential_class: 'trusted_ci',
        revoked_at: '2026-11-14T12:00:00.000Z',
      });
      expect(checked.ok).toBe(true);
    });

    it('rejects any credential field on the wire — token and hash never travel', () => {
      for (const field of FORBIDDEN_PORTAL_KEY_CREDENTIAL_FIELDS) {
        const withSecret = { ...VALID_METADATA, [field]: 'whatever' };
        const checked = validatePortalApiKeyMetadata(withSecret);
        expect(checked.ok).toBe(false);
        expect(!checked.ok && checked.reason).toBe('forbidden_field');
        // Message cu the cho secret/hash — khac voi message truong la thong
        // qua, de nguoi goi API hieu day la tu choi ve secret chu khong phai
        // truong la.
        expect(!checked.ok && checked.detail).toBe(
          'API key metadata must never carry a credential secret or hash.',
        );
      }
    });

    it('rejects unknown fields, bad uuids, bad scopes and bad timestamps', () => {
      const unknownField = validatePortalApiKeyMetadata({ ...VALID_METADATA, extra: 1 });
      expect(unknownField.ok).toBe(false);
      expect(!unknownField.ok && unknownField.detail).toBe(
        'API key metadata carries a field outside the contract: extra.',
      );
      expect(validatePortalApiKeyMetadata({ ...VALID_METADATA, id: 'not-a-uuid' }).ok).toBe(false);
      expect(validatePortalApiKeyMetadata({ ...VALID_METADATA, project_id: '' }).ok).toBe(false);
      expect(validatePortalApiKeyMetadata({ ...VALID_METADATA, scopes: [] }).ok).toBe(false);
      expect(validatePortalApiKeyMetadata({ ...VALID_METADATA, scopes: ['admin'] }).ok).toBe(false);
      expect(validatePortalApiKeyMetadata({ ...VALID_METADATA, credential_class: 'root' }).ok).toBe(
        false,
      );
      expect(validatePortalApiKeyMetadata({ ...VALID_METADATA, created_at: 'nope' }).ok).toBe(
        false,
      );
      expect(validatePortalApiKeyMetadata({ ...VALID_METADATA, revoked_at: 42 }).ok).toBe(false);
      expect(validatePortalApiKeyMetadata(null).ok).toBe(false);
      expect(validatePortalApiKeyMetadata('x').ok).toBe(false);
    });
  });
});
