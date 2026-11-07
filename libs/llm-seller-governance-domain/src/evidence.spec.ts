import { describe, expect, it } from 'vitest';

import { createSellerActorId, createSellerTenantId } from '@ecoma-io/llm-seller-tenant-domain';
import { createEvidenceId } from './shared';
import {
  assertEvidenceInTenant,
  createEvidenceReference,
  isEvidenceReference,
  type EvidenceReference,
} from './evidence';

function expectOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: { code: string } },
): Value {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function expectRejection(result: { ok: true } | { ok: false; error: { code: string } }): string {
  if (result.ok) {
    throw new Error('expected rejection, got ok');
  }
  return result.error.code;
}

const TENANT = createSellerTenantId('tenant-1');
const OTHER_TENANT = createSellerTenantId('tenant-2');
const ACTOR = createSellerActorId('member-1');
const AT = 1_700_000_000_000;

function evidence(
  overrides: Partial<Parameters<typeof createEvidenceReference>[0]> = {},
): EvidenceReference {
  return expectOk(
    createEvidenceReference({
      id: createEvidenceId('e-1'),
      tenantId: TENANT,
      kind: 'business_registration',
      storageRef: 'blob://evidence/tenant-1/e-1',
      contentHash: 'sha256:abc',
      recordedAt: AT,
      recordedBy: ACTOR,
      ...overrides,
    }),
  );
}

describe('createEvidenceReference', () => {
  it('records an immutable reference without exposing content', () => {
    const created = evidence();
    expect(created.storageRef).toBe('blob://evidence/tenant-1/e-1');
    expect(created).not.toHaveProperty('status');
    expect(Object.isFrozen(created)).toBe(true);
  });

  it('rejects malformed references', () => {
    expect(
      expectRejection(
        createEvidenceReference({
          id: '',
          tenantId: TENANT,
          kind: 'business_registration',
          storageRef: 'blob://x',
          contentHash: 'sha256:abc',
          recordedAt: AT,
          recordedBy: ACTOR,
        }),
      ),
    ).toBe('invalid_evidence_id');
    expect(
      expectRejection(
        createEvidenceReference({
          id: createEvidenceId('e-1'),
          tenantId: TENANT,
          kind: '',
          storageRef: 'blob://x',
          contentHash: 'sha256:abc',
          recordedAt: AT,
          recordedBy: ACTOR,
        }),
      ),
    ).toBe('invalid_evidence_reference');
    expect(
      expectRejection(
        createEvidenceReference({
          id: createEvidenceId('e-1'),
          tenantId: TENANT,
          kind: 'business_registration',
          storageRef: 'blob://x',
          contentHash: 'sha256:abc',
          recordedAt: AT,
          recordedBy: '',
        }),
      ),
    ).toBe('invalid_actor');
    expect(
      expectRejection(
        createEvidenceReference({
          id: createEvidenceId('e-1'),
          tenantId: TENANT,
          kind: 'business_registration',
          storageRef: 'blob://x',
          contentHash: 'sha256:abc',
          recordedAt: 'yesterday',
          recordedBy: ACTOR,
        }),
      ),
    ).toBe('invalid_timestamp');
  });

  it('rejects a duplicate id and a cross-tenant collection', () => {
    const existing = evidence();
    expect(
      expectRejection(
        createEvidenceReference({
          id: createEvidenceId('e-1'),
          tenantId: TENANT,
          kind: 'business_registration',
          storageRef: 'blob://x',
          contentHash: 'sha256:abc',
          recordedAt: AT,
          recordedBy: ACTOR,
          existing: [existing],
        }),
      ),
    ).toBe('duplicate_evidence_reference_id');

    const foreign = evidence({ id: createEvidenceId('e-2'), tenantId: OTHER_TENANT });
    expect(
      expectRejection(
        createEvidenceReference({
          id: createEvidenceId('e-3'),
          tenantId: TENANT,
          kind: 'business_registration',
          storageRef: 'blob://x',
          contentHash: 'sha256:abc',
          recordedAt: AT,
          recordedBy: ACTOR,
          existing: [foreign],
        }),
      ),
    ).toBe('inconsistent_context');

    expect(
      expectRejection(
        createEvidenceReference({
          id: createEvidenceId('e-4'),
          tenantId: TENANT,
          kind: 'business_registration',
          storageRef: 'blob://x',
          contentHash: 'sha256:abc',
          recordedAt: AT,
          recordedBy: ACTOR,
          existing: [null] as never,
        }),
      ),
    ).toBe('invalid_evidence_reference');
  });
});

describe('assertEvidenceInTenant', () => {
  it('returns the reference for the matching tenant', () => {
    const reference = evidence();
    expect(expectOk(assertEvidenceInTenant(reference, TENANT))).toBe(reference);
  });

  it('rejects evidence from another tenant', () => {
    expect(expectRejection(assertEvidenceInTenant(evidence(), OTHER_TENANT))).toBe(
      'evidence_not_in_tenant',
    );
  });

  it('rejects an invalid tenant id', () => {
    expect(expectRejection(assertEvidenceInTenant(evidence(), '' as never))).toBe(
      'invalid_seller_tenant_id',
    );
  });

  it('rejects a corrupted reference instead of throwing', () => {
    expect(expectRejection(assertEvidenceInTenant(null as never, TENANT))).toBe(
      'invalid_evidence_reference',
    );
  });
});

describe('isEvidenceReference', () => {
  it('rejects inconsistent shapes', () => {
    const good = evidence();
    expect(isEvidenceReference(good)).toBe(true);
    expect(isEvidenceReference({ ...good, contentHash: '' })).toBe(false);
    expect(isEvidenceReference({ ...good, kind: undefined })).toBe(false);
  });
});
