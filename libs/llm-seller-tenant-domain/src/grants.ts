/**
 * Permission grant của Seller tenant.
 *
 * Source of truth: `docs/domains/llm-seller-tenant/domain-model.md` §1, §3.4;
 * ADR-0005, ADR-0007.
 *
 * Grant luôn trỏ tới một **membership incarnation** cụ thể, không trỏ tới actor.
 * Đó là toàn bộ lý do `MembershipId` tồn tại: nếu grant trỏ actor thì revoke
 * membership rồi provision lại sẽ làm quyền cũ sống lại.
 *
 * Grant không mang `scope`: mọi grant đều ở tenant scope. Scope tài chính của
 * Seller tenant là ngữ nghĩa, không phải một cột.
 */

import {
  isEpochMillis,
  isGrantId,
  isMembershipId,
  isPermissionId,
  isSellerTenantId,
  llmSellerFailure,
  llmSellerOk,
  type LlmSellerResult,
  type GrantId,
  type MembershipId,
  type PermissionId,
  type SellerTenantId,
} from './shared';
import { isMembershipActive, isSellerMembership, type SellerMembership } from './membership';

/** Trạng thái grant. `revoked` là terminal. */
export type PermissionGrantStatus = 'active' | 'revoked';

/** Một lần cấp permission cho membership incarnation. */
export interface PermissionGrant {
  readonly id: GrantId;
  readonly tenantId: SellerTenantId;
  readonly membershipId: MembershipId;
  readonly permission: PermissionId;
  readonly status: PermissionGrantStatus;
  readonly grantedAt: number;
  readonly revokedAt: number | null;
}

/** Input cấp grant. */
export interface CreateGrantInput {
  readonly id: unknown;
  readonly tenantId: unknown;
  readonly membershipId: unknown;
  readonly permission: unknown;
  readonly grantedAt: unknown;
}

/** Tham chiếu membership/grant hiện có để kiểm tra ràng buộc. */
export interface GrantContext {
  readonly memberships: readonly SellerMembership[];
  readonly grants: readonly PermissionGrant[];
}

/**
 * Cấp permission cho một membership `active`.
 *
 * Guard:
 * - Field đọc được (`invalid_grant_id`, `invalid_permission_id`,
 *   `invalid_timestamp`).
 * - `memberships`/`grants` là array và mọi phần tử thuộc `tenantId`
 *   (`inconsistent_context`).
 * - Membership tồn tại trong tenant và đang `active` — không cấp grant cho
 *   membership đã revoke (`membership_not_found`).
 * - `id` chưa xuất hiện trong tenant (`duplicate_grant_id`).
 * - Chưa có grant `active` cho cùng `(membershipId, permission)`
 *   (`duplicate_grant`). Grant đã revoke không chặn việc cấp lại: bản mới có
 *   `id` mới và giữ lịch sử.
 */
export function createGrant(
  input: CreateGrantInput,
  context: GrantContext,
): LlmSellerResult<PermissionGrant> {
  if (!isGrantId(input.id)) {
    return llmSellerFailure('invalid_grant_id');
  }
  if (!isSellerTenantId(input.tenantId)) {
    return llmSellerFailure('invalid_seller_tenant_id');
  }
  if (!isMembershipId(input.membershipId)) {
    return llmSellerFailure('invalid_membership_id');
  }
  if (!isPermissionId(input.permission)) {
    return llmSellerFailure('invalid_permission_id');
  }
  if (!isEpochMillis(input.grantedAt)) {
    return llmSellerFailure('invalid_timestamp');
  }
  if (!Array.isArray(context.memberships) || !Array.isArray(context.grants)) {
    return llmSellerFailure('ambiguous_context');
  }
  if (
    context.memberships.some(
      (membership) => !isSellerMembership(membership) || membership.tenantId !== input.tenantId,
    ) ||
    context.grants.some((grant) => !isPermissionGrant(grant) || grant.tenantId !== input.tenantId)
  ) {
    return llmSellerFailure('inconsistent_context');
  }
  const membership = context.memberships.find((candidate) => candidate.id === input.membershipId);
  if (membership === undefined || !isMembershipActive(membership)) {
    return llmSellerFailure('membership_not_found');
  }
  if (context.grants.some((grant) => grant.id === input.id)) {
    return llmSellerFailure('duplicate_grant_id');
  }
  if (
    context.grants.some(
      (grant) =>
        grant.status === 'active' &&
        grant.membershipId === input.membershipId &&
        grant.permission === input.permission,
    )
  ) {
    return llmSellerFailure('duplicate_grant');
  }
  return llmSellerOk(
    Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      membershipId: input.membershipId,
      permission: input.permission,
      status: 'active' as const,
      grantedAt: input.grantedAt,
      revokedAt: null,
    }),
  );
}

