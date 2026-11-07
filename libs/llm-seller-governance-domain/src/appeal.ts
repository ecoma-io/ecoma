/**
 * Appeal của một restriction record.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §1, §3.2, §3.7;
 * ADR-0004.
 *
 * Nguyên tắc:
 * - Appeal là entity riêng, trỏ đúng **một** restriction record.
 * - Quyết định appeal **không** tự lift restriction; caller phải gọi
 *   `liftRestriction` riêng.
 * - Không có deadline mặc định: khi record không có `appealDeadline`, domain
 *   không áp một hạn nào. Đó là chính sách chưa chốt.
 * - `decisionReason` là lý do nội bộ; `publicDecisionReason` là lý do được công
 *   bố. Chỉ lớp công khai ra public projection.
 */

import {
  isAppealId,
  isEpochMillis,
  isRestrictionId,
  isSellerActorId,
  isSellerTenantId,
  isSellerText,
  llmGovernanceFailure,
  llmGovernanceOk,
  type AppealId,
  type LlmGovernanceResult,
  type RestrictionId,
  type SellerActorId,
  type SellerTenantId,
} from './shared';
import { isRestrictionEffective, isRestrictionRecord, type RestrictionRecord } from './restriction';
import {
  isGovernanceMembershipActive,
  isGovernanceMembershipRef,
  isGovernanceTenantRef,
  type GovernanceMembershipRef,
  type GovernanceTenantRef,
} from './tenant-ref';

/** Trạng thái appeal. `accepted`/`rejected`/`withdrawn` là terminal. */
export type AppealStatus = 'submitted' | 'under_review' | 'accepted' | 'rejected' | 'withdrawn';

/** Quyết định của reviewer. */
export type AppealDecision = 'accepted' | 'rejected';

/** Một appeal. */
export interface Appeal {
  readonly id: AppealId;
  readonly tenantId: SellerTenantId;
  readonly restrictionId: RestrictionId;
  readonly submittedBy: SellerActorId;
  readonly submittedAt: number;
  readonly status: AppealStatus;
  readonly reviewedAt: number | null;
  readonly reviewedBy: SellerActorId | null;
  readonly decidedAt: number | null;
  readonly decidedBy: SellerActorId | null;
  /** Lý do nội bộ của quyết định — không ra public projection. */
  readonly decisionReason: string | null;
  /** Lý do công bố của quyết định — được ra public projection. */
  readonly publicDecisionReason: string | null;
  readonly withdrawnAt: number | null;
}

/** Input submit appeal. */
export interface SubmitAppealInput {
  readonly id: unknown;
  readonly restriction: RestrictionRecord;
  readonly tenant: GovernanceTenantRef;
  readonly memberships: readonly GovernanceMembershipRef[];
  readonly submittedBy: unknown;
  readonly submittedAt: unknown;
  /** Appeal đã có của tenant — dùng cho guard trùng `id`. */
  readonly existing?: readonly Appeal[];
}

/**
 * Seller nộp appeal cho một restriction.
 *
 * Guard, theo thứ tự:
 * 1. `id`, `submittedBy`, `submittedAt` đọc được.
 * 2. Restriction thuộc đúng tenant (`restriction_not_in_tenant`).
 * 3. Restriction chưa lift (`restriction_already_lifted`) — kể cả khi
 *    `liftedAt` ở tương lai, vì record đó đã có quyết định lift.
 * 4. Restriction đang hiệu lực tại `submittedAt` (`restriction_not_effective`).
 * 5. Nếu có `appealDeadline`: `submittedAt <= appealDeadline` (biên inclusive).
 * 6. Actor là owner hoặc có membership `active` của tenant
 *    (`appeal_actor_not_eligible`).
 * 7. `id` chưa tồn tại trong tenant (`duplicate_appeal_id`); mọi phần tử của
 *    `existing` phải thuộc đúng tenant.
 */
