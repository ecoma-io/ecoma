import { describe, expect, it } from 'vitest';

import { createSellerActorId, createSellerTenantId } from '@ecoma-io/llm-seller-tenant-domain';
import {
  appendTaxProfileVersion,
  isTaxProfileVersion,
  taxProfileVersionAt,
  type TaxProfileVersion,
} from './tax-profile';

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
const ACTOR = createSellerActorId('owner-1');
const AT = 1_700_000_000_000;

function taxInput(
  effectiveFrom: number,
  tenantId = TENANT,
): Parameters<typeof appendTaxProfileVersion>[1] {
  return {
    tenantId,
    taxResidency: 'VN',
    taxIdentifier: 'TAX-1',
    declarationReference: 'DECL-1',
    effectiveFrom,
    recordedAt: AT,
    recordedBy: ACTOR,
  };
}

describe('appendTaxProfileVersion', () => {
  it('versions independently from the legal profile', () => {
    const versions = expectOk(appendTaxProfileVersion([], taxInput(AT)));
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.taxResidency).toBe('VN');
    expect(isTaxProfileVersion(versions[0])).toBe(true);
  });

  it('appends a new version and keeps the previous one', () => {
    const first = expectOk(appendTaxProfileVersion([], taxInput(AT)));
    const second = expectOk(appendTaxProfileVersion(first, taxInput(AT + 100)));
    expect(first).toHaveLength(1);
    expect(second.map((version) => version.version)).toEqual([1, 2]);
  });

  it('rejects a non-increasing effectiveFrom', () => {
    const first = expectOk(appendTaxProfileVersion([], taxInput(AT)));
    expect(expectRejection(appendTaxProfileVersion(first, taxInput(AT)))).toBe(
      'effective_from_not_increasing',
    );
  });

  it('rejects invalid fields and foreign tenants', () => {
    expect(
      expectRejection(appendTaxProfileVersion([], { ...taxInput(AT), taxIdentifier: '' })),
    ).toBe('invalid_profile_field');
    expect(
      expectRejection(appendTaxProfileVersion([], { ...taxInput(AT), recordedBy: null })),
    ).toBe('invalid_actor');
    const foreign = expectOk(appendTaxProfileVersion([], taxInput(AT, OTHER_TENANT)));
    expect(expectRejection(appendTaxProfileVersion(foreign, taxInput(AT + 1)))).toBe(
      'inconsistent_context',
    );
  });

  it('rejects a corrupted stored version', () => {
    const corrupted = [
      {
        ...(expectOk(appendTaxProfileVersion([], taxInput(AT)))[0] as TaxProfileVersion),
        version: 0,
      },
    ] as readonly TaxProfileVersion[];
    expect(expectRejection(appendTaxProfileVersion(corrupted, taxInput(AT + 100)))).toBe(
      'invalid_profile_version',
    );
  });
});

describe('taxProfileVersionAt', () => {
  it('resolves the version effective at a time', () => {
    const first = expectOk(appendTaxProfileVersion([], taxInput(AT)));
    const versions = expectOk(appendTaxProfileVersion(first, taxInput(AT + 100)));
    expect(taxProfileVersionAt(versions, AT - 1)).toBeUndefined();
    expect(taxProfileVersionAt(versions, AT + 99)?.version).toBe(1);
    expect(taxProfileVersionAt(versions, AT + 100)?.version).toBe(2);
    expect(taxProfileVersionAt(versions, Number.NaN)).toBeUndefined();
  });
});
