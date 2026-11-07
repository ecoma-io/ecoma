/**
 * SellerTenant — aggregate root của bounded context `llm-seller`.
 *
 * Source of truth: `docs/domains/llm-seller-tenant/domain-model.md` §1, §3.1;
 * ADR-0001 (ownership and transfer), ADR-0002 (existence vs eligibility).
 *
 * Quy tắc:
 * - **Đúng một owner**, luôn có. Owner là một `sub` trên tenant — không phải
 *   membership role, không phải permission grant.
 * - Tenant **không** mang `status`/`archivedAt`/`deletedAt`. Tồn tại, operational
 *   eligibility, verification và restriction là bốn trục độc lập; ba trục sau
 *   là **giá trị suy ra** (xem `restriction.ts`, `verification.ts`).
 * - Transfer là operation tường minh: owner mới phải là member active, owner cũ
 *   trở thành member, output luôn có đúng một owner.
 */

import {
  isEpochMillis,
  isMembershipId,
  isSellerActorId,
  isSellerTenantId,
  isSellerText,
  llmSellerFailure,
  llmSellerOk,
  type LlmSellerResult,
  type SellerActorId,
  type SellerTenantId,
} from './shared';
import {
  isMembershipActive,
  isSellerMembership,
  type SellerMembership,
  type ProvisionMembershipInput,
  provisionMembership,
} from './membership';

/** Một Seller tenant. Không có cột lifecycle. */
export interface SellerTenant {
  readonly id: SellerTenantId;
  readonly name: string;
  readonly owner: SellerActorId;
  readonly createdAt: number;
}

/** Input tạo Seller tenant. Field `unknown` để boundary từ chối mọi thứ. */
export interface CreateSellerTenantInput {
  readonly id: unknown;
  readonly name: unknown;
  readonly owner: unknown;
  readonly createdAt: unknown;
}

/**
 * Tạo Seller tenant ở trạng thái tồn tại và operational-active ngay.
 *
 * Không có trạng thái `pending` và không có điều kiện onboarding approval:
 * verification/onboarding được đánh giá riêng như giá trị suy ra (ADR-0002).
 */
export function createSellerTenant(input: CreateSellerTenantInput): LlmSellerResult<SellerTenant> {
  if (!isSellerTenantId(input.id)) {
    return llmSellerFailure('invalid_seller_tenant_id');
  }
  if (!isSellerText(input.name)) {
    return llmSellerFailure('invalid_seller_tenant_name');
  }
  if (!isSellerActorId(input.owner)) {
    return llmSellerFailure('invalid_actor');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmSellerFailure('invalid_timestamp');
  }
  return llmSellerOk(
    Object.freeze({
      id: input.id,
      name: input.name,
      owner: input.owner,
      createdAt: input.createdAt,
    }),
  );
}

/** Actor có phải owner của tenant này không. Owner authority không đi xuyên tenant. */
export function isSellerOwner(tenant: SellerTenant, actor: SellerActorId): boolean {
  return isSellerTenant(tenant) && tenant.owner === actor;
}

/**
 * Shape guard cho `SellerTenant` đọc từ storage/contract.
 *
 * Adapter phải gọi trước khi dùng tenant cho transfer/authorization.
 */
export function isSellerTenant(value: unknown): value is SellerTenant {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof SellerTenant, unknown>>;
  return (
    isSellerTenantId(candidate.id) &&
    isSellerText(candidate.name) &&
    isSellerActorId(candidate.owner) &&
    isEpochMillis(candidate.createdAt)
  );
}

/** Input chuyển ownership. */
export interface TransferSellerOwnershipInput {
  readonly tenant: SellerTenant;
  readonly memberships: readonly SellerMembership[];
  readonly newOwner: unknown;
  readonly transferredBy: unknown;
  readonly transferredAt: unknown;
  /**
   * Membership ID dùng để giữ owner cũ làm member khi owner cũ **chưa** có
   * membership active. Bỏ qua khi owner cũ đã có membership active.
   */
  readonly formerOwnerMembershipId?: unknown;
}

