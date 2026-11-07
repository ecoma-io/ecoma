import { describe, expect, it } from 'vitest';

import { createMembershipId, createSellerActorId, createSellerTenantId } from './shared';
import {
  findActiveMemberships,
  hasActiveMembership,
  isMembershipActive,
  isSellerMembership,
  provisionMembership,
  revokeMembership,
  type SellerMembership,
} from './membership';

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

function provision(id: string, existing: readonly SellerMembership[] = []): SellerMembership {
  return expectOk(
    provisionMembership(
      { id: createMembershipId(id), tenantId: TENANT, actor: ACTOR, createdAt: AT },
      existing,
    ),
  );
}

describe('provisionMembership', () => {
  it('creates an active membership incarnation', () => {
    const created = provision('m-1');
    expect(created.status).toBe('active');
    expect(created.revokedAt).toBeNull();
    expect(Object.isFrozen(created)).toBe(true);
  });

  it('rejects a second active membership for the same actor', () => {
    expect(
      expectRejection(
        provisionMembership(
          { id: createMembershipId('m-2'), tenantId: TENANT, actor: ACTOR, createdAt: AT },
          [provision('m-1')],
        ),
      ),
    ).toBe('membership_already_active');
  });

  it('rejects a duplicate membership id', () => {
    const existing = provision('m-1');
    expect(
      expectRejection(
        provisionMembership(
          {
            id: createMembershipId('m-1'),
            tenantId: TENANT,
            actor: createSellerActorId('other'),
            createdAt: AT,
          },
          [existing],
        ),
      ),
    ).toBe('duplicate_membership_id');
  });

  it('rejects a collection mixing tenants', () => {
    const foreign = Object.freeze({ ...provision('m-1'), tenantId: OTHER_TENANT });
    expect(
      expectRejection(
        provisionMembership(
          { id: createMembershipId('m-2'), tenantId: TENANT, actor: ACTOR, createdAt: AT },
          [foreign],
        ),
      ),
    ).toBe('inconsistent_context');
  });

  it('rejects malformed ids and timestamps', () => {
    expect(
      expectRejection(
        provisionMembership({ id: 1, tenantId: TENANT, actor: ACTOR, createdAt: AT }, []),
      ),
    ).toBe('invalid_membership_id');
    expect(
      expectRejection(
        provisionMembership(
          { id: createMembershipId('m-1'), tenantId: TENANT, actor: ACTOR, createdAt: Number.NaN },
          [],
        ),
      ),
    ).toBe('invalid_timestamp');
  });
});

describe('revokeMembership', () => {
  it('marks an active membership revoked and keeps revokedAt', () => {
    const revoked = expectOk(revokeMembership({ membership: provision('m-1'), revokedAt: AT + 5 }));
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt).toBe(AT + 5);
    expect(isMembershipActive(revoked)).toBe(false);
  });

  it('rejects a second revoke instead of overwriting the audit timestamp', () => {
    const revoked = expectOk(revokeMembership({ membership: provision('m-1'), revokedAt: AT + 5 }));
    expect(expectRejection(revokeMembership({ membership: revoked, revokedAt: AT + 9 }))).toBe(
      'membership_already_revoked',
    );
    expect(revoked.revokedAt).toBe(AT + 5);
  });

  it('rejects a corrupted record whose status and revokedAt disagree', () => {
    const corrupted = Object.freeze({
      ...provision('m-1'),
      status: 'active' as const,
      revokedAt: AT + 5,
    });
    expect(expectRejection(revokeMembership({ membership: corrupted, revokedAt: AT + 9 }))).toBe(
      'invalid_membership',
    );
  });

  it('rejects an invalid revokedAt', () => {
    expect(
      expectRejection(revokeMembership({ membership: provision('m-1'), revokedAt: 1.25 })),
    ).toBe('invalid_timestamp');
  });
});

describe('membership incarnation', () => {
  it('re-provisioning after revoke creates a distinct identity', () => {
    const first = provision('m-1');
    const revoked = expectOk(revokeMembership({ membership: first, revokedAt: AT + 5 }));
    const second = provision('m-2', [revoked]);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('active');
    // Lần cũ vẫn revoked và không bao giờ active trở lại.
    expect(isMembershipActive(revoked)).toBe(false);
  });

  it('finds only active memberships of the exact tenant and actor', () => {
    const active = provision('m-1');
    const other = Object.freeze({
      ...provision('m-2'),
      actor: createSellerActorId('member-2'),
    });
    expect(findActiveMemberships([active, other], TENANT, ACTOR)).toEqual([active]);
    expect(findActiveMemberships([active], OTHER_TENANT, ACTOR)).toEqual([]);
    expect(hasActiveMembership([active], ACTOR)).toBe(true);
  });

  it('ignores corrupted entries instead of throwing', () => {
    const active = provision('m-1');
    const corrupted = [active, null, undefined, 'm-2'] as unknown as readonly SellerMembership[];
    expect(findActiveMemberships(corrupted, TENANT, ACTOR)).toEqual([active]);
    expect(hasActiveMembership(corrupted, ACTOR)).toBe(true);
    expect(hasActiveMembership([null] as unknown as readonly SellerMembership[], ACTOR)).toBe(
      false,
    );
  });
});

describe('provisionMembership guards', () => {
  it('rejects corrupted membership records in the existing collection', () => {
    const corrupted = [
      { ...provision('m-1'), status: 'active', revokedAt: AT },
    ] as unknown as readonly SellerMembership[];
    expect(
      expectRejection(
        provisionMembership(
          { id: createMembershipId('m-2'), tenantId: TENANT, actor: ACTOR, createdAt: AT },
          corrupted,
        ),
      ),
    ).toBe('inconsistent_context');
    expect(
      expectRejection(
        provisionMembership(
          { id: createMembershipId('m-3'), tenantId: TENANT, actor: ACTOR, createdAt: AT },
          null as never,
        ),
      ),
    ).toBe('ambiguous_context');
  });
});

describe('isSellerMembership', () => {
  it('accepts a well-formed record and rejects inconsistent shapes', () => {
    const good = provision('m-1');
    expect(isSellerMembership(good)).toBe(true);
    expect(isSellerMembership({ ...good, status: 'revoked' })).toBe(false);
    expect(isSellerMembership({ ...good, revokedAt: AT })).toBe(false);
    expect(isSellerMembership({ ...good, status: 'unknown' })).toBe(false);
    expect(isSellerMembership(null)).toBe(false);
  });
});
