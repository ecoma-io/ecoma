import { describe, expect, it } from 'vitest';

import { createSellerActorId, createSellerTenantId } from '@ecoma-io/llm-seller-tenant-domain';
import {
  appendLegalProfileVersion,
  isLegalProfileVersion,
  legalProfileVersionAt,
  type LegalProfileVersion,
} from './legal-profile';

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

function legalInput(
  effectiveFrom: number,
  tenantId = TENANT,
): Parameters<typeof appendLegalProfileVersion>[1] {
  return {
    tenantId,
    legalName: `Acme Ltd v${effectiveFrom}`,
    legalType: 'company',
    jurisdiction: 'VN',
    registrationReference: 'REG-1',
    effectiveFrom,
    recordedAt: AT,
    recordedBy: ACTOR,
  };
}

function legalProfileVersionFixture(): LegalProfileVersion {
  return expectOk(appendLegalProfileVersion([], legalInput(AT)))[0] as LegalProfileVersion;
}

describe('appendLegalProfileVersion', () => {
  it('assigns version 1 to the first record', () => {
    const versions = expectOk(appendLegalProfileVersion([], legalInput(AT)));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    expect(Object.isFrozen(versions[0])).toBe(true);
    expect(Object.isFrozen(versions)).toBe(true);
  });

  it('appends without mutating the previous collection', () => {
    const first = expectOk(appendLegalProfileVersion([], legalInput(AT)));
    const second = expectOk(appendLegalProfileVersion(first, legalInput(AT + 100)));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(second[1]?.version).toBe(2);
  });

  it('rejects a non-increasing effectiveFrom', () => {
    const first = expectOk(appendLegalProfileVersion([], legalInput(AT)));
    expect(expectRejection(appendLegalProfileVersion(first, legalInput(AT)))).toBe(
      'effective_from_not_increasing',
    );
    expect(expectRejection(appendLegalProfileVersion(first, legalInput(AT - 1)))).toBe(
      'effective_from_not_increasing',
    );
  });

  it('rejects invalid fields, timestamps and foreign tenants', () => {
    expect(
      expectRejection(appendLegalProfileVersion([], { ...legalInput(AT), legalName: '' })),
    ).toBe('invalid_profile_field');
    expect(
      expectRejection(appendLegalProfileVersion([], { ...legalInput(AT), effectiveFrom: 1.5 })),
    ).toBe('invalid_effective_from');
    expect(
      expectRejection(appendLegalProfileVersion([], { ...legalInput(AT), recordedAt: null })),
    ).toBe('invalid_timestamp');

    const foreign = expectOk(appendLegalProfileVersion([], legalInput(AT, OTHER_TENANT)));
    expect(expectRejection(appendLegalProfileVersion(foreign, legalInput(AT + 1)))).toBe(
      'inconsistent_context',
    );
  });

  it('rejects a corrupted stored version', () => {
    const corrupted = [
      { ...legalProfileVersionFixture(), legalName: '' },
    ] as unknown as readonly LegalProfileVersion[];
    expect(expectRejection(appendLegalProfileVersion(corrupted, legalInput(AT + 100)))).toBe(
      'invalid_profile_version',
    );
  });
});

describe('legalProfileVersionAt', () => {
  it('derives the effective period from the next version', () => {
    const first = expectOk(appendLegalProfileVersion([], legalInput(AT)));
    const versions = expectOk(appendLegalProfileVersion(first, legalInput(AT + 100)));
    expect(legalProfileVersionAt(versions, AT - 1)).toBeUndefined();
    expect(legalProfileVersionAt(versions, AT)?.version).toBe(1);
    expect(legalProfileVersionAt(versions, AT + 99)?.version).toBe(1);
    expect(legalProfileVersionAt(versions, AT + 100)?.version).toBe(2);
    expect(legalProfileVersionAt(versions, AT + 10_000)?.version).toBe(2);
  });

  it('does not depend on array order', () => {
    const first = expectOk(appendLegalProfileVersion([], legalInput(AT)));
    const versions = expectOk(appendLegalProfileVersion(first, legalInput(AT + 100)));
    expect(legalProfileVersionAt(versions.toReversed(), AT + 50)?.version).toBe(1);
  });

  it('returns undefined for an invalid time', () => {
    expect(legalProfileVersionAt([legalProfileVersionFixture()], Number.NaN)).toBeUndefined();
  });
});

describe('isLegalProfileVersion', () => {
  it('accepts a well-formed version and rejects invalid ones', () => {
    expect(isLegalProfileVersion(legalProfileVersionFixture())).toBe(true);
    expect(isLegalProfileVersion({ ...legalProfileVersionFixture(), version: 0 })).toBe(false);
    expect(isLegalProfileVersion({ ...legalProfileVersionFixture(), jurisdiction: '' })).toBe(
      false,
    );
    expect(isLegalProfileVersion(null)).toBe(false);
  });
});
