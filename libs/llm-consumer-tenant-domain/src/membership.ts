/**
 * Membership — quan hệ giữa một account (`sub`) và một tenant.
 *
 * Source of truth: `docs/domains/llm-consumer-tenant/domain-model.md` §1, §1.
 *
 * Quy tắc:
 * - Provision **tường minh**; signup/login không tạo membership.
 * - Một actor có **tối đa một** membership `active` trên một tenant. Provision
 *   trùng actor khi đã có membership active bị từ chối, không âm thầm ghi đè.
 * - Revoke là terminal cho **bản ghi đó**: không có `revoked → active`. Cấp lại
 *   là một membership **mới** với `id` mới; bản ghi cũ nằm lại làm lịch sử.
 * - Mỗi membership có `id` riêng. Grant trỏ tới `id` này, nên quyền của một
 *   lần membership đã revoke **không** sống lại khi actor được provision lại —
 *   đây là lý do membership phải có danh tính, không chỉ `(tenant, actor)`.
 * - Owner là quan hệ riêng trên tenant (`./tenant.ts`), **không** phải một
 *   membership có "role owner": membership không mang role, chỉ nhận
 *   permission grant trực tiếp (`./grants.ts`).
 *
 * Một `sub` có thể là owner của nhiều tenant và là member của nhiều tenant
 * khác; mọi hàm ở đây làm việc trên **một** tập membership của **một** tenant,
 * nên membership tenant A không bao giờ được đọc như membership tenant B.
 */

import {
  isEpochMillis,
  isMembershipId,
  isTenantActorId,
  isTenantId,
  llmTenantFailure,
  llmTenantOk,
  type LlmTenantResult,
  type MembershipId,
  type TenantActorId,
  type TenantId,
} from './shared';

/** Trạng thái membership — chỉ hai nhãn, không có nhãn "pending" chưa chốt. */
export const LLM_TENANT_MEMBERSHIP_STATUS = {
  Active: 'active',
  Revoked: 'revoked',
} as const;

/** Union trạng thái membership. */
export type MembershipStatus =
  (typeof LLM_TENANT_MEMBERSHIP_STATUS)[keyof typeof LLM_TENANT_MEMBERSHIP_STATUS];

/** Danh sách trạng thái, thứ tự không mang ý nghĩa nghiệp vụ. */
export const LLM_TENANT_MEMBERSHIP_STATUSES = [
  LLM_TENANT_MEMBERSHIP_STATUS.Active,
  LLM_TENANT_MEMBERSHIP_STATUS.Revoked,
] as const;

/** Type guard cho `MembershipStatus` — dữ liệu đọc từ DB/contract qua hàm này. */
export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return (
    typeof value === 'string' &&
    (LLM_TENANT_MEMBERSHIP_STATUSES as readonly string[]).includes(value)
  );
}

