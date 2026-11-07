/**
 * Membership của Seller tenant.
 *
 * Source of truth: `docs/domains/llm-seller-tenant/domain-model.md` §1, §3.2;
 * ADR-0005.
 *
 * Hai điểm cốt lõi:
 * - Membership là **một lần** cấp quyền, không phải một quan hệ lâu dài. Revoke
 *   rồi provision lại tạo `id` mới, nên grant của lần cũ không thể sống lại.
 * - Mọi membership trong một collection phải thuộc đúng một tenant. Domain từ
 *   chối cả collection lệch tenant thay vì lọc rồi tiếp tục — lọc im lặng biến
 *   một lỗi dữ liệu thành một quyết định authorization.
 */

import {
  isEpochMillis,
  isMembershipId,
  isSellerActorId,
  isSellerTenantId,
  llmSellerFailure,
  llmSellerOk,
  type LlmSellerResult,
  type MembershipId,
  type SellerActorId,
  type SellerTenantId,
} from './shared';

/** Trạng thái của một lần membership. `revoked` là terminal. */
export type SellerMembershipStatus = 'active' | 'revoked';

/** Một lần membership của actor trong Seller tenant. */
export interface SellerMembership {
  readonly id: MembershipId;
  readonly tenantId: SellerTenantId;
  readonly actor: SellerActorId;
  readonly status: SellerMembershipStatus;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

/** Input provision membership. */
export interface ProvisionMembershipInput {
  readonly id: unknown;
  readonly tenantId: unknown;
  readonly actor: unknown;
  readonly createdAt: unknown;
}

/**
 * Provision membership mới ở trạng thái `active`.
 *
 * Guard:
 * - `id`, `tenantId`, `actor`, `createdAt` đọc được.
 * - `existing` là array và mọi phần tử thuộc `tenantId`.
 * - `id` chưa xuất hiện trong tenant.
 * - Actor chưa có membership `active` trong tenant.
 *
 * `createdAt` do caller cấp; domain không đọc clock và không suy ra thời điểm
 * từ `revokedAt` của bản ghi cũ.
 */
export function provisionMembership(
  input: ProvisionMembershipInput,
  existing: readonly SellerMembership[],
): LlmSellerResult<SellerMembership> {
  if (!isMembershipId(input.id)) {
    return llmSellerFailure('invalid_membership_id');
  }
  const tenantId = input.tenantId;
  if (!isSellerTenantId(tenantId)) {
    return llmSellerFailure('invalid_seller_tenant_id');
  }
  const actor = input.actor;
  if (!isSellerActorId(actor)) {
    return llmSellerFailure('invalid_actor');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmSellerFailure('invalid_timestamp');
  }
  if (!Array.isArray(existing)) {
    return llmSellerFailure('ambiguous_context');
  }
  if (existing.some((membership) => !isSellerMembership(membership))) {
    return llmSellerFailure('inconsistent_context');
  }
  if (existing.some((membership) => !isMembershipInTenant(membership, tenantId))) {
    return llmSellerFailure('inconsistent_context');
  }
  if (existing.some((membership) => membership.id === input.id)) {
    return llmSellerFailure('duplicate_membership_id');
  }
  if (hasActiveMembership(existing, actor)) {
    return llmSellerFailure('membership_already_active');
  }
  return llmSellerOk(
    Object.freeze({
      id: input.id,
      tenantId,
      actor,
      status: 'active' as const,
      createdAt: input.createdAt,
      revokedAt: null,
    }),
  );
}

/** Input revoke membership. */
export interface RevokeMembershipInput {
  readonly membership: SellerMembership;
  readonly revokedAt: unknown;
}

/**
 * Revoke một membership `active`.
 *
 * Membership đã revoke trả `membership_already_revoked` — revoke không idempotent
 * ở tầng domain vì `revokedAt` là dữ liệu audit: ghi đè nó sẽ làm mất thời điểm
 * thu hồi thật.
 */
export function revokeMembership(input: RevokeMembershipInput): LlmSellerResult<SellerMembership> {
  if (!isEpochMillis(input.revokedAt)) {
    return llmSellerFailure('invalid_timestamp');
  }
  if (!isSellerMembership(input.membership)) {
    return llmSellerFailure('invalid_membership');
  }
  if (input.membership.status === 'revoked' || input.membership.revokedAt !== null) {
    // `revokedAt` đã có nghĩa là đã từng bị thu hồi: ghi đè sẽ làm mất thời
    // điểm thật, kể cả khi `status` bị hỏng thành `active`.
    return llmSellerFailure('membership_already_revoked');
  }
  return llmSellerOk(
    Object.freeze({
      ...input.membership,
      status: 'revoked' as const,
      revokedAt: input.revokedAt,
    }),
  );
}

/** Membership đang `active`? */
export function isMembershipActive(membership: SellerMembership): boolean {
  return membership.status === 'active' && membership.revokedAt === null;
}

/** Membership thuộc đúng tenant? */
export function isMembershipInTenant(
  membership: unknown,
  tenantId: SellerTenantId,
): membership is SellerMembership {
  return isSellerMembership(membership) && membership.tenantId === tenantId;
}

/**
 * Mọi membership `active` của `(tenant, actor)`.
 *
 * Trả về array để authorization phát hiện trường hợp > 1 bản ghi active. Adapter
 * đúng với partial unique index không tạo ra trường hợp đó, nhưng dữ liệu đọc
 * từ storage/contract có thể hỏng.
 */
export function findActiveMemberships(
  memberships: readonly SellerMembership[],
  tenantId: SellerTenantId,
  actor: SellerActorId,
): readonly SellerMembership[] {
  if (!Array.isArray(memberships)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    memberships.filter(
      (membership) =>
        isSellerMembership(membership) &&
        isMembershipInTenant(membership, tenantId) &&
        membership.actor === actor &&
        isMembershipActive(membership),
    ),
  );
}

/**
 * Actor đã có membership `active` trong tenant chưa.
 *
 * Dữ liệu hỏng chỉ bị bỏ qua, không được tính là active: hàm này chỉ dùng để
 * chặn provision trùng, nên fail-closed nghĩa là "không thấy active".
 */
export function hasActiveMembership(
  memberships: readonly SellerMembership[],
  actor: SellerActorId,
): boolean {
  if (!Array.isArray(memberships)) {
    return false;
  }
  return memberships.some(
    (membership) =>
      isSellerMembership(membership) &&
      membership.actor === actor &&
      isMembershipActive(membership),
  );
}

/**
 * Re-run shape guard cho membership đọc từ storage.
 *
 * Persistence adapter phải gọi hàm này trước khi dùng dữ liệu cho authorization.
 */
export function isSellerMembership(value: unknown): value is SellerMembership {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof SellerMembership, unknown>>;
  if (!isMembershipId(candidate.id) || !isSellerTenantId(candidate.tenantId)) {
    return false;
  }
  if (!isSellerActorId(candidate.actor) || !isEpochMillis(candidate.createdAt)) {
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
