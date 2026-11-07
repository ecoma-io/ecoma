/**
 * Ghim quyết định authorization: deny-by-default, owner authority giới hạn
 * trong tenant của mình, explicit grant theo scope và theo membership, không kế
 * thừa ngầm, suspension đứng trước owner authority, và mọi ngữ cảnh lẫn/thiếu
 * đều fail closed.
 *
 * Mỗi ca dưới đây đỏ khi ai đó thêm một nhánh allow ngầm — không nhờ test khác.
 */

import { describe, expect, it } from 'vitest';

import {
  createPermissionId,
  type PermissionId,
  type TenantActorId,
  LLM_TENANT_BILLING_MANAGEMENT_PERMISSION,
} from './shared';
import { createTenant, type Tenant } from './tenant';
import { provisionMembership, revokeMembership, type Membership } from './membership';
import { createWorkspace, type Workspace } from './workspace';
import { createGrant, type PermissionGrant } from './grants';
import type { SuspensionEvaluation } from './suspension';
import {
  authorizeTenantAction,
  type AuthorizationRequest,
  type AuthorizationTarget,
  type PermissionSemantics,
} from './authorization';

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

const OTHER_TENANT: Tenant = (() => {
  const result = createTenant({
    id: 'tnt_other',
    name: 'Other',
    owner: 'sub_other_owner',
    createdAt: CREATED_AT,
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
})();

function workspace(id: string, tenantId = 'tnt_acme'): Workspace {
  const result = createWorkspace({ id, tenantId, name: id, createdAt: CREATED_AT });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
}

const MAIN = workspace('wsp_main');
const SIBLING = workspace('wsp_sibling');
const FOREIGN = workspace('wsp_foreign', 'tnt_other');

const WORKSPACE_ADMIN = createPermissionId('workspace.admin');
const WORKSPACE_READ = createPermissionId('workspace.read');

function member(actor: TenantActorId = BOB, id = `mbr_acme_${actor}`): Membership {
  const result = provisionMembership({ id, tenantId: 'tnt_acme', actor, createdAt: CREATED_AT });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
}

function grant(
  permission: PermissionId,
  scope: PermissionGrant['scope'],
  holder: Membership = member(),
  memberships: readonly Membership[] = [holder],
): PermissionGrant {
  const result = createGrant(
    { tenantId: 'tnt_acme', membershipId: holder.id, permission, scope },
    { memberships, workspaces: [MAIN, SIBLING], grants: [] },
  );
  if (!result.ok) {
    throw new Error(`fixture is invalid: ${result.error.code}`);
  }
  return result.value;
}

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    actor: BOB,
    tenant: TENANT,
    permission: WORKSPACE_READ,
    target: { kind: 'tenant' },
    memberships: [member()],
    grants: [],
    workspaces: [MAIN, SIBLING],
    semantics: { tenantWideWorkspaceAdministration: [] },
    ...overrides,
  };
}

const SUSPENDED: SuspensionEvaluation = {
  blocked: true,
  unevaluable: false,
  blockingRecordIds: ['sus_billing'],
  unknownPolicies: [],
};
const UNEVALUABLE: SuspensionEvaluation = {
  blocked: true,
  unevaluable: true,
  blockingRecordIds: ['sus_unknown'],
  unknownPolicies: ['policy_unknown'],
};
const NOT_SUSPENDED: SuspensionEvaluation = {
  blocked: false,
  unevaluable: false,
  blockingRecordIds: [],
  unknownPolicies: [],
};

const TENANT_TARGET: AuthorizationTarget = { kind: 'tenant' };
const MAIN_TARGET: AuthorizationTarget = { kind: 'workspace', workspaceId: 'wsp_main' };
const SIBLING_TARGET: AuthorizationTarget = { kind: 'workspace', workspaceId: 'wsp_sibling' };

