/**
 * Billing-management authorization — một permission chuyên biệt cho phép member
 * khởi tạo/top up tenant.
 *
 * Source of truth: `docs/domains/llm-consumer-tenant/domain-model.md` §2, §2.
 *
 * Ranh giới:
 * - Permission này **chỉ** authorize hành vi khởi tạo/top up cho tenant. Nó
 *   **không** cấp quyền quản trị tenant (member, workspace, cấu hình) và
 *   **không** cấp bất kỳ quyền payment nào: thực thi giao dịch, số dư, ledger,
 *   reconciliation và cơ chế nạp tiền thuộc `payment`/`llm-financial`.
 * - Billing là hành vi ở **tenant scope**. Grant workspace scope của permission
 *   này không authorize top up; lib không cung cấp đường nào để dùng nó cho
 *   target workspace.
 * - Permission này không được khai báo là tenant-wide workspace administration
 *   (`./authorization.ts` từ chối khai báo đó).
 * - Billing account **không** 1:1 với tenant. Quyết định này là một cổng ở mức
 *   sản phẩm; nó **không** xác nhận rằng billing account cụ thể thuộc tenant
 *   nào, và không được dùng để suy ra quyền trên billing account. Authorization
 *   cho billing account cụ thể thuộc `llm-financial`/`payment`.
 */

import {
  isPermissionId,
  isTenantActorId,
  isTenantId,
  LLM_TENANT_BILLING_MANAGEMENT_PERMISSION,
  type TenantActorId,
} from './shared';
import { findMembership, type Membership } from './membership';
import type { PermissionGrant } from './grants';
import { isTenantOwner, type Tenant } from './tenant';

/** Lý do deny billing authorization — tập ĐÓNG. */
export type BillingAuthorizationDenialReason =
  | 'invalid_context'
  | 'inconsistent_context'
  | 'membership_missing'
  | 'membership_revoked'
  | 'membership_ambiguous'
  | 'billing_permission_not_granted';

/** Cơ sở của quyết định allow billing. */
export type BillingAuthorizationBasis = 'owner' | 'billing_grant';

/** Kết quả authorization cho hành vi billing của tenant. */
export type BillingAuthorizationDecision =
  | { readonly allowed: true; readonly basis: BillingAuthorizationBasis }
  | { readonly allowed: false; readonly reason: BillingAuthorizationDenialReason };

/** Yêu cầu authorization billing trên một tenant. */
export interface BillingAuthorizationRequest {
  readonly actor: unknown;
  readonly tenant: Tenant;
  readonly memberships: readonly Membership[];
  readonly grants: readonly PermissionGrant[];
}

/**
 * Quyết định actor có được khởi tạo/top up cho tenant không.
 *
 * Chỉ owner hoặc member có grant **tenant scope** của
 * {@link LLM_TENANT_BILLING_MANAGEMENT_PERMISSION} trên **chính membership
 * active** của mình được allow. Grant workspace scope, grant của permission
 * khác, grant còn sót lại của membership đã revoke, và membership đã revoke đều
 * deny.
 *
 * Hàm không thực hiện giao dịch, không đọc số dư, không gọi dịch vụ ngoài.
 */
export function authorizeBillingManagement(
  request: BillingAuthorizationRequest,
): BillingAuthorizationDecision {
  const { actor, tenant, memberships, grants } = request;

  if (
    !isTenantActorId(actor) ||
    tenant === null ||
    typeof tenant !== 'object' ||
    !isTenantId(tenant.id) ||
    !isTenantActorId(tenant.owner) ||
    !isPermissionId(LLM_TENANT_BILLING_MANAGEMENT_PERMISSION) ||
    !Array.isArray(memberships) ||
    !Array.isArray(grants)
  ) {
    return { allowed: false, reason: 'invalid_context' };
  }

  if (
    memberships.some((membership) => membership.tenantId !== tenant.id) ||
    grants.some((grant) => grant.tenantId !== tenant.id)
  ) {
    return { allowed: false, reason: 'inconsistent_context' };
  }

  if (isTenantOwner(tenant, actor as TenantActorId)) {
    return { allowed: true, basis: 'owner' };
  }

  const actorMemberships = memberships.filter(
    (candidate) => candidate.tenantId === tenant.id && candidate.actor === actor,
  );
  if (actorMemberships.length === 0) {
    return { allowed: false, reason: 'membership_missing' };
  }
  const active = actorMemberships.filter((candidate) => candidate.status === 'active');
  if (active.length === 0) {
    return { allowed: false, reason: 'membership_revoked' };
  }
  if (active.length > 1) {
    return { allowed: false, reason: 'membership_ambiguous' };
  }
  const membership = active[0] as Membership;
  if (findMembership([membership], tenant.id, actor as TenantActorId) === undefined) {
    return { allowed: false, reason: 'membership_ambiguous' };
  }

  const hasTenantScopeBillingGrant = grants.some(
    (grant) =>
      grant.tenantId === tenant.id &&
      grant.membershipId === membership.id &&
      grant.permission === LLM_TENANT_BILLING_MANAGEMENT_PERMISSION &&
      grant.scope.kind === 'tenant',
  );
  if (!hasTenantScopeBillingGrant) {
    return { allowed: false, reason: 'billing_permission_not_granted' };
  }

  return { allowed: true, basis: 'billing_grant' };
}
