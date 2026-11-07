import { describe, expect, it } from 'vitest';

import {
  createGrantId,
  createMembershipId,
  createPermissionId,
  createSellerActorId,
  createSellerTenantId,
  LLM_SELLER_AUTHORIZATION_SCOPE,
  LLM_SELLER_PAYOUT_PERMISSION,
} from './shared';
import { provisionMembership, revokeMembership, type SellerMembership } from './membership';
import { createGrant, type PermissionGrant } from './grants';
import { createSellerTenant, type SellerTenant } from './seller-tenant';
import { authorizeSellerAction, authorizeSellerPayout } from './authorization';

function expectOk<Value>(
  result: { ok: true; value: Value } | { ok: false; error: { code: string } },
): Value {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

const TENANT_ID = createSellerTenantId('tenant-1');
const OTHER_TENANT_ID = createSellerTenantId('tenant-2');
const OWNER = createSellerActorId('owner-1');
const MEMBER = createSellerActorId('member-1');
const OTHER_MEMBER = createSellerActorId('member-2');
const STRANGER = createSellerActorId('stranger-1');
const AT = 1_700_000_000_000;
const OFFER_WRITE = createPermissionId('offer.write');
const OFFER_READ = createPermissionId('offer.read');

const TENANT_TARGET = Object.freeze({ kind: 'tenant' as const });
const PAYOUT_TARGET = Object.freeze({ kind: 'capability' as const, capability: 'payout' });

/**
 * Verdict đầy đủ mà ladder nhận: bốn field quyết định cộng hai mảng audit mà
 * guard kiểm tra. Kiểu `SellerRestrictionVerdict` cố ý không khai báo hai mảng
 * audit (ladder không được đọc chúng), nên fixture giữ chúng để guard chấp nhận.
 */
const CLEAR = Object.freeze({
  tenantId: TENANT_ID,
  target: TENANT_TARGET,
  blocked: false,
  unevaluable: false,
  blockingRecordIds: [],
  unknownPolicies: [],
});

function tenant(): SellerTenant {
  return expectOk(
    createSellerTenant({ id: TENANT_ID, name: 'Acme Seller', owner: OWNER, createdAt: AT }),
  );
}

function membership(id: string, actor: ReturnType<typeof createSellerActorId>): SellerMembership {
  return expectOk(
    provisionMembership(
      { id: createMembershipId(id), tenantId: TENANT_ID, actor, createdAt: AT },
      [],
    ),
  );
}

function grant(id: string, membershipId: string, permission = OFFER_WRITE): PermissionGrant {
  return expectOk(
    createGrant(
      {
        id: createGrantId(id),
        tenantId: TENANT_ID,
        membershipId: createMembershipId(membershipId),
        permission,
        grantedAt: AT,
      },
      { memberships: [membership(membershipId, MEMBER)], grants: [] },
    ),
  );
}

function decide(
  request: Partial<Parameters<typeof authorizeSellerAction>[0]> = {},
): ReturnType<typeof authorizeSellerAction> {
  return authorizeSellerAction({
    actor: MEMBER,
    tenant: tenant(),
    permission: OFFER_WRITE,
    target: TENANT_TARGET,
    memberships: [membership('m-1', MEMBER)],
    grants: [grant('g-1', 'm-1')],
    restrictions: CLEAR,
    ...request,
  });
}

describe('authorizeSellerAction — owner and member basis', () => {
  it('allows the owner before consulting grants', () => {
    const decision = decide({ actor: OWNER, memberships: [], grants: [] });
    expect(decision).toEqual({
      allowed: true,
      basis: 'owner',
      permission: OFFER_WRITE,
      tenantScope: LLM_SELLER_AUTHORIZATION_SCOPE,
    });
  });

  it('allows a member with an active grant for the exact permission', () => {
    const decision = decide();
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.basis).toBe('tenant_grant');
  });

  it('denies a member without a grant', () => {
    const decision = decide({ permission: OFFER_READ });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.reason).toBe('permission_not_granted');
  });

  it('does not infer a permission from another permission sharing a prefix', () => {
    const decision = decide({ permission: createPermissionId('offer.write_all') });
    expect(!decision.allowed && decision.reason).toBe('permission_not_granted');
  });

  it('denies a stranger with no membership', () => {
    const decision = decide({ actor: STRANGER, grants: [] });
    expect(!decision.allowed && decision.reason).toBe('membership_missing');
  });

  it('denies a revoked member', () => {
    const revoked = expectOk(
      revokeMembership({ membership: membership('m-1', MEMBER), revokedAt: AT + 1 }),
    );
    const decision = decide({ memberships: [revoked] });
    expect(!decision.allowed && decision.reason).toBe('membership_revoked');
  });

  it('denies when two active membership incarnations exist', () => {
    const decision = decide({
      memberships: [membership('m-1', MEMBER), membership('m-2', MEMBER)],
    });
    expect(!decision.allowed && decision.reason).toBe('membership_ambiguous');
  });

  it('denies a grant issued to another member', () => {
    const decision = decide({
      memberships: [membership('m-1', MEMBER), membership('m-2', OTHER_MEMBER)],
      grants: [grant('g-2', 'm-2', OFFER_WRITE)],
    });
    expect(!decision.allowed && decision.reason).toBe('permission_not_granted');
  });
});