export function submitAppeal(input: SubmitAppealInput): LlmGovernanceResult<Appeal> {
  if (!isAppealId(input.id)) {
    return llmGovernanceFailure('invalid_appeal_id');
  }
  if (!isSellerActorId(input.submittedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.submittedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!isRestrictionRecord(input.restriction)) {
    return llmGovernanceFailure('invalid_restriction_record');
  }
  if (!isGovernanceTenantRef(input.tenant)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (input.restriction.tenantId !== input.tenant.id) {
    return llmGovernanceFailure('restriction_not_in_tenant');
  }
  if (input.restriction.liftedAt !== null) {
    return llmGovernanceFailure('restriction_already_lifted');
  }
  if (!isRestrictionEffective(input.restriction, input.submittedAt)) {
    return llmGovernanceFailure('restriction_not_effective');
  }
  if (
    input.restriction.appealDeadline !== null &&
    input.submittedAt > input.restriction.appealDeadline
  ) {
    return llmGovernanceFailure('appeal_deadline_passed');
  }
  if (!isAppealEligibleActor(input.tenant, input.memberships, input.submittedBy)) {
    return llmGovernanceFailure('appeal_actor_not_eligible');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!existing.every(isAppeal)) {
    return llmGovernanceFailure('invalid_appeal_record');
  }
  if (existing.some((appeal) => appeal.tenantId !== input.tenant.id)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (existing.some((appeal) => appeal.id === input.id)) {
    return llmGovernanceFailure('duplicate_appeal_id');
  }
  return llmGovernanceOk(
    Object.freeze({
      id: input.id,
      tenantId: input.tenant.id,
      restrictionId: input.restriction.id,
      submittedBy: input.submittedBy,
      submittedAt: input.submittedAt,
      status: 'submitted' as const,
      reviewedAt: null,
      reviewedBy: null,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      publicDecisionReason: null,
      withdrawnAt: null,
    }),
  );
}

/** Input bắt đầu xem xét appeal. */
export interface StartAppealReviewInput {
  readonly appeal: Appeal;
  readonly reviewer: unknown;
  readonly reviewedAt: unknown;
}

/** `submitted → under_review`. */
export function startAppealReview(input: StartAppealReviewInput): LlmGovernanceResult<Appeal> {
  if (!isAppeal(input.appeal)) {
    return llmGovernanceFailure('invalid_appeal_record');
  }
  if (!isSellerActorId(input.reviewer)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.reviewedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (input.appeal.status !== 'submitted') {
    return llmGovernanceFailure('invalid_appeal_transition');
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.appeal,
      status: 'under_review' as const,
      reviewedAt: input.reviewedAt,
      reviewedBy: input.reviewer,
    }),
  );
}

/** Input quyết định appeal. */
export interface DecideAppealInput {
  readonly appeal: Appeal;
  readonly decision: unknown;
  readonly decidedBy: unknown;
  readonly decidedAt: unknown;
  readonly decisionReason?: unknown;
  readonly publicDecisionReason?: unknown;
}

/**
 * `under_review → accepted | rejected`.
 *
 * `rejected` bắt buộc `publicDecisionReason`: Seller phải biết lý do bị từ chối.
 * `accepted` không bắt buộc, vì không có gì bị từ chối để giải thích.
 *
 * Domain **không** kiểm tra thẩm quyền của reviewer — việc đó thuộc application
 * layer (ADR-0004). Domain chỉ bảo đảm có actor đã xác thực.
 */
export function decideAppeal(input: DecideAppealInput): LlmGovernanceResult<Appeal> {
  if (!isAppeal(input.appeal)) {
    return llmGovernanceFailure('invalid_appeal_record');
  }
  if (!isSellerActorId(input.decidedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.decidedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (input.decision !== 'accepted' && input.decision !== 'rejected') {
    return llmGovernanceFailure('invalid_decision');
  }
  if (input.appeal.status !== 'under_review') {
    return llmGovernanceFailure('invalid_appeal_transition');
  }
  const publicDecisionReason = readOptionalText(input.publicDecisionReason);
  const decisionReason = readOptionalText(input.decisionReason);
  if (publicDecisionReason === undefined || decisionReason === undefined) {
    return llmGovernanceFailure('invalid_decision_reason');
  }
  if (input.decision === 'rejected' && publicDecisionReason === null) {
    return llmGovernanceFailure('missing_public_decision_reason');
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.appeal,
      status: input.decision,
      decidedAt: input.decidedAt,
      decidedBy: input.decidedBy,
      decisionReason,
      publicDecisionReason,
    }),
  );
}

/** Input rút appeal. */
export interface WithdrawAppealInput {
  readonly appeal: Appeal;
  readonly withdrawnAt: unknown;
}

/** `submitted | under_review → withdrawn`. */
export function withdrawAppeal(input: WithdrawAppealInput): LlmGovernanceResult<Appeal> {
  if (!isAppeal(input.appeal)) {
    return llmGovernanceFailure('invalid_appeal_record');
  }
  if (!isEpochMillis(input.withdrawnAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (input.appeal.status !== 'submitted' && input.appeal.status !== 'under_review') {
    return llmGovernanceFailure('invalid_appeal_transition');
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.appeal,
      status: 'withdrawn' as const,
      withdrawnAt: input.withdrawnAt,
    }),
  );
}

/**
 * Appeal ở dạng Seller được đọc.
 *
 * Không có `decisionReason`. Đây là kiểu duy nhất được phép ra public
 * API/contract/event.
 */
export interface PublicAppeal {
  readonly id: AppealId;
  readonly tenantId: SellerTenantId;
  readonly restrictionId: RestrictionId;
  readonly submittedBy: SellerActorId;
  readonly submittedAt: number;
  readonly status: AppealStatus;
  readonly decidedAt: number | null;
  readonly publicDecisionReason: string | null;
  readonly withdrawnAt: number | null;
}

/**
 * Chiếu appeal sang public projection.
 *
 * Field được liệt kê tường minh, không spread: `decisionReason`, `reviewedBy`
 * và `decidedBy` là nội bộ.
 */
export function toPublicAppeal(appeal: Appeal): PublicAppeal {
  return Object.freeze({
    id: appeal.id,
    tenantId: appeal.tenantId,
    restrictionId: appeal.restrictionId,
    submittedBy: appeal.submittedBy,
    submittedAt: appeal.submittedAt,
    status: appeal.status,
    decidedAt: appeal.decidedAt,
    publicDecisionReason: appeal.publicDecisionReason,
    withdrawnAt: appeal.withdrawnAt,
  });
}

/**
 * Shape guard cho appeal đọc từ storage.
 *
 * Adapter phải gọi trước khi dùng dữ liệu cho transition/audit.
 */
export function isAppeal(value: unknown): value is Appeal {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof Appeal, unknown>>;
  if (!isAppealId(candidate.id) || !isSellerTenantId(candidate.tenantId)) {
    return false;
  }
  if (!isRestrictionId(candidate.restrictionId) || !isSellerActorId(candidate.submittedBy)) {
    return false;
  }
  if (!isEpochMillis(candidate.submittedAt) || !isAppealStatus(candidate.status)) {
    return false;
  }
  if (
    !isNullableActor(candidate.reviewedBy) ||
    !isNullableActor(candidate.decidedBy) ||
    !isNullableTimestamp(candidate.reviewedAt) ||
    !isNullableTimestamp(candidate.decidedAt) ||
    !isNullableTimestamp(candidate.withdrawnAt)
  ) {
    return false;
  }
  return isNullableText(candidate.decisionReason) && isNullableText(candidate.publicDecisionReason);
}

/** Actor là owner hoặc member `active` của tenant. */
function isAppealEligibleActor(
  tenant: GovernanceTenantRef,
  memberships: readonly GovernanceMembershipRef[],
  actor: SellerActorId,
): boolean {
  if (tenant.owner === actor) {
    return true;
  }
  if (!Array.isArray(memberships)) {
    return false;
  }
  return memberships.some(
    (membership) =>
      isGovernanceMembershipRef(membership) &&
      membership.tenantId === tenant.id &&
      membership.actor === actor &&
      isGovernanceMembershipActive(membership),
  );
}

function readOptionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return isSellerText(value) ? value : undefined;
}

function isNullableText(value: unknown): value is string | null {
  return value === null || isSellerText(value);
}

function isNullableActor(value: unknown): value is SellerActorId | null {
  return value === null || isSellerActorId(value);
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isEpochMillis(value);
}

function isAppealStatus(value: unknown): value is AppealStatus {
  return (
    value === 'submitted' ||
    value === 'under_review' ||
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'withdrawn'
  );
}