describe('owner authority', () => {
  it('allows the owner on the tenant and on every workspace of that tenant', () => {
    expect(authorizeTenantAction(request({ actor: ALICE, target: TENANT_TARGET }))).toEqual({
      allowed: true,
      basis: 'owner',
    });
    expect(authorizeTenantAction(request({ actor: ALICE, target: MAIN_TARGET }))).toEqual({
      allowed: true,
      basis: 'owner',
    });
    expect(authorizeTenantAction(request({ actor: ALICE, target: SIBLING_TARGET }))).toEqual({
      allowed: true,
      basis: 'owner',
    });
  });

  it('gives the owner billing authority without a grant', () => {
    expect(
      authorizeTenantAction(
        request({ actor: ALICE, permission: LLM_TENANT_BILLING_MANAGEMENT_PERMISSION }),
      ),
    ).toEqual({ allowed: true, basis: 'owner' });
  });

  it('does not extend owner authority to another tenant', () => {
    // Alice là owner của `tnt_acme`; trên `tnt_other` cô ấy không có membership
    // nào, nên quyền owner không đi theo `sub`.
    expect(
      authorizeTenantAction(
        request({
          actor: ALICE,
          tenant: OTHER_TENANT,
          target: TENANT_TARGET,
          memberships: [],
          workspaces: [FOREIGN],
        }),
      ),
    ).toEqual({ allowed: false, reason: 'membership_missing' });
  });
});

