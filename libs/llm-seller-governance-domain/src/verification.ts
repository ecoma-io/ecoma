/**
 * Verification case và onboarding của Seller tenant.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §1, §3.3;
 * ADR-0002, ADR-0006.
 *
 * Ranh giới quan trọng: verification **không** tạo, không xoá và không đổi
 * trạng thái tồn tại của Seller tenant. Tenant tồn tại và operational-active
 * ngay từ `createSellerTenant`; verification chỉ là một trong các nguồn của
 * operational eligibility **suy ra**.
 *
 * Trạng thái case: `draft | submitted | under_review | approved | rejected |
 * expired`. `rejected → submitted` là resubmission và giữ toàn bộ submission cũ.
 */

import {
  isEpochMillis,
  isOpaqueLabel,
  isSellerActorId,
  isSellerTenantId,
  isSellerText,
  isVerificationCaseId,
  llmGovernanceFailure,
  llmGovernanceOk,
  type LlmGovernanceResult,
  type SellerActorId,
  type SellerTenantId,
  type VerificationCaseId,
} from './shared';
import { isEvidenceReference, type EvidenceReference } from './evidence';
import { isRestrictionEvaluation, type RestrictionEvaluation } from './restriction';
import {
  isLegalProfileVersion,
  legalProfileVersionAt,
  type LegalProfileVersion,
} from './legal-profile';
import { isTaxProfileVersion, taxProfileVersionAt, type TaxProfileVersion } from './tax-profile';

/** Trạng thái verification case. `expired` là terminal. */
export type VerificationStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'expired';

/** Một lần nộp hồ sơ — bất biến sau khi tạo. */
export interface VerificationSubmission {
  readonly id: string;
  readonly caseId: VerificationCaseId;
  readonly tenantId: SellerTenantId;
  readonly evidenceIds: readonly string[];
  readonly submittedBy: SellerActorId;
  readonly submittedAt: number;
}

/** Một verification case. */
export interface VerificationCase {
  readonly id: VerificationCaseId;
  readonly tenantId: SellerTenantId;
  /** Loại verification (`business`, `identity`, ...) — opaque label. */
  readonly type: string;
  readonly status: VerificationStatus;
  readonly createdAt: number;
  readonly submissions: readonly VerificationSubmission[];
  readonly submittedAt: number | null;
  readonly reviewedAt: number | null;
  readonly reviewedBy: SellerActorId | null;
  readonly decidedAt: number | null;
  readonly decidedBy: SellerActorId | null;
  /** Chỉ có sau `expireVerificationCase`. */
  readonly expiresAt: number | null;
  readonly expiredAt: number | null;
  /** Lý do công bố của quyết định — được ra public projection. */
  readonly publicDecisionReason: string | null;
}

/** Input tạo verification case. */
export interface CreateVerificationCaseInput {
  readonly id: unknown;
  readonly tenantId: unknown;
  readonly type: unknown;
  readonly createdAt: unknown;
  /** Case đã có của tenant — dùng cho guard trùng `id`. */
  readonly existing?: readonly VerificationCase[];
}

