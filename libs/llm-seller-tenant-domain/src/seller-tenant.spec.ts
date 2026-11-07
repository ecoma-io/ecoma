import { describe, expect, it } from 'vitest';

import { createMembershipId, createSellerActorId, createSellerTenantId } from './shared';
import { provisionMembership, type SellerMembership } from './membership';
import {
  createSellerTenant,
  isSellerOwner,
  transferSellerOwnership,
  type SellerTenant,
} from './seller-tenant';

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

const OWNER = createSellerActorId('owner-1');
const NEW_OWNER = createSellerActorId('member-1');
const STRANGER = createSellerActorId('stranger-1');
const TENANT = createSellerTenantId('tenant-1');
const AT = 1_700_000_000_000;

function tenant(): SellerTenant {
  return expectOk(
    createSellerTenant({ id: TENANT, name: 'Acme Seller', owner: OWNER, createdAt: AT }),
  );
}

function membership(id: string, actor: ReturnType<typeof createSellerActorId>): SellerMembership {
  return expectOk(
    provisionMembership(
      { id: createMembershipId(id), tenantId: TENANT, actor, createdAt: AT + 1 },
      [],
    ),
  );
}

describe('createSellerTenant', () => {
  it('creates an active tenant with exactly one owner and no lifecycle status', () => {
    const created = tenant();
    expect(created.owner).toBe(OWNER);
    expect(created).not.toHaveProperty('status');
    expect(Object.isFrozen(created)).toBe(true);
  });

  it('rejects malformed input fields', () => {
    expect(
      expectRejection(createSellerTenant({ id: '', name: 'x', owner: OWNER, createdAt: AT })),
    ).toBe('invalid_seller_tenant_id');
    expect(
      expectRejection(
        createSellerTenant({ id: TENANT, name: '  padded', owner: OWNER, createdAt: AT }),
      ),
    ).toBe('invalid_seller_tenant_name');
    expect(
      expectRejection(createSellerTenant({ id: TENANT, name: 'x', owner: 42, createdAt: AT })),
    ).toBe('invalid_actor');
    expect(
      expectRejection(createSellerTenant({ id: TENANT, name: 'x', owner: OWNER, createdAt: 1.5 })),
    ).toBe('invalid_timestamp');
  });

  it('rejects non-integer and unsafe timestamps', () => {
    for (const createdAt of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1700000000000']) {
      expect(
        expectRejection(createSellerTenant({ id: TENANT, name: 'x', owner: OWNER, createdAt })),
      ).toBe('invalid_timestamp');
    }
  });
});

describe('isSellerOwner', () => {
  it('compares the tenant owner, not membership', () => {
    expect(isSellerOwner(tenant(), OWNER)).toBe(true);
    expect(isSellerOwner(tenant(), NEW_OWNER)).toBe(false);
  });

  it('fails closed on a corrupted tenant record', () => {
    expect(isSellerOwner(null as never, OWNER)).toBe(false);
    expect(isSellerOwner({ ...tenant(), owner: '' }, OWNER)).toBe(false);
  });
});