/** Membership của một account trong một tenant. */
export interface Membership {
  /** Danh tính của **lần** membership này — grant trỏ tới đây. */
  readonly id: MembershipId;
  readonly tenantId: TenantId;
  readonly actor: TenantActorId;
  readonly status: MembershipStatus;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

/** Input provision membership — explicit, không có đường tự động. */
export interface ProvisionMembershipInput {
  readonly id: unknown;
  readonly tenantId: unknown;
  readonly actor: unknown;
  readonly createdAt: unknown;
}

/**
 * Provision một membership active.
 *
 * Từ chối khi:
 * - id/tenant/actor/timestamp không đọc được (`invalid_*`);
 * - một membership khác trong tập đã dùng cùng `id`
 *   (`duplicate_membership_id`);
 * - actor đã có membership **active** trên tenant (`membership_already_active`).
 *
 * Cho phép khi actor chỉ có membership **revoked**: lần provision này tạo một
 * membership **mới** với `id` khác. Grant cũ trỏ tới `id` cũ nên không được
 * tính cho lần membership mới — không có quyền nào sống lại.
 *
 * @param existing Các membership hiện có của **cùng tenant**. Caller chịu trách
 *   nhiệm chỉ truyền membership của tenant đang xét; hàm còn kiểm lại
 *   `tenantId` của từng phần tử và fail closed nếu lệch
 *   (`inconsistent_context`).
 */
export function provisionMembership(
  input: ProvisionMembershipInput,
  existing: readonly Membership[] = [],
): LlmTenantResult<Membership> {
  if (!isMembershipId(input.id)) {
    return llmTenantFailure('invalid_membership_id');
  }
  if (!isTenantId(input.tenantId)) {
    return llmTenantFailure('invalid_tenant_id');
  }
  if (!isTenantActorId(input.actor)) {
    return llmTenantFailure('invalid_actor');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmTenantFailure('invalid_timestamp');
  }
  if (existing.some((membership) => membership.tenantId !== input.tenantId)) {
    return llmTenantFailure('inconsistent_context');
  }
  if (existing.some((membership) => membership.id === input.id)) {
    return llmTenantFailure('duplicate_membership_id');
  }

  const activeForActor = existing.some(
    (membership) =>
      membership.actor === input.actor && membership.status === LLM_TENANT_MEMBERSHIP_STATUS.Active,
  );
  if (activeForActor) {
    return llmTenantFailure('membership_already_active');
  }

  return llmTenantOk(
    Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      actor: input.actor,
      status: LLM_TENANT_MEMBERSHIP_STATUS.Active,
      createdAt: input.createdAt,
      revokedAt: null,
    }),
  );
}

/** Input revoke membership. */
export interface RevokeMembershipInput {
  readonly membership: Membership;
  readonly revokedAt: unknown;
}

/**
 * Revoke một membership active. Idempotent-unsafe theo hướng fail closed:
 * revoke lần hai bị từ chối (`membership_already_revoked`) thay vì ghi lại
 * `revokedAt` mới.
 *
 * Revoke không xoá membership và không xoá grant — grant của actor trên tenant
 * vẫn tồn tại như dữ liệu audit, nhưng không còn authorize vì
 * {@link isMembershipActive} là điều kiện tiên quyết của mọi quyết định
 * authorization (`./authorization.ts`).
 */
export function revokeMembership(input: RevokeMembershipInput): LlmTenantResult<Membership> {
  if (!isEpochMillis(input.revokedAt)) {
    return llmTenantFailure('invalid_timestamp');
  }
  if (input.membership.status === LLM_TENANT_MEMBERSHIP_STATUS.Revoked) {
    return llmTenantFailure('membership_already_revoked');
  }
  if (input.revokedAt < input.membership.createdAt) {
    return llmTenantFailure('invalid_timestamp');
  }
  return llmTenantOk(
    Object.freeze({
      ...input.membership,
      status: LLM_TENANT_MEMBERSHIP_STATUS.Revoked,
      revokedAt: input.revokedAt,
    }),
  );
}

/** Kiểm tra membership còn hiệu lực authorization không. */
export function isMembershipActive(membership: Membership): boolean {
  return membership.status === LLM_TENANT_MEMBERSHIP_STATUS.Active;
}

/**
 * Tìm membership **active** của một actor trong **một** tenant.
 *
 * Chọn theo trạng thái active, không theo "bản ghi đầu tiên": tập có thể chứa
 * membership cũ đã revoke cùng actor. Trả `undefined` khi không có bản ghi
 * active — hướng fail closed. Nếu có nhiều hơn một bản ghi active (dữ liệu
 * hỏng), trả `undefined` thay vì chọn một cách tuỳ ý.
 */
export function findMembership(
  memberships: readonly Membership[],
  tenantId: TenantId,
  actor: TenantActorId,
): Membership | undefined {
  const active = memberships.filter(
    (membership) =>
      membership.tenantId === tenantId &&
      membership.actor === actor &&
      membership.status === LLM_TENANT_MEMBERSHIP_STATUS.Active,
  );
  return active.length === 1 ? active[0] : undefined;
}