/** Kết quả chuyển ownership: tenant mới + tập membership sau transfer. */
export interface SellerOwnershipTransfer {
  readonly tenant: SellerTenant;
  readonly memberships: readonly SellerMembership[];
  readonly previousOwner: SellerActorId;
  readonly newOwner: SellerActorId;
  readonly transferredAt: number;
}

/**
 * Chuyển ownership của Seller tenant.
 *
 * Guard (fail closed, theo thứ tự):
 * 1. `newOwner`, `transferredBy`, `transferredAt` đọc được.
 * 2. `transferredBy` là owner hiện tại — không có đường nào để non-owner tự
 *    chuyển tenant sang mình.
 * 3. `newOwner` khác owner hiện tại.
 * 4. `newOwner` có membership **active** trong tenant này.
 * 5. Mọi membership trong input thuộc đúng tenant.
 * 6. Nếu owner cũ chưa có membership active, phải cấp `formerOwnerMembershipId`;
 *    ID đó không được trùng membership đã có.
 *
 * Hệ quả: tenant có owner mới; owner cũ trở thành member active; grant hiện có
 * không bị đổi (grant thuộc membership, không thuộc owner). Không có trạng thái
 * trung gian ownerless.
 */
export function transferSellerOwnership(
  input: TransferSellerOwnershipInput,
): LlmSellerResult<SellerOwnershipTransfer> {
  if (!isSellerActorId(input.newOwner)) {
    return llmSellerFailure('invalid_actor');
  }
  if (!isSellerActorId(input.transferredBy)) {
    return llmSellerFailure('invalid_actor');
  }
  if (!isEpochMillis(input.transferredAt)) {
    return llmSellerFailure('invalid_timestamp');
  }
  if (!isSellerTenant(input.tenant)) {
    return llmSellerFailure('invalid_seller_tenant');
  }
  if (!Array.isArray(input.memberships)) {
    return llmSellerFailure('ambiguous_context');
  }
  if (input.transferredBy !== input.tenant.owner) {
    return llmSellerFailure('actor_not_owner');
  }
  if (input.newOwner === input.tenant.owner) {
    return llmSellerFailure('owner_already_owner');
  }
  if (
    input.memberships.some(
      (membership) => !isSellerMembership(membership) || membership.tenantId !== input.tenant.id,
    )
  ) {
    return llmSellerFailure('inconsistent_context');
  }
  const newOwnerMemberships = input.memberships.filter(
    (membership) => membership.actor === input.newOwner && isMembershipActive(membership),
  );
  if (newOwnerMemberships.length === 0) {
    return llmSellerFailure('new_owner_not_active_member');
  }
  const previousOwner = input.tenant.owner;
  const previousOwnerMemberships = input.memberships.filter(
    (membership) => membership.actor === previousOwner && isMembershipActive(membership),
  );
  if (newOwnerMemberships.length > 1 || previousOwnerMemberships.length > 1) {
    // Cùng lý do `membership_ambiguous` ở authorization: adapter đúng với
    // partial unique index không tạo ra trường hợp này, nhưng transfer không
    // được biến dữ liệu hỏng thành owner không dùng được grant nào.
    return llmSellerFailure('ambiguous_context');
  }
  const previousOwnerMembership = previousOwnerMemberships[0];

  let memberships: readonly SellerMembership[] = Object.freeze([...input.memberships]);
  if (previousOwnerMembership === undefined) {
    if (!isMembershipId(input.formerOwnerMembershipId)) {
      return llmSellerFailure('missing_former_owner_membership');
    }
    if (input.memberships.some((membership) => membership.id === input.formerOwnerMembershipId)) {
      return llmSellerFailure('duplicate_membership_id');
    }
    const provisionInput: ProvisionMembershipInput = {
      id: input.formerOwnerMembershipId,
      tenantId: input.tenant.id,
      actor: previousOwner,
      createdAt: input.transferredAt,
    };
    const provisioned = provisionMembership(provisionInput, input.memberships);
    if (!provisioned.ok) {
      return provisioned;
    }
    memberships = Object.freeze([...input.memberships, provisioned.value]);
  }

  return llmSellerOk(
    Object.freeze({
      tenant: Object.freeze({ ...input.tenant, owner: input.newOwner }),
      memberships,
      previousOwner,
      newOwner: input.newOwner,
      transferredAt: input.transferredAt,
    }),
  );
}