/** Input revoke grant. */
export interface RevokeGrantInput {
  readonly grant: PermissionGrant;
  readonly revokedAt: unknown;
}

/** Revoke một grant `active`. Revoke lần hai trả `grant_already_revoked`. */
export function revokeGrant(input: RevokeGrantInput): LlmSellerResult<PermissionGrant> {
  if (!isEpochMillis(input.revokedAt)) {
    return llmSellerFailure('invalid_timestamp');
  }
  if (!isPermissionGrant(input.grant)) {
    return llmSellerFailure('invalid_grant');
  }
  if (input.grant.status === 'revoked' || input.grant.revokedAt !== null) {
    // `revokedAt` đã có nghĩa là đã từng bị thu hồi: ghi đè sẽ làm mất thời
    // điểm thật, kể cả khi `status` bị hỏng thành `active`.
    return llmSellerFailure('grant_already_revoked');
  }
  return llmSellerOk(
    Object.freeze({
      ...input.grant,
      status: 'revoked' as const,
      revokedAt: input.revokedAt,
    }),
  );
}

/**
 * Grant có authorize cho membership này không.
 *
 * Cần **cả hai**: grant `active` và membership được tham chiếu đang `active`.
 * Nhờ vế thứ hai, grant của lần membership cũ không bao giờ authorize lần
 * membership mới dù adapter trả về cả hai collection.
 */
export function isGrantActiveForMembership(
  grant: PermissionGrant,
  membership: SellerMembership,
): boolean {
  if (!isPermissionGrant(grant) || !isSellerMembership(membership)) {
    return false;
  }
  return (
    grant.status === 'active' &&
    grant.revokedAt === null &&
    grant.membershipId === membership.id &&
    grant.tenantId === membership.tenantId &&
    membership.status === 'active' &&
    membership.revokedAt === null
  );
}

/** Mọi grant `active` của đúng membership incarnation. */
export function findActiveGrants(
  grants: readonly PermissionGrant[],
  membershipId: MembershipId,
): readonly PermissionGrant[] {
  if (!Array.isArray(grants)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    grants.filter(
      (grant) =>
        isPermissionGrant(grant) &&
        grant.status === 'active' &&
        grant.membershipId === membershipId,
    ),
  );
}

/**
 * Re-run shape guard cho grant đọc từ storage.
 *
 * Adapter phải gọi trước khi dùng dữ liệu cho authorization.
 */
export function isPermissionGrant(value: unknown): value is PermissionGrant {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof PermissionGrant, unknown>>;
  if (!isGrantId(candidate.id) || !isSellerTenantId(candidate.tenantId)) {
    return false;
  }
  if (!isMembershipId(candidate.membershipId) || !isPermissionId(candidate.permission)) {
    return false;
  }
  if (!isEpochMillis(candidate.grantedAt)) {
    return false;
  }
  if (candidate.status === 'active') {
    return candidate.revokedAt === null;
  }
  if (candidate.status === 'revoked') {
    return isEpochMillis(candidate.revokedAt);
  }
  return false;
}
