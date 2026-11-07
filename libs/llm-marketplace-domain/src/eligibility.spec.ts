import { describe, expect, it } from 'vitest';

import {
  assertEligibilityForTenant,
  createSellerTenantId,
  evaluateActivationEligibility,
  isSellerOperationalEligibility,
  type SellerOperationalEligibility,
} from './index';

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

const AT = 1_700_000_000_000;
const TENANT = createSellerTenantId('tenant-1');

function eligibleVerdict(
  overrides: Partial<SellerOperationalEligibility> = {},
): SellerOperationalEligibility {
  return { tenantId: TENANT, eligible: true, blockers: [], assessedAt: AT, ...overrides };
}

describe('isSellerOperationalEligibility', () => {
  it('accepts an eligible verdict with no blockers', () => {
    expect(isSellerOperationalEligibility(eligibleVerdict())).toBe(true);
  });

  it('accepts an ineligible verdict that names at least one blocker', () => {
    expect(
      isSellerOperationalEligibility(
        eligibleVerdict({ eligible: false, blockers: ['verification_expired'] }),
      ),
    ).toBe(true);
  });

  it('rejects an eligible verdict that still carries a blocker', () => {
    expect(isSellerOperationalEligibility(eligibleVerdict({ blockers: ['restricted'] }))).toBe(
      false,
    );
  });

  it('rejects an ineligible verdict with no blocker', () => {
    expect(isSellerOperationalEligibility(eligibleVerdict({ eligible: false, blockers: [] }))).toBe(
      false,
    );
  });

  it('rejects duplicated or malformed blockers', () => {
    expect(
      isSellerOperationalEligibility(eligibleVerdict({ eligible: false, blockers: ['a', 'a'] })),
    ).toBe(false);
    expect(
      isSellerOperationalEligibility(eligibleVerdict({ eligible: false, blockers: [''] })),
    ).toBe(false);
    expect(
      isSellerOperationalEligibility(eligibleVerdict({ eligible: false, blockers: 'a' as never })),
    ).toBe(false);
  });

  it('rejects an invalid tenant, non-boolean flag, broken time or non-object', () => {
    expect(isSellerOperationalEligibility(eligibleVerdict({ tenantId: '' as never }))).toBe(false);
    expect(isSellerOperationalEligibility(eligibleVerdict({ eligible: 'yes' as never }))).toBe(
      false,
    );
    expect(isSellerOperationalEligibility(eligibleVerdict({ assessedAt: 1.5 }))).toBe(false);
    expect(isSellerOperationalEligibility(null)).toBe(false);
    expect(isSellerOperationalEligibility('eligible')).toBe(false);
  });
});

describe('assertEligibilityForTenant', () => {
  it('returns the verdict when the tenant matches', () => {
    const verdict = eligibleVerdict();
    expect(expectOk(assertEligibilityForTenant(verdict, TENANT))).toBe(verdict);
  });

  it('rejects a verdict issued for another tenant instead of accepting it', () => {
    const foreign = eligibleVerdict({ tenantId: createSellerTenantId('tenant-2') });
    expect(expectRejection(assertEligibilityForTenant(foreign, TENANT))).toBe(
      'eligibility_tenant_mismatch',
    );
  });

  it('rejects a malformed verdict', () => {
    expect(expectRejection(assertEligibilityForTenant(null, TENANT))).toBe(
      'invalid_eligibility_verdict',
    );
    expect(
      expectRejection(
        assertEligibilityForTenant(eligibleVerdict({ eligible: false, blockers: [] }), TENANT),
      ),
    ).toBe('invalid_eligibility_verdict');
  });

  it('rejects an invalid target tenant', () => {
    expect(expectRejection(assertEligibilityForTenant(eligibleVerdict(), '' as never))).toBe(
      'invalid_seller_tenant_id',
    );
  });
});

describe('evaluateActivationEligibility', () => {
  it('reports eligible for a matching verdict with no time floor', () => {
    const assessment = evaluateActivationEligibility(eligibleVerdict(), TENANT, null);
    expect(assessment.eligible).toBe(true);
    expect(assessment.verdictUsable).toBe(true);
    expect(assessment.blockers).toEqual([]);
    expect(Object.isFrozen(assessment)).toBe(true);
  });

  it('keeps the governance blockers for an ineligible verdict', () => {
    const assessment = evaluateActivationEligibility(
      eligibleVerdict({ eligible: false, blockers: ['legal_profile_missing'] }),
      TENANT,
      null,
    );
    expect(assessment.eligible).toBe(false);
    expect(assessment.verdictUsable).toBe(true);
    expect(assessment.blockers).toEqual(['legal_profile_missing']);
  });

  it('rejects a stale verdict assessed before the offer baseline', () => {
    const assessment = evaluateActivationEligibility(
      eligibleVerdict({ assessedAt: AT - 1 }),
      TENANT,
      AT,
    );
    expect(assessment.eligible).toBe(false);
    expect(assessment.verdictUsable).toBe(true);
    expect(assessment.blockers).toEqual(['seller_eligibility_stale']);
  });

  it('accepts a verdict assessed exactly at the baseline', () => {
    expect(
      evaluateActivationEligibility(eligibleVerdict({ assessedAt: AT }), TENANT, AT).eligible,
    ).toBe(true);
  });

  it('marks a wrong-tenant or malformed verdict unusable and adds no tenant data', () => {
    const foreign = evaluateActivationEligibility(
      eligibleVerdict({ tenantId: createSellerTenantId('tenant-2') }),
      TENANT,
      null,
    );
    expect(foreign.eligible).toBe(false);
    expect(foreign.verdictUsable).toBe(false);
    expect(foreign.blockers).toEqual(['seller_eligibility_unusable']);

    const malformed = evaluateActivationEligibility(null, TENANT, null);
    expect(malformed.eligible).toBe(false);
    expect(malformed.verdictUsable).toBe(false);
    expect(malformed.blockers).toEqual(['seller_eligibility_unusable']);
  });

  it('does not mutate the verdict blockers', () => {
    const verdict = eligibleVerdict({ assessedAt: AT - 5 });
    evaluateActivationEligibility(verdict, TENANT, AT);
    expect(verdict.blockers).toEqual([]);
  });
});