describe('authorizeSellerAction — restriction precedes owner', () => {
  it('denies the owner when the tenant is restricted', () => {
    const decision = decide({
      actor: OWNER,
      restrictions: {
        ...CLEAR,
        blocked: true,
      },
    });
    expect(decision.allowed).toBe(false);
    expect(!decision.allowed && decision.reason).toBe('restricted');
  });

  it('denies when the restriction evaluation is missing', () => {
    const decision = decide({ actor: OWNER, restrictions: undefined });
    expect(!decision.allowed && decision.reason).toBe('restriction_unevaluable');
  });

  it('denies when the restriction evaluation is unevaluable', () => {
    const decision = decide({ restrictions: { ...CLEAR, unevaluable: true } });
    expect(!decision.allowed && decision.reason).toBe('restriction_unevaluable');
  });

  it('denies an evaluation produced for another tenant', () => {
    const decision = decide({
      actor: OWNER,
      restrictions: { ...CLEAR, tenantId: OTHER_TENANT_ID },
    });
    expect(!decision.allowed && decision.reason).toBe('restriction_unevaluable');
  });

  it('denies an evaluation that omits blocked/unevaluable', () => {
    // Object thiếu hai field boolean sẽ đọc ra `undefined` (falsy) — nếu ladder
    // tin nó thì restriction bị bỏ qua hoàn toàn.
    const decision = decide({
      actor: OWNER,
      restrictions: { tenantId: TENANT_ID, target: TENANT_TARGET } as never,
    });
    expect(!decision.allowed && decision.reason).toBe('restriction_unevaluable');
  });

  it('denies a null restriction evaluation instead of throwing', () => {
    const decision = decide({ actor: OWNER, restrictions: null as never });
    expect(!decision.allowed && decision.reason).toBe('restriction_unevaluable');
  });

  it('denies an evaluation computed for another target', () => {
    const decision = decide({
      actor: OWNER,
      restrictions: { ...CLEAR, target: { kind: 'capability', capability: 'offer' } },
    });
    expect(!decision.allowed && decision.reason).toBe('restriction_unevaluable');
  });

  it('accepts an evaluation computed for the requested capability target', () => {
    const decision = decide({
      target: { kind: 'capability', capability: 'offer' },
      restrictions: { ...CLEAR, target: { kind: 'capability', capability: 'offer' } },
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies payout for a restricted owner', () => {
    const decision = authorizeSellerPayout({
      actor: OWNER,
      tenant: tenant(),
      memberships: [],
      grants: [],
      restrictions: { ...CLEAR_PAYOUT, blocked: true },
    });
    expect(!decision.allowed && decision.reason).toBe('restricted');
  });

  it('denies payout when the evaluation was computed for the tenant target', () => {
    const decision = authorizeSellerPayout({
      actor: OWNER,
      tenant: tenant(),
      memberships: [],
      grants: [],
      restrictions: CLEAR,
    });
    expect(!decision.allowed && decision.reason).toBe('restriction_unevaluable');
  });
});

describe('authorizeSellerAction — tenant isolation and context', () => {
  it('denies a collection mixing tenants instead of filtering', () => {
    const foreignMembership = Object.freeze({
      ...membership('m-2', OTHER_MEMBER),
      tenantId: OTHER_TENANT_ID,
    });
    const decision = decide({ memberships: [membership('m-1', MEMBER), foreignMembership] });
    expect(!decision.allowed && decision.reason).toBe('inconsistent_context');
  });

  it('denies a grant belonging to another tenant', () => {
    const foreignGrant = Object.freeze({ ...grant('g-1', 'm-1'), tenantId: OTHER_TENANT_ID });
    const decision = decide({ grants: [foreignGrant] });
    expect(!decision.allowed && decision.reason).toBe('inconsistent_context');
  });

  it('denies a corrupted grant object', () => {
    const decision = decide({ grants: [{ id: 'g-1' } as PermissionGrant] });
    expect(!decision.allowed && decision.reason).toBe('inconsistent_context');
  });

  it('denies invalid actor, permission and tenant input', () => {
    const invalidActor = decide({ actor: '' });
    expect(!invalidActor.allowed && invalidActor.reason).toBe('invalid_context');
    // Permission hỏng không đọc được nên denial không thể báo lại một giá trị bịa.
    const invalidPermission = decide({ permission: 'OfferWrite' });
    expect(!invalidPermission.allowed && invalidPermission.reason).toBe('invalid_context');
    expect(invalidPermission.permission).toBeNull();
    expect(!decide({ tenant: { id: '' } as SellerTenant }).allowed).toBe(true);
    expect(!decide({ memberships: undefined as never }).allowed).toBe(true);
  });

  it('reports the requested permission on a denial, not a placeholder', () => {
    const decision = decide({ permission: OFFER_READ });
    expect(decision.permission).toBe(OFFER_READ);
  });
});

const CLEAR_PAYOUT = { ...CLEAR, target: PAYOUT_TARGET };

describe('authorizeSellerPayout', () => {
  it('requires the Seller-side payout permission', () => {
    const allowed = authorizeSellerPayout({
      actor: MEMBER,
      tenant: tenant(),
      memberships: [membership('m-1', MEMBER)],
      grants: [grant('g-payout', 'm-1', LLM_SELLER_PAYOUT_PERMISSION)],
      restrictions: CLEAR_PAYOUT,
    });
    expect(allowed.permission).toBe(LLM_SELLER_PAYOUT_PERMISSION);
    expect(allowed.allowed).toBe(true);
  });

  it('denies a member holding an unrelated grant', () => {
    const decision = authorizeSellerPayout({
      actor: MEMBER,
      tenant: tenant(),
      memberships: [membership('m-1', MEMBER)],
      grants: [grant('g-1', 'm-1', OFFER_WRITE)],
      restrictions: CLEAR_PAYOUT,
    });
    expect(!decision.allowed && decision.reason).toBe('permission_not_granted');
  });

  it('never returns a Console-scoped verdict', () => {
    const decision = authorizeSellerPayout({
      actor: OWNER,
      tenant: tenant(),
      memberships: [],
      grants: [],
      restrictions: CLEAR_PAYOUT,
    });
    expect(decision.tenantScope).toBe('seller_tenant');
  });
});

describe('authorization result shape', () => {
  it('is frozen and carries no reason text', () => {
    const decision = decide();
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.keys(decision).toSorted()).toEqual(
      ['allowed', 'basis', 'permission', 'tenantScope'].toSorted(),
    );
  });

  it('is deterministic for the same input', () => {
    const first = decide();
    const second = decide();
    expect(first).toEqual(second);
  });
});
