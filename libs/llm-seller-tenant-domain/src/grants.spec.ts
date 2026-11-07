import { describe, expect, it } from 'vitest';

import {
  createGrantId,
  createMembershipId,
  createPermissionId,
  createSellerActorId,
  createSellerTenantId,
} from './shared';
import { provisionMembership, revokeMembership, type SellerMembership } from './membership';
import {
  createGrant,
  findActiveGrants,
  isGrantActiveForMembership,
  isPermissionGrant,
  revokeGrant,
  type PermissionGrant,
} from './grants';

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
const ACTOR = createSellerActorId('member-1');
const AT = 1_700_000_000_000;
const OFFER_WRITE = createPermissionId('offer.write');

function membership(id = 'm-1'): SellerMembership {
  return expectOk(
    provisionMembership(
      { id: createMembershipId(id), tenantId: TENANT, actor: ACTOR, createdAt: AT },
      [],
    ),
  );
}

function tryGrant(
  id: string,
  membershipId: string,
  permission = OFFER_WRITE,
  grants: readonly PermissionGrant[] = [],
): ReturnType<typeof createGrant> {
  return createGrant(
    {
      id: createGrantId(id),
      tenantId: TENANT,
      membershipId: createMembershipId(membershipId),
      permission,
      grantedAt: AT,
    },
    { memberships: [membership(membershipId)], grants },
  );
}

function grant(
  id: string,
  membershipId: string,
  permission = OFFER_WRITE,
  grants: readonly PermissionGrant[] = [],
): PermissionGrant {
  return expectOk(tryGrant(id, membershipId, permission, grants));
}

describe('createGrant', () => {
  it('grants a permission to an active membership incarnation', () => {
    const created = grant('g-1', 'm-1');
    expect(created.status).toBe('active');
    expect(created.membershipId).toBe(createMembershipId('m-1'));
    expect(Object.isFrozen(created)).toBe(true);
  });

  it('rejects granting to a revoked membership', () => {
    const revoked = expectOk(
      revokeMembership({ membership: membership('m-1'), revokedAt: AT + 1 }),
    );
    expect(
      expectRejection(
        createGrant(
          {
            id: createGrantId('g-1'),
            tenantId: TENANT,
            membershipId: createMembershipId('m-1'),
            permission: OFFER_WRITE,
            grantedAt: AT,
          },
          { memberships: [revoked], grants: [] },
        ),
      ),
    ).toBe('membership_not_found');
  });

  it('rejects a duplicate active grant for the same membership and permission', () => {
    const existing = grant('g-1', 'm-1');
    expect(expectRejection(tryGrant('g-2', 'm-1', OFFER_WRITE, [existing]))).toBe(
      'duplicate_grant',
    );
  });

  it('allows re-granting after revoke with a new grant id', () => {
    const existing = grant('g-1', 'm-1');
    const revoked = expectOk(revokeGrant({ grant: existing, revokedAt: AT + 1 }));
    const regranted = grant('g-2', 'm-1', OFFER_WRITE, [revoked]);
    expect(regranted.id).toBe(createGrantId('g-2'));
    expect(revoked.status).toBe('revoked');
  });

  it('rejects a duplicate grant id even across permissions', () => {
    const existing = grant('g-1', 'm-1');
    expect(
      expectRejection(tryGrant('g-1', 'm-1', createPermissionId('offer.delete'), [existing])),
    ).toBe('duplicate_grant_id');
  });

  it('rejects cross-tenant memberships and grants', () => {
    const foreign = Object.freeze({
      ...membership('m-2'),
      tenantId: createSellerTenantId('tenant-2'),
    });
    expect(
      expectRejection(
        createGrant(
          {
            id: createGrantId('g-1'),
            tenantId: TENANT,
            membershipId: createMembershipId('m-2'),
            permission: OFFER_WRITE,
            grantedAt: AT,
          },
          { memberships: [foreign], grants: [] },
        ),
      ),
    ).toBe('inconsistent_context');
  });

  it('rejects a malformed permission', () => {
    for (const permission of ['OfferWrite', 'offer', 'offer.', '1offer.write', 'offer .write']) {
      expect(
        expectRejection(
          createGrant(
            {
              id: createGrantId('g-1'),
              tenantId: TENANT,
              membershipId: createMembershipId('m-1'),
              permission,
              grantedAt: AT,
            },
            { memberships: [membership('m-1')], grants: [] },
          ),
        ),
      ).toBe('invalid_permission_id');
    }
  });

  it('rejects a corrupted grant in context', () => {
    expect(
      expectRejection(
        createGrant(
          {
            id: createGrantId('g-1'),
            tenantId: TENANT,
            membershipId: createMembershipId('m-1'),
            permission: OFFER_WRITE,
            grantedAt: AT,
          },
          { memberships: [membership('m-1')], grants: [{} as PermissionGrant] },
        ),
      ),
    ).toBe('inconsistent_context');
  });
});