describe('transferSellerOwnership', () => {
  it('moves ownership to an active member and keeps exactly one owner', () => {
    const target = tenant();
    const memberships = [membership('m-1', NEW_OWNER)];
    const transfer = expectOk(
      transferSellerOwnership({
        tenant: target,
        memberships,
        newOwner: NEW_OWNER,
        transferredBy: OWNER,
        transferredAt: AT + 10,
        formerOwnerMembershipId: createMembershipId('m-owner'),
      }),
    );
    expect(transfer.tenant.owner).toBe(NEW_OWNER);
    expect(transfer.previousOwner).toBe(OWNER);
    expect(
      transfer.memberships.filter((item) => item.actor === OWNER && item.status === 'active'),
    ).toHaveLength(1);
    // Input không bị sửa.
    expect(target.owner).toBe(OWNER);
    expect(memberships).toHaveLength(1);
  });

  it('rejects a transfer performed by a non-owner', () => {
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [membership('m-1', NEW_OWNER)],
          newOwner: NEW_OWNER,
          transferredBy: NEW_OWNER,
          transferredAt: AT + 10,
          formerOwnerMembershipId: createMembershipId('m-owner'),
        }),
      ),
    ).toBe('actor_not_owner');
  });

  it('rejects transferring ownership to the current owner', () => {
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [],
          newOwner: OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
        }),
      ),
    ).toBe('owner_already_owner');
  });

  it('rejects a new owner that is not an active member', () => {
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
          formerOwnerMembershipId: createMembershipId('m-owner'),
        }),
      ),
    ).toBe('new_owner_not_active_member');
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [],
          newOwner: STRANGER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
        }),
      ),
    ).toBe('new_owner_not_active_member');
  });

  it('rejects a revoked membership as the new owner', () => {
    const revoked = Object.freeze({
      ...membership('m-1', NEW_OWNER),
      status: 'revoked' as const,
      revokedAt: AT + 5,
    });
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [revoked],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
          formerOwnerMembershipId: createMembershipId('m-owner'),
        }),
      ),
    ).toBe('new_owner_not_active_member');
  });

  it('rejects a new owner holding two active memberships', () => {
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [membership('m-1', NEW_OWNER), membership('m-2', NEW_OWNER)],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
        }),
      ),
    ).toBe('ambiguous_context');
  });

  it('rejects a former owner holding two active memberships', () => {
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [
            membership('m-1', NEW_OWNER),
            membership('m-owner-a', OWNER),
            membership('m-owner-b', OWNER),
          ],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
        }),
      ),
    ).toBe('ambiguous_context');
  });

  it('rejects a membership collection mixing tenants', () => {
    const foreign = Object.freeze({
      ...membership('m-foreign', NEW_OWNER),
      tenantId: createSellerTenantId('tenant-2'),
    });
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [foreign],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
        }),
      ),
    ).toBe('inconsistent_context');
  });

  it('requires a membership id when the former owner has no active membership', () => {
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [membership('m-1', NEW_OWNER)],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
        }),
      ),
    ).toBe('missing_former_owner_membership');
  });

  it('rejects a former-owner membership id that already exists', () => {
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [membership('m-1', NEW_OWNER)],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
          formerOwnerMembershipId: createMembershipId('m-1'),
        }),
      ),
    ).toBe('duplicate_membership_id');
  });

  it('reuses the existing former-owner membership instead of creating a second one', () => {
    const memberships = [membership('m-1', NEW_OWNER), membership('m-owner', OWNER)];
    const transfer = expectOk(
      transferSellerOwnership({
        tenant: tenant(),
        memberships,
        newOwner: NEW_OWNER,
        transferredBy: OWNER,
        transferredAt: AT + 10,
        formerOwnerMembershipId: createMembershipId('m-ignored'),
      }),
    );
    expect(transfer.memberships).toHaveLength(2);
    expect(Object.isFrozen(transfer.memberships)).toBe(true);
    expect(transfer.memberships.every((item) => memberships.includes(item))).toBe(true);
  });

  it('rejects a corrupted tenant record instead of throwing', () => {
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: { ...tenant(), owner: '' },
          memberships: [membership('m-1', NEW_OWNER)],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
        }),
      ),
    ).toBe('invalid_seller_tenant');
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: null as never,
          memberships: [membership('m-1', NEW_OWNER)],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: AT + 10,
        }),
      ),
    ).toBe('invalid_seller_tenant');
  });

  it('rejects invalid transferredAt', () => {
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: tenant(),
          memberships: [membership('m-1', NEW_OWNER)],
          newOwner: NEW_OWNER,
          transferredBy: OWNER,
          transferredAt: 'now',
        }),
      ),
    ).toBe('invalid_timestamp');
  });

  it('cannot be replayed as a second transfer from the former owner', () => {
    const transfer = expectOk(
      transferSellerOwnership({
        tenant: tenant(),
        memberships: [membership('m-1', NEW_OWNER)],
        newOwner: NEW_OWNER,
        transferredBy: OWNER,
        transferredAt: AT + 10,
        formerOwnerMembershipId: createMembershipId('m-owner'),
      }),
    );
    expect(
      expectRejection(
        transferSellerOwnership({
          tenant: transfer.tenant,
          memberships: transfer.memberships,
          newOwner: STRANGER,
          transferredBy: OWNER,
          transferredAt: AT + 20,
        }),
      ),
    ).toBe('actor_not_owner');
  });
});
