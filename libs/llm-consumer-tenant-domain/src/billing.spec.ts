/**
 * Ghim ranh giới billing: permission billing chỉ authorize hành vi khởi tạo/top
 * up ở tenant scope cho đúng membership đang active, không mở rộng sang quản trị
 * tenant hay bất kỳ quyền payment nào.
 */

import { describe, expect, it } from 'vitest';

import {
  LLM_TENANT_BILLING_MANAGEMENT_PERMISSION,
  createPermissionId,
  type TenantActorId,
} from './shared';
import { createTenant, type Tenant } from './tenant';
import { provisionMembership, revokeMembership, type Membership } from './membership';
import { createWorkspace } from './workspace';
import { createGrant, type PermissionGrant } from './grants';
import { authorizeBillingManagement, type BillingAuthorizationRequest } from './billing';
import { authorizeTenantAction } from './authorization';

const CREATED_AT = 1_775_000_000_000;
const REVOKED_AT = CREATED_AT + 1_000;

const ALICE = 'sub_alice' as TenantActorId;
const BOB = 'sub_bob' as TenantActorId;

const TENANT: Tenant = (() => {
  const result = createTenant({
    id: 'tnt_acme',
    name: 'Acme',
    owner: ALICE,
    createdAt: CREATED_AT,
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
})();

const MAIN = (() => {
  const result = createWorkspace({
    id: 'wsp_main',
    tenantId: 'tnt_acme',
    name: 'Main',
    createdAt: CREATED_AT,
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
})();

function member(actor: TenantActorId = BOB, id = `mbr_acme_${actor}`): Membership {
  const result = provisionMembership({ id, tenantId: 'tnt_acme', actor, createdAt: CREATED_AT });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
}

function grant(
  scope: PermissionGrant['scope'],
  holder: Membership = member(),
  permission = LLM_TENANT_BILLING_MANAGEMENT_PERMISSION,
): PermissionGrant {
  const result = createGrant(
    { tenantId: 'tnt_acme', membershipId: holder.id, permission, scope },
    { memberships: [holder], workspaces: [MAIN], grants: [] },
  );
  if (!result.ok) {
    throw new Error(`fixture is invalid: ${result.error.code}`);
  }
  return result.value;
}

function request(
  overrides: Partial<BillingAuthorizationRequest> = {},
): BillingAuthorizationRequest {
  return { actor: BOB, tenant: TENANT, memberships: [member()], grants: [], ...overrides };
}

describe('billing authorization', () => {
  it('allows the tenant owner', () => {
    expect(authorizeBillingManagement(request({ actor: ALICE }))).toEqual({
      allowed: true,
      basis: 'owner',
    });
  });

  it('allows a member holding the billing permission at tenant scope', () => {
    expect(authorizeBillingManagement(request({ grants: [grant({ kind: 'tenant' })] }))).toEqual({
      allowed: true,
      basis: 'billing_grant',
    });
  });

  it('denies a member without the billing permission', () => {
    expect(authorizeBillingManagement(request())).toEqual({
      allowed: false,
      reason: 'billing_permission_not_granted',
    });
  });

  it('denies a workspace-scoped billing grant: billing is a tenant-scope action', () => {
    expect(
      authorizeBillingManagement(
        request({ grants: [grant({ kind: 'workspace', workspaceId: MAIN.id })] }),
      ),
    ).toEqual({ allowed: false, reason: 'billing_permission_not_granted' });
  });

  it('denies a billing grant issued to a different membership of the same account', () => {
    const otherMembership = member(BOB, 'mbr_acme_bob_other');
    expect(
      authorizeBillingManagement(
        request({ memberships: [member()], grants: [grant({ kind: 'tenant' }, otherMembership)] }),
      ),
    ).toEqual({ allowed: false, reason: 'billing_permission_not_granted' });
  });

  it('cannot resurrect billing authority after revoke and re-provision', () => {
    const first = member(BOB, 'mbr_acme_bob_1');
    const oldGrant = grant({ kind: 'tenant' }, first);
    const revoked = revokeMembership({ membership: first, revokedAt: REVOKED_AT });
    if (!revoked.ok) {
      throw new Error('fixture is invalid');
    }
    expect(
      authorizeBillingManagement(
        request({
          memberships: [revoked.value, member(BOB, 'mbr_acme_bob_2')],
          grants: [oldGrant],
        }),
      ),
    ).toEqual({ allowed: false, reason: 'billing_permission_not_granted' });
  });

  it('denies a revoked member even while the billing grant still exists', () => {
    const holder = member(BOB, 'mbr_acme_bob_1');
    const revoked = revokeMembership({ membership: holder, revokedAt: REVOKED_AT });
    if (!revoked.ok) {
      throw new Error('fixture is invalid');
    }
    expect(
      authorizeBillingManagement(
        request({ memberships: [revoked.value], grants: [grant({ kind: 'tenant' }, holder)] }),
      ),
    ).toEqual({ allowed: false, reason: 'membership_revoked' });
  });

  it('denies when two active memberships exist for the same account', () => {
    expect(
      authorizeBillingManagement(
        request({
          memberships: [member(BOB, 'mbr_acme_bob_1'), member(BOB, 'mbr_acme_bob_2')],
        }),
      ),
    ).toEqual({ allowed: false, reason: 'membership_ambiguous' });
  });

  it('denies unreadable context', () => {
    for (const actor of [undefined, null, '', 42]) {
      expect(authorizeBillingManagement(request({ actor }))).toEqual({
        allowed: false,
        reason: 'invalid_context',
      });
    }
    expect(authorizeBillingManagement(request({ tenant: null as unknown as Tenant }))).toEqual({
      allowed: false,
      reason: 'invalid_context',
    });
  });

  it('fails closed when the context mixes tenants', () => {
    expect(
      authorizeBillingManagement(
        request({ memberships: [{ ...member(), tenantId: 'tnt_other' as never }] }),
      ),
    ).toEqual({ allowed: false, reason: 'inconsistent_context' });
  });
});

describe('billing permission does not widen into other authority', () => {
  it('does not authorize tenant administration', () => {
    // Cùng một member, cùng một grant billing: quyền quản trị tenant vẫn deny.
    const billingGrant = grant({ kind: 'tenant' });
    expect(
      authorizeTenantAction({
        actor: BOB,
        tenant: TENANT,
        permission: createPermissionId('member.manage'),
        target: { kind: 'tenant' },
        memberships: [member()],
        grants: [billingGrant],
        workspaces: [MAIN],
        semantics: { tenantWideWorkspaceAdministration: [] },
      }),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });

  it('does not authorize workspace operations', () => {
    const billingGrant = grant({ kind: 'tenant' });
    expect(
      authorizeTenantAction({
        actor: BOB,
        tenant: TENANT,
        permission: LLM_TENANT_BILLING_MANAGEMENT_PERMISSION,
        target: { kind: 'workspace', workspaceId: MAIN.id },
        memberships: [member()],
        grants: [billingGrant],
        workspaces: [MAIN],
        semantics: { tenantWideWorkspaceAdministration: [] },
      }),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });

  it('does not carry any payment execution surface', async () => {
    // Domain chỉ trả quyết định allow/deny — không có hàm nào thực thi giao
    // dịch, đọc số dư hay gọi ledger.
    const mod = await import('./billing');
    expect(Object.keys(mod).toSorted()).toEqual(['authorizeBillingManagement']);
  });
});