describe('grant revocation', () => {
  it('revoking a grant makes it non-authorizing', () => {
    const active = grant('g-1', 'm-1');
    const membershipRecord = membership('m-1');
    expect(isGrantActiveForMembership(active, membershipRecord)).toBe(true);
    const revoked = expectOk(revokeGrant({ grant: active, revokedAt: AT + 1 }));
    expect(isGrantActiveForMembership(revoked, membershipRecord)).toBe(false);
    expect(findActiveGrants([revoked], membershipRecord.id)).toEqual([]);
  });

  it('rejects a second revoke', () => {
    const revoked = expectOk(revokeGrant({ grant: grant('g-1', 'm-1'), revokedAt: AT + 1 }));
    expect(expectRejection(revokeGrant({ grant: revoked, revokedAt: AT + 2 }))).toBe(
      'grant_already_revoked',
    );
  });

  it('rejects a corrupted grant whose status and revokedAt disagree', () => {
    const corrupted = Object.freeze({
      ...grant('g-1', 'm-1'),
      status: 'active' as const,
      revokedAt: AT + 1,
    });
    expect(expectRejection(revokeGrant({ grant: corrupted, revokedAt: AT + 2 }))).toBe(
      'invalid_grant',
    );
  });

  it('a grant of an older membership incarnation never authorizes a new one', () => {
    const oldMembership = membership('m-1');
    const oldGrant = grant('g-1', 'm-1');
    const revokedMembership = expectOk(
      revokeMembership({ membership: oldMembership, revokedAt: AT + 1 }),
    );
    const newMembership = expectOk(
      provisionMembership(
        { id: createMembershipId('m-2'), tenantId: TENANT, actor: ACTOR, createdAt: AT + 2 },
        [revokedMembership],
      ),
    );
    expect(isGrantActiveForMembership(oldGrant, newMembership)).toBe(false);
    expect(findActiveGrants([oldGrant], newMembership.id)).toEqual([]);
  });

  it('fails closed on corrupted grants and memberships', () => {
    const corruptedGrant = { ...grant('g-1', 'm-1'), status: 'active', revokedAt: AT } as never;
    const corruptedMembership = {
      ...membership('m-1'),
      status: 'active',
      revokedAt: AT,
    } as never;
    expect(isGrantActiveForMembership(corruptedGrant, membership('m-1'))).toBe(false);
    expect(isGrantActiveForMembership(grant('g-1', 'm-1'), corruptedMembership)).toBe(false);
    expect(isGrantActiveForMembership(null as never, membership('m-1'))).toBe(false);

    const grants = [grant('g-1', 'm-1'), null, undefined] as unknown as readonly PermissionGrant[];
    expect(findActiveGrants(grants, createMembershipId('m-1'))).toHaveLength(1);
    expect(expectRejection(revokeGrant({ grant: null as never, revokedAt: AT + 1 }))).toBe(
      'invalid_grant',
    );
    expect(
      findActiveGrants(null as unknown as readonly PermissionGrant[], createMembershipId('m-1')),
    ).toEqual([]);
  });
});

describe('isPermissionGrant', () => {
  it('rejects inconsistent shapes', () => {
    const good = grant('g-1', 'm-1');
    expect(isPermissionGrant(good)).toBe(true);
    expect(isPermissionGrant({ ...good, status: 'revoked' })).toBe(false);
    expect(isPermissionGrant({ ...good, permission: 'OfferWrite' })).toBe(false);
    expect(isPermissionGrant(undefined)).toBe(false);
  });
});