/** Tạo verification case ở trạng thái `draft`. Không đụng tới tenant. */
export function createVerificationCase(
  input: CreateVerificationCaseInput,
): LlmGovernanceResult<VerificationCase> {
  if (!isVerificationCaseId(input.id)) {
    return llmGovernanceFailure('invalid_verification_case_id');
  }
  if (!isSellerTenantId(input.tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (!isOpaqueLabel(input.type)) {
    return llmGovernanceFailure('invalid_verification_type');
  }
  if (!isEpochMillis(input.createdAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!existing.every(isVerificationCase)) {
    return llmGovernanceFailure('invalid_verification_case');
  }
  if (existing.some((testCase) => testCase.tenantId !== input.tenantId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (existing.some((testCase) => testCase.id === input.id)) {
    return llmGovernanceFailure('duplicate_verification_case_id');
  }
  return llmGovernanceOk(
    Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      type: input.type,
      status: 'draft' as const,
      createdAt: input.createdAt,
      submissions: Object.freeze([]) as readonly VerificationSubmission[],
      submittedAt: null,
      reviewedAt: null,
      reviewedBy: null,
      decidedAt: null,
      decidedBy: null,
      expiresAt: null,
      expiredAt: null,
      publicDecisionReason: null,
    }),
  );
}

/** Input nộp hồ sơ. */
export interface SubmitVerificationCaseInput {
  readonly verificationCase: VerificationCase;
  readonly submissionId: unknown;
  readonly evidence: readonly EvidenceReference[];
  readonly submittedBy: unknown;
  readonly submittedAt: unknown;
}

/**
 * Nộp hồ sơ, hoặc nộp lại sau khi bị từ chối.
 *
 * Guard:
 * - `submissionId`, `submittedBy`, `submittedAt` đọc được.
 * - Transition hợp lệ: chỉ `draft | rejected → submitted`.
 * - Có ít nhất một evidence, không trùng trong cùng lần nộp, và **mọi** evidence
 *   thuộc đúng tenant của case.
 * - `submissionId` chưa xuất hiện trong case.
 *
 * Reset `decidedAt`/`decidedBy`/`publicDecisionReason` cho vòng xét mới; quyết
 * định cũ vẫn còn trong audit append-only do adapter giữ (ADR-0008).
 */
export function submitVerificationCase(
  input: SubmitVerificationCaseInput,
): LlmGovernanceResult<VerificationCase> {
  if (!isSellerText(input.submissionId)) {
    return llmGovernanceFailure('invalid_submission_id');
  }
  if (!isSellerActorId(input.submittedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.submittedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  const verificationCase = input.verificationCase;
  if (!isVerificationCase(verificationCase)) {
    return llmGovernanceFailure('invalid_verification_case');
  }
  if (verificationCase.status !== 'draft' && verificationCase.status !== 'rejected') {
    return llmGovernanceFailure('invalid_verification_transition');
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    return llmGovernanceFailure('evidence_missing');
  }
  if (!input.evidence.every(isEvidenceReference)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (input.evidence.some((evidence) => evidence.tenantId !== verificationCase.tenantId)) {
    return llmGovernanceFailure('evidence_not_in_tenant');
  }
  const evidenceIds = input.evidence.map((evidence) => evidence.id);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    return llmGovernanceFailure('duplicate_evidence');
  }
  if (verificationCase.submissions.some((submission) => submission.id === input.submissionId)) {
    return llmGovernanceFailure('duplicate_submission_id');
  }
  const submission: VerificationSubmission = Object.freeze({
    id: input.submissionId,
    caseId: verificationCase.id,
    tenantId: verificationCase.tenantId,
    evidenceIds: Object.freeze(evidenceIds),
    submittedBy: input.submittedBy,
    submittedAt: input.submittedAt,
  });
  return llmGovernanceOk(
    Object.freeze({
      ...verificationCase,
      status: 'submitted' as const,
      submissions: Object.freeze([...verificationCase.submissions, submission]),
      submittedAt: input.submittedAt,
      reviewedAt: null,
      reviewedBy: null,
      decidedAt: null,
      decidedBy: null,
      publicDecisionReason: null,
    }),
  );
}

/** Input bắt đầu xét hồ sơ. */
export interface StartVerificationReviewInput {
  readonly verificationCase: VerificationCase;
  readonly reviewer: unknown;
  readonly reviewedAt: unknown;
}

/** `submitted → under_review`. */
export function startVerificationReview(
  input: StartVerificationReviewInput,
): LlmGovernanceResult<VerificationCase> {
  if (!isVerificationCase(input.verificationCase)) {
    return llmGovernanceFailure('invalid_verification_case');
  }
  if (!isSellerActorId(input.reviewer)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.reviewedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (input.verificationCase.status !== 'submitted') {
    return llmGovernanceFailure('invalid_verification_transition');
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.verificationCase,
      status: 'under_review' as const,
      reviewedAt: input.reviewedAt,
      reviewedBy: input.reviewer,
    }),
  );
}

/** Input quyết định hồ sơ. */
export interface DecideVerificationInput {
  readonly verificationCase: VerificationCase;
  readonly decision: unknown;
  readonly decidedBy: unknown;
  readonly decidedAt: unknown;
  readonly publicDecisionReason?: unknown;
}

/**
 * `under_review → approved | rejected`.
 *
 * `rejected` bắt buộc `publicDecisionReason`. Domain không kiểm tra thẩm quyền
 * reviewer — đó là việc của application layer.
 */
export function decideVerification(
  input: DecideVerificationInput,
): LlmGovernanceResult<VerificationCase> {
  if (!isVerificationCase(input.verificationCase)) {
    return llmGovernanceFailure('invalid_verification_case');
  }
  if (!isSellerActorId(input.decidedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.decidedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (input.decision !== 'approved' && input.decision !== 'rejected') {
    return llmGovernanceFailure('invalid_decision');
  }
  if (input.verificationCase.status !== 'under_review') {
    return llmGovernanceFailure('invalid_verification_transition');
  }
  const publicDecisionReason =
    input.publicDecisionReason === undefined || input.publicDecisionReason === null
      ? null
      : input.publicDecisionReason;
  if (publicDecisionReason !== null && !isSellerText(publicDecisionReason)) {
    return llmGovernanceFailure('invalid_decision_reason');
  }
  if (input.decision === 'rejected' && publicDecisionReason === null) {
    return llmGovernanceFailure('missing_public_decision_reason');
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.verificationCase,
      status: input.decision,
      decidedAt: input.decidedAt,
      decidedBy: input.decidedBy,
      publicDecisionReason,
    }),
  );
}

/** Input đánh dấu hết hạn. */
export interface ExpireVerificationCaseInput {
  readonly verificationCase: VerificationCase;
  readonly expiresAt: unknown;
  readonly expiredAt: unknown;
}

/**
 * `approved → expired`.
 *
 * `expiresAt` là mốc hết hạn, `expiredAt` là thời điểm ghi nhận. Guard:
 * `expiresAt > decidedAt`, `expiredAt >= expiresAt`. Chỉ áp dụng cho case đã
 * `approved`; `expired` là terminal.
 */
export function expireVerificationCase(
  input: ExpireVerificationCaseInput,
): LlmGovernanceResult<VerificationCase> {
  if (!isEpochMillis(input.expiresAt) || !isEpochMillis(input.expiredAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  const verificationCase = input.verificationCase;
  if (!isVerificationCase(verificationCase)) {
    return llmGovernanceFailure('invalid_verification_case');
  }
  if (verificationCase.status !== 'approved' || verificationCase.decidedAt === null) {
    return llmGovernanceFailure('invalid_verification_transition');
  }
  if (input.expiresAt <= verificationCase.decidedAt || input.expiredAt < input.expiresAt) {
    return llmGovernanceFailure('invalid_verification_transition');
  }
  return llmGovernanceOk(
    Object.freeze({
      ...verificationCase,
      status: 'expired' as const,
      expiresAt: input.expiresAt,
      expiredAt: input.expiredAt,
    }),
  );
}

/** Trạng thái onboarding suy ra từ tập case. */
export interface OnboardingState {
  /** Mọi `type` bắt buộc đều có ít nhất một case `approved`. */
  readonly complete: boolean;
  /** Các `type` bắt buộc chưa có case `approved`. */
  readonly pendingTypes: readonly string[];
  /** `type` bắt buộc có case gần nhất `rejected`. */
  readonly issues: readonly string[];
}

/** Input suy ra onboarding state. */
export interface DeriveOnboardingStateInput {
  readonly tenantId: unknown;
  readonly cases: readonly VerificationCase[];
  readonly requiredTypes: readonly string[];
}

/**
 * Suy ra trạng thái onboarding.
 *
 * Không lưu kết quả: đây là hàm của `(cases, requiredTypes)`. Case lệch tenant
 * bị từ chối nguyên khối.
 */
export function deriveOnboardingState(
  input: DeriveOnboardingStateInput,
): LlmGovernanceResult<OnboardingState> {
  if (!isSellerTenantId(input.tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (!Array.isArray(input.cases) || !Array.isArray(input.requiredTypes)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!input.requiredTypes.every(isOpaqueLabel)) {
    return llmGovernanceFailure('invalid_profile_field');
  }
  if (!input.cases.every(isVerificationCase)) {
    return llmGovernanceFailure('invalid_verification_case');
  }
  if (input.cases.some((testCase) => testCase.tenantId !== input.tenantId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  const pendingTypes: string[] = [];
  const issues: string[] = [];
  for (const type of input.requiredTypes) {
    const casesOfType = input.cases.filter((testCase) => testCase.type === type);
    if (casesOfType.some((testCase) => testCase.status === 'approved')) {
      continue;
    }
    pendingTypes.push(type);
    // `issues` phản ánh vòng xét gần nhất: Seller đã resubmit sau reject thì
    // không còn mang issue của lần nộp cũ.
    if (latestCase(casesOfType)?.status === 'rejected') {
      issues.push(type);
    }
  }
  return llmGovernanceOk(
    Object.freeze({
      complete: pendingTypes.length === 0,
      pendingTypes: Object.freeze(pendingTypes),
      issues: Object.freeze(issues),
    }),
  );
}

/** Nguồn chặn operational eligibility. */
export type EligibilityBlocker = 'restriction' | 'verification' | 'legal_profile' | 'tax_profile';

/** Kết quả operational eligibility suy ra. */
export interface OperationalEligibility {
  readonly eligible: boolean;
  readonly blockers: readonly EligibilityBlocker[];
}

/** Input suy ra operational eligibility. */
export interface DeriveOperationalEligibilityInput {
  readonly tenantId: unknown;
  /**
   * Kết quả `evaluateRestrictions` cho target tenant. `undefined` mang nghĩa
   * "chưa đánh giá" và luôn chặn — không có đường nào bỏ qua restriction.
   */
  readonly restrictions: RestrictionEvaluation | undefined;
  readonly cases: readonly VerificationCase[];
  readonly requiredTypes: readonly string[];
  readonly legalProfileVersions: readonly LegalProfileVersion[];
  readonly taxProfileVersions: readonly TaxProfileVersion[];
  readonly now: unknown;
}

/**
 * Suy ra operational eligibility của Seller tenant tại `now`.
 *
 * Eligible khi **tất cả**:
 * - restriction không `blocked` **và** không `unevaluable` (fail closed);
 * - onboarding complete (mọi `type` bắt buộc có case `approved`);
 * - có legal profile version hiệu lực tại `now`;
 * - có tax profile version hiệu lực tại `now`.
 *
 * Không lưu kết quả thành status trên tenant (ADR-0002).
 */
export function deriveOperationalEligibility(
  input: DeriveOperationalEligibilityInput,
): LlmGovernanceResult<OperationalEligibility> {
  if (!isSellerTenantId(input.tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (!isEpochMillis(input.now)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  const blockers: EligibilityBlocker[] = [];
  if (
    input.restrictions === undefined ||
    !isRestrictionEvaluation(input.restrictions) ||
    input.restrictions.tenantId !== input.tenantId ||
    input.restrictions.target.kind !== 'tenant' ||
    input.restrictions.blocked ||
    input.restrictions.unevaluable
  ) {
    // Evaluation thiếu, hỏng, của tenant khác, hoặc tính cho target khác không
    // chứng minh được tenant không bị chặn — fail closed.
    blockers.push('restriction');
  }
  const onboarding = deriveOnboardingState({
    tenantId: input.tenantId,
    cases: input.cases,
    requiredTypes: input.requiredTypes,
  });
  if (!onboarding.ok) {
    return onboarding;
  }
  if (!onboarding.value.complete) {
    blockers.push('verification');
  }
  if (!Array.isArray(input.legalProfileVersions)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!Array.isArray(input.taxProfileVersions)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!input.legalProfileVersions.every(isLegalProfileVersion)) {
    return llmGovernanceFailure('invalid_profile_version');
  }
  if (!input.taxProfileVersions.every(isTaxProfileVersion)) {
    return llmGovernanceFailure('invalid_profile_version');
  }
  if (input.legalProfileVersions.some((version) => version.tenantId !== input.tenantId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (input.taxProfileVersions.some((version) => version.tenantId !== input.tenantId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (legalProfileVersionAt(input.legalProfileVersions, input.now) === undefined) {
    blockers.push('legal_profile');
  }
  if (taxProfileVersionAt(input.taxProfileVersions, input.now) === undefined) {
    blockers.push('tax_profile');
  }
  return llmGovernanceOk(
    Object.freeze({ eligible: blockers.length === 0, blockers: Object.freeze(blockers) }),
  );
}

/**
 * Shape guard cho verification case đọc từ storage.
 *
 * Adapter phải gọi trước khi dùng case cho eligibility.
 */
export function isVerificationCase(value: unknown): value is VerificationCase {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof VerificationCase, unknown>>;
  if (!isVerificationCaseId(candidate.id) || !isSellerTenantId(candidate.tenantId)) {
    return false;
  }
  if (
    !isOpaqueLabel(candidate.type) ||
    !isVerificationStatus(candidate.status) ||
    !isEpochMillis(candidate.createdAt)
  ) {
    return false;
  }
  if (
    !Array.isArray(candidate.submissions) ||
    !candidate.submissions.every(isVerificationSubmission)
  ) {
    return false;
  }
  if (
    !isNullableTimestamp(candidate.submittedAt) ||
    !isNullableTimestamp(candidate.reviewedAt) ||
    !isNullableTimestamp(candidate.decidedAt) ||
    !isNullableTimestamp(candidate.expiresAt) ||
    !isNullableTimestamp(candidate.expiredAt)
  ) {
    return false;
  }
  if (
    !(candidate.reviewedBy === null || isSellerActorId(candidate.reviewedBy)) ||
    !(candidate.decidedBy === null || isSellerActorId(candidate.decidedBy)) ||
    !(candidate.publicDecisionReason === null || isSellerText(candidate.publicDecisionReason))
  ) {
    return false;
  }
  return candidate.submissions.every(
    (submission) =>
      submission.tenantId === candidate.tenantId && submission.caseId === candidate.id,
  );
}

function isVerificationSubmission(value: unknown): value is VerificationSubmission {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof VerificationSubmission, unknown>>;
  if (!isSellerText(candidate.id) || !isVerificationCaseId(candidate.caseId)) {
    return false;
  }
  if (!isSellerTenantId(candidate.tenantId) || !isSellerActorId(candidate.submittedBy)) {
    return false;
  }
  if (!isEpochMillis(candidate.submittedAt)) {
    return false;
  }
  return (
    Array.isArray(candidate.evidenceIds) &&
    candidate.evidenceIds.length > 0 &&
    candidate.evidenceIds.every(isSellerText)
  );
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return (
    value === 'draft' ||
    value === 'submitted' ||
    value === 'under_review' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'expired'
  );
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isEpochMillis(value);
}

/** Case mới nhất của một `type`: `createdAt` lớn nhất, hoà thì `id` lớn hơn. */
function latestCase(cases: readonly VerificationCase[]): VerificationCase | undefined {
  let latest: VerificationCase | undefined;
  for (const testCase of cases) {
    if (
      latest === undefined ||
      testCase.createdAt > latest.createdAt ||
      (testCase.createdAt === latest.createdAt && testCase.id > latest.id)
    ) {
      latest = testCase;
    }
  }
  return latest;
}
