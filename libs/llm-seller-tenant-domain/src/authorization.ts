/**
 * Authorization của Seller tenant.
 *
 * Source of truth: `docs/domains/llm-seller-tenant/domain-model.md` §4.1; ADR-0003, ADR-0005, ADR-0007.
 *
 * Thang quyết định fail-closed, mỗi bước không suy ra bước sau:
 *
 * 1. Ngữ cảnh đọc được.
 * 2. Mọi membership/grant thuộc đúng tenant.
 * 3. Restriction — **trước owner**: `undefined`, `blocked`, `unevaluable` đều
 *    deny, kể cả owner và kể cả payout.
 * 4. Owner ⇒ allow.
 * 5. Đúng một membership `active` của actor; 0/1-revoked/>1 đều deny.
 * 6. Grant `active` của đúng `membershipId` cho đúng permission ⇒ allow.
 * 7. Còn lại deny.
 *
 * Kết quả mang `tenantScope: 'seller_tenant'` cố định: consumer **không** được
 * diễn giải verdict này thành quyền ở Console tenant.
 */

import {
  isPermissionId,
  isSellerActorId,
  isSellerTenantId,
  LLM_SELLER_AUTHORIZATION_SCOPE,
  LLM_SELLER_PAYOUT_PERMISSION,
  LLM_SELLER_PAYOUT_TARGET,
  type PermissionId,
} from './shared';
import { findActiveMemberships, isSellerMembership, type SellerMembership } from './membership';
import {
  findActiveGrants,
  isGrantActiveForMembership,
  isPermissionGrant,
  type PermissionGrant,
} from './grants';
import {
  isSameRestrictionTarget,
  isSellerRestrictionTarget,
  isSellerRestrictionVerdict,
  type SellerRestrictionVerdict,
} from './restriction-verdict';
import type { SellerTenant } from './seller-tenant';

/** Cơ sở của một quyết định allow. */
export type SellerAuthorizationBasis = 'owner' | 'tenant_grant';

/**
 * Lý do deny. Đây **không** phải domain error: authorization là quyết định,
 * không phải thao tác hỏng dữ liệu, nên nó nằm trên decision thay vì `Result`.
 */
export type SellerAuthorizationDenialReason =
  | 'invalid_context'
  | 'inconsistent_context'
  | 'restriction_unevaluable'
  | 'restricted'
  | 'membership_missing'
  | 'membership_revoked'
  | 'membership_ambiguous'
  | 'permission_not_granted';

/** Quyết định allow. */
export interface SellerAuthorizationAllowed {
  readonly allowed: true;
  readonly basis: SellerAuthorizationBasis;
  readonly permission: PermissionId;
  readonly tenantScope: typeof LLM_SELLER_AUTHORIZATION_SCOPE;
}

/**
 * Quyết định deny.
 *
 * `permission` là `null` chỉ khi chính input permission không đọc được — lúc đó
 * không có giá trị nào để báo lại, và bịa một permission khác sẽ làm log sai.
 */
export interface SellerAuthorizationDenied {
  readonly allowed: false;
  readonly reason: SellerAuthorizationDenialReason;
  readonly permission: PermissionId | null;
  readonly tenantScope: typeof LLM_SELLER_AUTHORIZATION_SCOPE;
}

/** Kết quả authorization. */
export type SellerAuthorizationDecision = SellerAuthorizationAllowed | SellerAuthorizationDenied;

/** Input authorization. */
export interface SellerAuthorizationRequest {
  readonly actor: unknown;
  readonly tenant: SellerTenant;
  readonly permission: unknown;
  /**
   * Target mà permission sắp tác động. Domain không suy target từ permission —
   * catalog permission là opaque (ADR-0007) — nên caller phải khai báo, và
   * evaluation bắt buộc phải là evaluation **của đúng target này**.
   */
  readonly target: unknown;
  readonly memberships: readonly SellerMembership[];
  readonly grants: readonly PermissionGrant[];
  /**
   * Kết quả `evaluateRestrictions` cho Seller tenant này **và** cho `target`.
   * **Bắt buộc** ở kiểu: `undefined` mang nghĩa "chưa đánh giá" và luôn deny.
   */
  readonly restrictions: SellerRestrictionVerdict | undefined;
}

/**
 * Quyết định actor có được thực hiện `permission` trên Seller tenant không.
 *
 * Hàm thuần, không đọc clock, không đọc storage.
 */