describe('member authorization is explicit only', () => {
  it('denies a member without a grant', () => {
    expect(authorizeTenantAction(request())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('denies a grant of a different permission', () => {
    expect(
      authorizeTenantAction(request({ grants: [grant(WORKSPACE_ADMIN, { kind: 'tenant' })] })),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });

  it('does not let tenant scope authorize an arbitrary workspace operation', () => {
    // Grant tenant scope `workspace.read` không authorize thao tác trên workspace
    // cụ thể: không có kế thừa ngầm tenant → workspace.
    expect(
      authorizeTenantAction(
        request({
          grants: [grant(WORKSPACE_READ, { kind: 'tenant' })],
          target: MAIN_TARGET,
        }),
      ),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
    expect(
      authorizeTenantAction(
        request({
          grants: [grant(WORKSPACE_READ, { kind: 'tenant' })],
          target: TENANT_TARGET,
        }),
      ),
    ).toEqual({ allowed: true, basis: 'tenant_grant' });
  });

  it('authorizes a workspace grant only on the exact workspace', () => {
    const grantOnMain = grant(WORKSPACE_READ, {
      kind: 'workspace',
      workspaceId: MAIN.id,
    });
    expect(authorizeTenantAction(request({ grants: [grantOnMain], target: MAIN_TARGET }))).toEqual({
      allowed: true,
      basis: 'workspace_grant',
    });
    expect(
      authorizeTenantAction(request({ grants: [grantOnMain], target: SIBLING_TARGET })),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
    expect(
      authorizeTenantAction(request({ grants: [grantOnMain], target: TENANT_TARGET })),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });

  it('lets a tenant-wide workspace administration permission work only when declared', () => {
    const grantOnTenant = grant(WORKSPACE_ADMIN, { kind: 'tenant' });
    const declared: PermissionSemantics = {
      tenantWideWorkspaceAdministration: [WORKSPACE_ADMIN],
    };
    // Khai báo tường minh: grant tenant scope của chính permission đó authorize
    // cả hai workspace.
    expect(
      authorizeTenantAction(
        request({
          grants: [grantOnTenant],
          permission: WORKSPACE_ADMIN,
          target: MAIN_TARGET,
          semantics: declared,
        }),
      ),
    ).toEqual({ allowed: true, basis: 'tenant_wide_workspace_administration' });
    // Không khai báo: cùng grant, cùng target, deny.
    expect(
      authorizeTenantAction(
        request({ grants: [grantOnTenant], permission: WORKSPACE_ADMIN, target: MAIN_TARGET }),
      ),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });

  it('does not let a tenant-wide declaration smuggle a different permission into a workspace', () => {
    const grantOnRead = grant(WORKSPACE_READ, { kind: 'tenant' });
    expect(
      authorizeTenantAction(
        request({
          grants: [grantOnRead],
          permission: WORKSPACE_ADMIN,
          target: MAIN_TARGET,
          semantics: { tenantWideWorkspaceAdministration: [WORKSPACE_ADMIN] },
        }),
      ),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });

  it('never treats the billing permission as tenant-wide workspace administration', () => {
    // Một khai báo sai cố ý: billing permission KHÔNG được phép trở thành quyền
    // quản trị workspace. Semantics không hợp lệ ⇒ deny, không phải allow.
    const grantOnBilling = grant(LLM_TENANT_BILLING_MANAGEMENT_PERMISSION, { kind: 'tenant' });
    const decision = authorizeTenantAction(
      request({
        grants: [grantOnBilling],
        permission: LLM_TENANT_BILLING_MANAGEMENT_PERMISSION,
        target: MAIN_TARGET,
        semantics: {
          tenantWideWorkspaceAdministration: [LLM_TENANT_BILLING_MANAGEMENT_PERMISSION],
        },
      }),
    );
    expect(decision).toEqual({ allowed: false, reason: 'invalid_context' });
  });
});

describe('grants are bound to a membership identity', () => {
  it('does not authorize a member with a grant issued to another membership', () => {
    // Cùng `sub`, khác lần membership: quyền không đi theo account.
    const otherMembership = member(BOB, 'mbr_acme_bob_other');
    const foreignGrant = grant(WORKSPACE_READ, { kind: 'tenant' }, otherMembership);
    expect(
      authorizeTenantAction(request({ memberships: [member()], grants: [foreignGrant] })),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });

  it('cannot resurrect a permission after revoke and re-provision', () => {
    const first = member(BOB, 'mbr_acme_bob_1');
    const oldGrant = grant(WORKSPACE_READ, { kind: 'tenant' }, first);
    const revoked = revokeMembership({ membership: first, revokedAt: REVOKED_AT });
    if (!revoked.ok) {
      throw new Error('fixture is invalid');
    }
    const second = member(BOB, 'mbr_acme_bob_2');
    // Grant cũ vẫn nằm trong tập (audit), nhưng không thuộc membership mới.
    expect(
      authorizeTenantAction(request({ memberships: [revoked.value, second], grants: [oldGrant] })),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });
});

describe('revoked or ambiguous membership', () => {
  it('cannot authorize operations even while its grants still exist', () => {
    const holder = member(BOB, 'mbr_acme_bob_1');
    const grants = [grant(WORKSPACE_READ, { kind: 'tenant' }, holder)];
    const revoked = revokeMembership({ membership: holder, revokedAt: REVOKED_AT });
    if (!revoked.ok) {
      throw new Error('fixture is invalid');
    }
    expect(
      authorizeTenantAction(
        request({ memberships: [revoked.value], grants, target: TENANT_TARGET }),
      ),
    ).toEqual({ allowed: false, reason: 'membership_revoked' });
  });

  it('denies when two active memberships exist for the same account', () => {
    // Dữ liệu hỏng: chọn một bản ghi sẽ khiến grant của bản còn lại có thể được
    // tính. Deny thay vì đoán.
    expect(
      authorizeTenantAction(
        request({
          memberships: [member(BOB, 'mbr_acme_bob_1'), member(BOB, 'mbr_acme_bob_2')],
        }),
      ),
    ).toEqual({ allowed: false, reason: 'membership_ambiguous' });
  });
});

describe('suspension gates authorization', () => {
  it('denies a suspended target even for the owner', () => {
    expect(
      authorizeTenantAction(request({ actor: ALICE, suspension: SUSPENDED, target: MAIN_TARGET })),
    ).toEqual({ allowed: false, reason: 'target_suspended' });
    expect(
      authorizeTenantAction(
        request({
          actor: ALICE,
          target: MAIN_TARGET,
          grants: [grant(WORKSPACE_READ, { kind: 'workspace', workspaceId: MAIN.id }, member())],
          suspension: SUSPENDED,
        }),
      ),
    ).toEqual({ allowed: false, reason: 'target_suspended' });
  });

  it('denies when suspension cannot be evaluated', () => {
    expect(authorizeTenantAction(request({ actor: ALICE, suspension: UNEVALUABLE }))).toEqual({
      allowed: false,
      reason: 'suspension_unevaluable',
    });
  });

  it('denies a malformed suspension evaluation instead of ignoring it', () => {
    for (const suspension of [
      null,
      {},
      { blocked: 'no', blockingRecordIds: [], unknownPolicies: [] },
      { blocked: false },
    ]) {
      expect(
        authorizeTenantAction(
          request({ suspension: suspension as unknown as SuspensionEvaluation }),
        ),
      ).toEqual({ allowed: false, reason: 'suspension_unevaluable' });
    }
  });

  it('evaluates suspension before owner authority and membership', () => {
    // Owner bị suspension vẫn deny; actor không có membership cũng không được
    // lợi từ việc suspension che mất lý do khác.
    expect(
      authorizeTenantAction(
        request({ actor: ALICE, memberships: [], grants: [], suspension: SUSPENDED }),
      ),
    ).toEqual({ allowed: false, reason: 'target_suspended' });
  });

  it('allows an unsuspended target when the permission is otherwise granted', () => {
    expect(
      authorizeTenantAction(
        request({
          grants: [grant(WORKSPACE_READ, { kind: 'tenant' })],
          suspension: NOT_SUSPENDED,
        }),
      ),
    ).toEqual({ allowed: true, basis: 'tenant_grant' });
  });
});

describe('tenant and workspace isolation', () => {
  it('denies when the requested workspace belongs to another tenant', () => {
    const grants = [grant(WORKSPACE_READ, { kind: 'tenant' })];
    // `wsp_foreign` tồn tại trong tập nhưng thuộc `tnt_other` — tập lẫn tenant
    // là lỗi ngữ cảnh, không phải tín hiệu để lọc rồi allow.
    expect(
      authorizeTenantAction(
        request({
          grants,
          workspaces: [MAIN, FOREIGN],
          target: { kind: 'workspace', workspaceId: FOREIGN.id },
        }),
      ),
    ).toEqual({ allowed: false, reason: 'inconsistent_context' });
  });

  it('denies when the workspace does not belong to the selected tenant', () => {
    expect(
      authorizeTenantAction(request({ target: { kind: 'workspace', workspaceId: 'wsp_ghost' } })),
    ).toEqual({ allowed: false, reason: 'workspace_not_in_tenant' });
  });

  it('denies when membership or grant data belongs to another tenant', () => {
    expect(
      authorizeTenantAction(
        request({
          memberships: [{ ...member(), tenantId: 'tnt_other' as never }],
        }),
      ),
    ).toEqual({ allowed: false, reason: 'inconsistent_context' });
    expect(
      authorizeTenantAction(
        request({
          grants: [
            { ...grant(WORKSPACE_READ, { kind: 'tenant' }), tenantId: 'tnt_other' as never },
          ],
        }),
      ),
    ).toEqual({ allowed: false, reason: 'inconsistent_context' });
  });

  it('denies membership in one tenant from authorizing operations in another', () => {
    // Bob là member của `tnt_acme`; trên `tnt_other` cậu ấy không có membership.
    // Tập membership của tenant khác không được truyền vào request của
    // `tnt_other` — và nếu truyền vào thì đó là lỗi ngữ cảnh (ca dưới).
    expect(
      authorizeTenantAction(
        request({ tenant: OTHER_TENANT, memberships: [], workspaces: [FOREIGN] }),
      ),
    ).toEqual({ allowed: false, reason: 'membership_missing' });
    expect(
      authorizeTenantAction(
        request({ tenant: OTHER_TENANT, memberships: [member()], workspaces: [FOREIGN] }),
      ),
    ).toEqual({ allowed: false, reason: 'inconsistent_context' });
  });
});

describe('missing or unreadable context fails closed', () => {
  it('denies when the actor is missing or malformed', () => {
    for (const actor of [undefined, null, '', 42, {}]) {
      expect(authorizeTenantAction(request({ actor }))).toEqual({
        allowed: false,
        reason: 'invalid_context',
      });
    }
  });

  it('denies when the permission or target is missing or malformed', () => {
    for (const permission of [undefined, null, '', '*', 'Workspace.Read']) {
      expect(authorizeTenantAction(request({ permission }))).toEqual({
        allowed: false,
        reason: 'invalid_context',
      });
    }
    for (const target of [
      undefined,
      null,
      {},
      { kind: 'project' },
      { kind: 'workspace' },
      { kind: 'workspace', workspaceId: '' },
    ]) {
      expect(authorizeTenantAction(request({ target: target as AuthorizationTarget }))).toEqual({
        allowed: false,
        reason: 'invalid_context',
      });
    }
  });

  it('denies when the tenant is missing', () => {
    expect(authorizeTenantAction(request({ tenant: null as unknown as Tenant }))).toEqual({
      allowed: false,
      reason: 'invalid_context',
    });
  });

  it('denies when permission semantics are unreadable', () => {
    for (const semantics of [undefined, null, {}, { tenantWideWorkspaceAdministration: 'all' }]) {
      expect(
        authorizeTenantAction(request({ semantics: semantics as unknown as PermissionSemantics })),
      ).toEqual({ allowed: false, reason: 'invalid_context' });
    }
  });

  it('denies when the actor has no membership at all', () => {
    expect(authorizeTenantAction(request({ memberships: [] }))).toEqual({
      allowed: false,
      reason: 'membership_missing',
    });
  });
});