export function authorizeSellerAction(
  request: SellerAuthorizationRequest,
): SellerAuthorizationDecision {
  const permission = readPermission(request.permission);
  if (permission === undefined) {
    return denial('invalid_context', null);
  }
  const tenant = request.tenant;
  if (
    typeof tenant !== 'object' ||
    tenant === null ||
    !isSellerTenantId(tenant.id) ||
    !isSellerActorId(tenant.owner)
  ) {
    return denial('invalid_context', permission);
  }
  if (!isSellerActorId(request.actor)) {
    return denial('invalid_context', permission);
  }
  if (!Array.isArray(request.memberships) || !Array.isArray(request.grants)) {
    return denial('invalid_context', permission);
  }
  if (!isSellerRestrictionTarget(request.target)) {
    return denial('invalid_context', permission);
  }
  if (
    !request.memberships.every(
      (membership) => isSellerMembership(membership) && membership.tenantId === tenant.id,
    ) ||
    !request.grants.every((grant) => isPermissionGrant(grant) && grant.tenantId === tenant.id)
  ) {
    return denial('inconsistent_context', permission);
  }
  if (request.restrictions === undefined || !isSellerRestrictionVerdict(request.restrictions)) {
    // Evaluation thiếu, hỏng hoặc thiếu `blocked`/`unevaluable` không phải bằng
    // chứng "không bị chặn" — fail closed.
    return denial('restriction_unevaluable', permission);
  }
  if (
    request.restrictions.tenantId !== tenant.id ||
    !isSameRestrictionTarget(request.restrictions.target, request.target)
  ) {
    // Evaluation của tenant hoặc target khác không trả lời câu hỏi cho request
    // này; tin nó là mở đường cho bypass restriction capability.
    return denial('restriction_unevaluable', permission);
  }
  if (request.restrictions.unevaluable) {
    return denial('restriction_unevaluable', permission);
  }
  if (request.restrictions.blocked) {
    return denial('restricted', permission);
  }
  if (tenant.owner === request.actor) {
    return allow('owner', permission);
  }
  const activeMemberships = findActiveMemberships(request.memberships, tenant.id, request.actor);
  if (activeMemberships.length === 0) {
    const hadRevokedMembership = request.memberships.some(
      (membership) => membership.tenantId === tenant.id && membership.actor === request.actor,
    );
    return denial(hadRevokedMembership ? 'membership_revoked' : 'membership_missing', permission);
  }
  if (activeMemberships.length > 1) {
    // Phòng thủ: partial unique index đúng không tạo ra trường hợp này. Dữ liệu
    // hỏng đọc từ storage thì deny, không chọn một bản ghi.
    return denial('membership_ambiguous', permission);
  }
  const membership = activeMemberships[0];
  const hasGrant = findActiveGrants(request.grants, membership.id).some(
    (grant) => grant.permission === permission && isGrantActiveForMembership(grant, membership),
  );
  if (!hasGrant) {
    return denial('permission_not_granted', permission);
  }
  return allow('tenant_grant', permission);
}

/** Input authorization cho payout. `target` được ghim ở `authorizeSellerPayout`. */
export type SellerPayoutAuthorizationRequest = Omit<
  SellerAuthorizationRequest,
  'permission' | 'target'
>;

/**
 * Authorization cho payout/EC→UC conversion ở phía Seller.
 *
 * Dùng cùng thang với permission `payout.manage` và target capability
 * `payout` — evaluation caller truyền vào phải được tính cho đúng target đó,
 * nếu không ladder từ chối (`restriction_unevaluable`).
 *
 * Đây chỉ là **một nửa** của quyết định EC→UC: phía Consumer
 * (`llm-consumer-tenant`) phải trả lời độc lập về payment permission
 * ([`llm-financial/adr/0005`](../../../docs/domains/llm-financial/adr/0005-ec-to-uc-conversion.md)).
 */
export function authorizeSellerPayout(
  request: SellerPayoutAuthorizationRequest,
): SellerAuthorizationDecision {
  return authorizeSellerAction({
    ...request,
    permission: LLM_SELLER_PAYOUT_PERMISSION,
    target: LLM_SELLER_PAYOUT_TARGET,
  });
}

function readPermission(value: unknown): PermissionId | undefined {
  return isPermissionId(value) ? value : undefined;
}

function allow(
  basis: SellerAuthorizationBasis,
  permission: PermissionId,
): SellerAuthorizationAllowed {
  return Object.freeze({
    allowed: true,
    basis,
    permission,
    tenantScope: LLM_SELLER_AUTHORIZATION_SCOPE,
  });
}

function denial(
  reason: SellerAuthorizationDenialReason,
  permission: PermissionId | null,
): SellerAuthorizationDenied {
  return Object.freeze({
    allowed: false,
    reason,
    permission,
    tenantScope: LLM_SELLER_AUTHORIZATION_SCOPE,
  });
}
