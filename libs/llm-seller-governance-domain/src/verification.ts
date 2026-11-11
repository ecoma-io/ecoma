/**
 * Verification lifecycle và derivation của Seller tenant.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §3.3, §3.6, §3.8, §4, §7;
 * ADR-0002, ADR-0006, ADR-0027.
 *
 * Ranh giới quan trọng: verification **không** tạo, không xoá và không đổi
 * trạng thái tồn tại của Seller tenant. Tenant tồn tại và operational-active
 * ngay từ `createSellerTenant`; verification chỉ là một trong các nguồn của
 * operational eligibility **suy ra**.
 *
 * Hai subject, hai đường tách biệt (§3.3, §3.8):
 * - **Tenant-scoped** — case của Seller tenant trên đường customer; evidence
 *   qua `EvidenceReference` và `assertEvidenceInTenant`.
 * - **Principal-scoped** — case của `FirstPartyLegalPrincipal` first-party;
 *   evidence qua `PrincipalEvidenceReference` và `assertEvidenceInPrincipal`.
 *   Một case principal-scoped bị `submitVerificationCase` từ chối và một case
 *   tenant-scoped bị `submitPrincipalVerificationCase` từ chối — không có đường
 *   nào nộp nhầm evidence trục này cho case trục kia.
 *
 * Trạng thái case: `draft | submitted | under_review | approved | rejected |
 * expired`. `rejected → submitted` là resubmission và giữ toàn bộ submission cũ.
 *
 * `decideVerification` khi approved **pin** `verifiedProfileVersions` (§3.6):
 * version profile hiệu lực tại `decidedAt` trên trục của `type` (case
 * principal-scoped pin revision hiện hành của principal). Case principal-scoped
 * còn là nơi duy nhất chuyển principal `reverification_required → active`
 * (§7): approval phải khiến approved coverage phủ **cặp** revision hiện hành —
 * trục của case này pin tại quyết định, trục kia từ coverage do caller cấp;
 * principal `blocked` không bao giờ `active` lại qua approval (unblock trước).
 */

import {
  isEpochMillis,
  isOpaqueLabel,
  isSellerActorId,
  isSellerTenantId,
  isSellerText,
  llmGovernanceFailure,
  llmGovernanceOk,
  type LlmGovernanceResult,
  type SellerActorId,
} from './shared';
import {
  isEvidenceReference,
  isPrincipalEvidenceReference,
  type EvidenceReference,
  type PrincipalEvidenceReference,
} from './evidence';
import { isRestrictionEvaluation, type RestrictionEvaluation } from './restriction';
import {
  isLegalProfileVersion,
  legalProfileVersionAt,
  type LegalProfileVersion,
} from './legal-profile';
import { isTaxProfileVersion, taxProfileVersionAt, type TaxProfileVersion } from './tax-profile';
import {
  isFirstPartyLegalPrincipal,
  principalLegalProfileVersionAt,
  principalTaxProfileVersionAt,
  type FirstPartyLegalPrincipal,
} from './principal';
import { isPrincipalAssessment, type PrincipalAssessment } from './principal-association';
import {
  isVerificationCase,
  isVerificationProfileAxes,
  type VerificationCase,
  type VerificationProfileAxes,
  type VerificationSubmission,
  type VerifiedProfileVersionPin,
} from './verification-case';

export {
  createVerificationCase,
  isVerificationCase,
  isVerificationProfileAxes,
  type CreateVerificationCaseInput,
  type VerificationCase,
  type VerificationProfileAxes,
  type VerificationStatus,
  type VerificationSubmission,
  type VerifiedProfileVersionPin,
  type VerificationProfileAxisBinding,
} from './verification-case';

/** Input nộp hồ sơ cho case tenant-scoped. */
export interface SubmitVerificationCaseInput {
  readonly verificationCase: VerificationCase;
  readonly submissionId: unknown;
  readonly evidence: readonly EvidenceReference[];
  readonly submittedBy: unknown;
  readonly submittedAt: unknown;
}

/**
 * Nộp hồ sơ, hoặc nộp lại sau khi bị từ chối — **chỉ cho case tenant-scoped**.
 *
 * Guard:
 * - `submissionId`, `submittedBy`, `submittedAt` đọc được.
 * - Case có subject tenant; case principal-scoped ⇒ `inconsistent_context`
 *   (đường principal là `submitPrincipalVerificationCase`).
 * - Transition hợp lệ: chỉ `draft | rejected → submitted`.
 * - Có ít nhất một evidence, không trùng trong cùng lần nộp, và **mọi** evidence
 *   thuộc đúng tenant của case.
 * - `submissionId` chưa xuất hiện trong case.
 *
 * Reset `decidedAt`/`decidedBy`/`publicDecisionReason` và pin coverage cho vòng
 * xét mới; quyết định cũ vẫn còn trong audit append-only do adapter giữ
 * (ADR-0008).
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
  if (verificationCase.principalId !== null) {
    return llmGovernanceFailure('inconsistent_context');
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
    principalId: null,
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
      verifiedProfileVersions: Object.freeze([]) as readonly VerifiedProfileVersionPin[],
    }),
  );
}

/** Input nộp hồ sơ cho case principal-scoped. */
export interface SubmitPrincipalVerificationCaseInput {
  readonly verificationCase: VerificationCase;
  readonly submissionId: unknown;
  readonly evidence: readonly PrincipalEvidenceReference[];
  readonly submittedBy: unknown;
  readonly submittedAt: unknown;
}

/**
 * Nộp hồ sơ cho case principal-scoped (§3.8) — hoặc nộp lại sau khi bị từ chối.
 *
 * Evidence ở đây là `PrincipalEvidenceReference`: gắn `principalId`, trỏ tới
 * hồ sơ authoritative ngoài sản phẩm, **không** gắn Seller tenant. Mọi evidence
 * phải thuộc đúng principal của case (`inconsistent_context` khi lệch). Case
 * tenant-scoped ⇒ `inconsistent_context`.
 */
export function submitPrincipalVerificationCase(
  input: SubmitPrincipalVerificationCaseInput,
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
  if (verificationCase.principalId === null) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (verificationCase.status !== 'draft' && verificationCase.status !== 'rejected') {
    return llmGovernanceFailure('invalid_verification_transition');
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    return llmGovernanceFailure('evidence_missing');
  }
  if (!input.evidence.every(isPrincipalEvidenceReference)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (input.evidence.some((evidence) => evidence.principalId !== verificationCase.principalId)) {
    return llmGovernanceFailure('inconsistent_context');
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
    tenantId: null,
    principalId: verificationCase.principalId,
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
      verifiedProfileVersions: Object.freeze([]) as readonly VerifiedProfileVersionPin[],
    }),
  );
}

/** Input bắt đầu xét hồ sơ. */
export interface StartVerificationReviewInput {
  readonly verificationCase: VerificationCase;
  readonly reviewer: unknown;
  readonly reviewedAt: unknown;
}

/** `submitted → under_review` — cho case của cả hai subject. */
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

/** Coverage hiện có của các trục case đang quyết định không pin — do caller cấp. */
export interface PrincipalCoverageSnapshot {
  /** Version legal được approved case principal-scoped còn phủ; `null` khi chưa có. */
  readonly legal?: number | null;
  /** Version tax tương ứng. */
  readonly tax?: number | null;
}

/** Input quyết định hồ sơ. */
export interface DecideVerificationInput {
  readonly verificationCase: VerificationCase;
  readonly decision: unknown;
  readonly decidedBy: unknown;
  readonly decidedAt: unknown;
  readonly publicDecisionReason?: unknown;
  /** Ánh xạ cấu hình `type → trục profile` — quyết định case nào có pin coverage. */
  readonly profileAxes?: unknown;
  /** Bắt buộc khi case principal-scoped; record principal đang được xét. */
  readonly principal?: unknown;
  /**
   * Coverage hiện có của các trục case này không pin — chỉ đọc khi approval
   * principal-scoped để kết luận có phủ đủ cặp revision hiện hành hay không.
   */
  readonly principalCoverage?: unknown;
  /** Profile tenant — bắt buộc khi approval case tenant-scoped có type gắn trục. */
  readonly legalProfileVersions?: unknown;
  readonly taxProfileVersions?: unknown;
}

/** Kết quả `decideVerification`: case sau quyết định và principal liên quan. */
export interface VerificationDecision {
  readonly verificationCase: VerificationCase;
  /**
   * Principal sau approval (có thể vừa `active`) hoặc không đổi; `null` khi
   * quyết định không nằm trong ngữ cảnh principal (case tenant-scoped).
   */
  readonly legalPrincipal: FirstPartyLegalPrincipal | null;
}

/**
 * `under_review → approved | rejected`, kèm pin coverage và activation principal.
 *
 * `rejected` bắt buộc `publicDecisionReason`. Domain không kiểm tra thẩm quyền
 * reviewer — đó là việc của application layer (§8.3).
 *
 * Khi `approved` và `type` gắn trục profile (theo `profileAxes`), pin version
 * **hiệu lực tại `decidedAt`** trên trục đó (§3.6, §4):
 * - case tenant-scoped: version hiệu lực của profile tenant — cần truyền
 *   `legalProfileVersions`/`taxProfileVersions`; chưa có version hiệu lực ⇒
 *   `ambiguous_context` (không có gì để pin, fail-closed).
 * - case principal-scoped: revision hiện hành của principal tại `decidedAt` —
 *   cần truyền `principal`.
 *
 * Case principal-scoped `approved` còn là điều kiện `reverification_required →
 * active` (§7): chỉ khi principal đang `reverification_required` **và** approved
 * coverage (trục của case từ pin vừa ghi, trục kia từ `principalCoverage`) phủ
 * đúng revision hiện hành — khi đó principal `active` với audit là quyết định
 * này. Principal `blocked` không chuyển (unblock trước); principal `active`
 * giữ nguyên. Thiếu điều kiện nào ⇒ principal không đổi, case vẫn `approved`.
 */
export function decideVerification(
  input: DecideVerificationInput,
): LlmGovernanceResult<VerificationDecision> {
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
  const verificationCase = input.verificationCase;
  const approved = input.decision === 'approved';

  if (input.profileAxes !== undefined && !isVerificationProfileAxes(input.profileAxes)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  const axisBinding = input.profileAxes === undefined ? undefined : axisLookup(input.profileAxes);
  if (input.profileAxes !== undefined && axisBinding === undefined) {
    return llmGovernanceFailure('ambiguous_context');
  }
  const axis = axisBinding?.get(verificationCase.type);

  let principal: FirstPartyLegalPrincipal | null = null;
  if (verificationCase.principalId !== null) {
    if (!isFirstPartyLegalPrincipal(input.principal)) {
      return llmGovernanceFailure('ambiguous_context');
    }
    if (input.principal.principalId !== verificationCase.principalId) {
      return llmGovernanceFailure('inconsistent_context');
    }
    principal = input.principal;
  }

  let pins: readonly VerifiedProfileVersionPin[] = [];
  if (approved && axis !== undefined) {
    const pin = pinForDecision(verificationCase, axis, input.decidedAt, input, principal);
    if (!pin.ok) {
      return pin;
    }
    pins = [pin.value];
  }

  const decisionCase: VerificationCase = Object.freeze({
    ...verificationCase,
    status: input.decision,
    decidedAt: input.decidedAt,
    decidedBy: input.decidedBy,
    publicDecisionReason,
    verifiedProfileVersions: Object.freeze(pins),
  });

  let legalPrincipal: FirstPartyLegalPrincipal | null = principal;
  if (approved && principal !== null && axis !== undefined) {
    const activated = maybeActivatePrincipal(
      principal,
      axis,
      decisionCase,
      input.decidedAt,
      input.principalCoverage,
    );
    if (activated !== undefined) {
      legalPrincipal = Object.freeze({
        ...activated,
        // `maybeActivatePrincipal` trả record gốc khi điều kiện transition thoả —
        // trạng thái mới và audit của transition được ghi ở đây, tại operation
        // quyết định (§7: `reverification_required → active` qua approval).
        status: 'active' as const,
        statusChangedAt: input.decidedAt,
        statusChangedBy: input.decidedBy as SellerActorId,
      });
    }
  }

  return llmGovernanceOk(Object.freeze({ verificationCase: decisionCase, legalPrincipal }));
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
 *
 * Case principal-scoped `expired` làm mất coverage của trục nó pin (§3.8):
 * pin vẫn còn trên record, nhưng snapshot `approvedCoverage` do caller lắp cho
 * derivation không còn tính nó — eligibility fail-closed như mọi
 * loss-of-coverage khác. Trạng thái principal **không** đổi ở đây: §7 không có
 * transition `active → reverification_required` từ expiry, và derivation không
 * bao giờ suy coverage từ `status`.
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
  /** Mọi `type` bắt buộc đều có approval còn phủ version hiệu lực tại `now` (§3.6). */
  readonly complete: boolean;
  /** Các `type` bắt buộc chưa có approval còn phủ. */
  readonly pendingTypes: readonly string[];
  /** `type` bắt buộc có case gần nhất `rejected`. */
  readonly issues: readonly string[];
}

/** Phân đường tenant trong derivation (§3.6). */
export type TenantClassification = 'customer' | 'first_party';

/** Input suy ra onboarding state. */
export interface DeriveOnboardingStateInput {
  readonly tenantId: unknown;
  readonly cases: readonly VerificationCase[];
  readonly requiredTypes: readonly string[];
  readonly now: unknown;
  /** Ánh xạ cấu hình `type → trục profile` — bật coverage rule cho type được bind. */
  readonly profileAxes?: unknown;
  readonly legalProfileVersions?: unknown;
  readonly taxProfileVersions?: unknown;
  /** Phân đường tenant; vắng mặt là `customer`. */
  readonly tenantClassification?: unknown;
  /** Snapshot principal — bắt buộc khi `first_party`. */
  readonly principalAssessment?: unknown;
}

/**
 * Suy ra trạng thái onboarding.
 *
 * `complete` khi mọi `type` bắt buộc có **ít nhất một** case `approved` **còn
 * phủ** version profile hiệu lực tại `now` (§3.6 coverage rule):
 * - type gắn trục profile: approval chỉ được tính khi pin của nó khớp version
 *   hiệu lực tại `now` trên trục đó; thiếu pin hoặc lệch version ⇒ không tính.
 * - type không gắn trục: approval tính theo trạng thái, tới `expired` mới mất.
 *
 * Trên đường `first_party` (§3.8): coverage của type gắn trục tính trên
 * **revision hiện hành của principal** qua `principalAssessment`, không qua case
 * tenant-scoped; assessment thiếu hoặc sai shape ⇒ `ambiguous_context`.
 *
 * Không lưu kết quả: đây là hàm thuần của input. Case lệch subject bị từ chối
 * nguyên khối.
 */
export function deriveOnboardingState(
  input: DeriveOnboardingStateInput,
): LlmGovernanceResult<OnboardingState> {
  if (!isSellerTenantId(input.tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (!isEpochMillis(input.now)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  const classification =
    input.tenantClassification === undefined ? 'customer' : input.tenantClassification;
  if (classification !== 'customer' && classification !== 'first_party') {
    return llmGovernanceFailure('ambiguous_context');
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
  if (
    input.cases.some(
      (testCase) => testCase.tenantId !== input.tenantId || testCase.principalId !== null,
    )
  ) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (input.profileAxes !== undefined && !isVerificationProfileAxes(input.profileAxes)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  const axisBinding = input.profileAxes === undefined ? undefined : axisLookup(input.profileAxes);
  if (input.profileAxes !== undefined && axisBinding === undefined) {
    return llmGovernanceFailure('ambiguous_context');
  }
  let assessment: PrincipalAssessment | undefined;
  if (classification === 'first_party') {
    if (!isPrincipalAssessment(input.principalAssessment)) {
      return llmGovernanceFailure('ambiguous_context');
    }
    assessment = input.principalAssessment;
  }
  const profiles = validateTenantProfiles(
    input.tenantId,
    input.legalProfileVersions,
    input.taxProfileVersions,
  );
  if (!profiles.ok) {
    return profiles;
  }

  const pendingTypes: string[] = [];
  const issues: string[] = [];
  for (const type of input.requiredTypes) {
    const axis = axisBinding?.get(type);
    const casesOfType = input.cases.filter((testCase) => testCase.type === type);
    let covered: boolean;
    if (classification === 'first_party' && axis !== undefined) {
      covered = principalAxisCovered(assessment, axis, input.now);
    } else {
      const effectiveVersion = effectiveTenantVersion(profiles.value, axis, input.now);
      covered = casesOfType.some(
        (testCase) =>
          testCase.status === 'approved' &&
          (axis === undefined || pinCovers(testCase, axis, effectiveVersion)),
      );
    }
    if (!covered) {
      pendingTypes.push(type);
    }
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
  /** Phân đường tenant (§3.6): `customer` hoặc `first_party`. */
  readonly tenantClassification: unknown;
  /** Snapshot principal — bắt buộc khi `first_party`; phải vắng mặt khi `customer`. */
  readonly principalAssessment?: unknown;
  /**
   * Kết quả `evaluateRestrictions` cho target tenant. `undefined` mang nghĩa
   * "chưa đánh giá" và luôn chặn — không có đường nào bỏ qua restriction.
   */
  readonly restrictions: RestrictionEvaluation | undefined;
  readonly cases: readonly VerificationCase[];
  readonly requiredTypes: readonly string[];
  readonly now: unknown;
  readonly profileAxes?: unknown;
  readonly legalProfileVersions?: unknown;
  readonly taxProfileVersions?: unknown;
}

/**
 * Suy ra operational eligibility của Seller tenant tại `now`.
 *
 * **Đường customer** (§3.6): eligible khi restriction không chặn
 * (`blocked === false`, `unevaluable === false`, đúng tenant, target `tenant`),
 * onboarding complete (coverage rule cho type gắn trục), và có legal + tax
 * profile version hiệu lực tại `now`. `principalAssessment` phải vắng mặt —
 * có mặt ⇒ ineligible (blocker `verification`), không được bỏ qua.
 *
 * **Đường first_party** (§3.8, fail-closed): đường profile tenant bị **thay**
 * bằng principal-wide rule — không cộng:
 * - `principalAssessment` đủ và nhất quán, principal `active`;
 * - association tồn tại, trỏ đúng principal và đúng tenant;
 * - approved coverage còn phủ cặp revision hiện hành tại `now`;
 * - accepted revisions của association khớp cặp hiện hành;
 * - tenant **không** mang dữ liệu profile/case `legal-identity`/`tax`
 *   tenant-scoped (single source, §5 invariant 11).
 *
 * Thiếu, stale, blocked hay bất nhất ⇒ ineligible với blocker `verification`
 * (§3.6: mọi failure trên trục principal ánh vào `verification` — không có
 * blocker mới). Classification không bao giờ là nguồn exemption; một
 * case/approval cũ của tenant không bao giờ thỏa mãn revision mới của principal.
 *
 * Không lưu kết quả thành status (ADR-0002).
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
  if (input.tenantClassification !== 'customer' && input.tenantClassification !== 'first_party') {
    return llmGovernanceFailure('ambiguous_context');
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
  if (!Array.isArray(input.cases) || !Array.isArray(input.requiredTypes)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!input.requiredTypes.every(isOpaqueLabel)) {
    return llmGovernanceFailure('invalid_profile_field');
  }
  if (!input.cases.every(isVerificationCase)) {
    return llmGovernanceFailure('invalid_verification_case');
  }
  if (
    input.cases.some(
      (testCase) => testCase.tenantId !== input.tenantId || testCase.principalId !== null,
    )
  ) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (input.profileAxes !== undefined && !isVerificationProfileAxes(input.profileAxes)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  const axisBinding = input.profileAxes === undefined ? undefined : axisLookup(input.profileAxes);
  if (input.profileAxes !== undefined && axisBinding === undefined) {
    return llmGovernanceFailure('ambiguous_context');
  }
  const profiles = validateTenantProfiles(
    input.tenantId,
    input.legalProfileVersions,
    input.taxProfileVersions,
  );
  if (!profiles.ok) {
    return profiles;
  }

  if (input.tenantClassification === 'first_party') {
    // Single source (§3.4, §5 invariant 11): dữ liệu profile/case tenant-scoped
    // trên trục legal/tax là bất nhất ⇒ ineligible, không bao giờ derive từ nó.
    if (profiles.value.legal.length > 0 || profiles.value.tax.length > 0) {
      blockers.push('verification');
    }
    if (
      axisBinding !== undefined &&
      input.cases.some((testCase) => axisBinding.has(testCase.type))
    ) {
      blockers.push('verification');
    }
    if (!isPrincipalAssessment(input.principalAssessment)) {
      // Thiếu hoặc sai shape ⇒ không chứng minh được điều kiện nào — fail closed.
      blockers.push('verification');
      return eligibilityResult(blockers);
    }
    const assessment = input.principalAssessment;
    const { principal, association, approvedCoverage } = assessment;
    const currentLegal = principalLegalProfileVersionAt(principal, input.now);
    const currentTax = principalTaxProfileVersionAt(principal, input.now);
    const coverageOk =
      currentLegal !== undefined &&
      currentTax !== undefined &&
      approvedCoverage.legal === currentLegal.version &&
      approvedCoverage.tax === currentTax.version;
    const associationOk =
      association !== null &&
      currentLegal !== undefined &&
      currentTax !== undefined &&
      association.tenantId === input.tenantId &&
      association.principalId === principal.principalId &&
      association.acceptedLegalProfileVersion === currentLegal.version &&
      association.acceptedTaxProfileVersion === currentTax.version;
    const requiredCovered = input.requiredTypes.every((type) => {
      const axis = axisBinding?.get(type);
      if (axis === undefined) {
        // Type không gắn trục: tính trên case tenant-scoped như đường customer.
        return input.cases.some(
          (testCase) => testCase.type === type && testCase.status === 'approved',
        );
      }
      const currentVersion = axis === 'legal' ? currentLegal?.version : currentTax?.version;
      const coverageVersion = axis === 'legal' ? approvedCoverage.legal : approvedCoverage.tax;
      return currentVersion !== undefined && coverageVersion === currentVersion;
    });
    if (principal.status !== 'active' || !coverageOk || !associationOk || !requiredCovered) {
      blockers.push('verification');
    }
    return eligibilityResult(blockers);
  }

  if (input.principalAssessment !== undefined && input.principalAssessment !== null) {
    // Customer không có nguồn principal: assessment xuất hiện là đường tắt —
    // ineligible, không được bỏ qua (§3.6).
    blockers.push('verification');
  }
  const onboarding = deriveOnboardingState({
    tenantId: input.tenantId,
    cases: input.cases,
    requiredTypes: input.requiredTypes,
    now: input.now,
    profileAxes: input.profileAxes,
    legalProfileVersions: profiles.value.legal,
    taxProfileVersions: profiles.value.tax,
    tenantClassification: 'customer',
  });
  if (!onboarding.ok) {
    return onboarding;
  }
  if (!onboarding.value.complete) {
    blockers.push('verification');
  }
  if (legalProfileVersionAt(profiles.value.legal, input.now) === undefined) {
    blockers.push('legal_profile');
  }
  if (taxProfileVersionAt(profiles.value.tax, input.now) === undefined) {
    blockers.push('tax_profile');
  }
  return eligibilityResult(blockers);
}

// ---------------------------------------------------------------------------
// Nội bộ
// ---------------------------------------------------------------------------

type AxisLookup = Map<string, 'legal' | 'tax'>;

function axisLookup(axes: VerificationProfileAxes): AxisLookup | undefined {
  const lookup = new Map<string, 'legal' | 'tax'>();
  for (const binding of axes) {
    if (lookup.has(binding.type)) {
      // Một type bind hai trục là cấu hình mơ hồ — fail closed.
      return undefined;
    }
    lookup.set(binding.type, binding.axis);
  }
  return lookup;
}

/**
 * Pin coverage cho một approval, hoặc lỗi domain khi không có gì để pin:
 * thiếu profile/revision hiệu lực tại `decidedAt` hay thiếu snapshot liên quan
 * là ngữ cảnh mơ hồ của caller, không phải điều kiện eligibility.
 */
function pinForDecision(
  verificationCase: VerificationCase,
  axis: 'legal' | 'tax',
  decidedAt: number,
  input: DecideVerificationInput,
  principal: FirstPartyLegalPrincipal | null,
): LlmGovernanceResult<VerifiedProfileVersionPin> {
  if (principal !== null) {
    const current =
      axis === 'legal'
        ? principalLegalProfileVersionAt(principal, decidedAt)
        : principalTaxProfileVersionAt(principal, decidedAt);
    if (current === undefined) {
      return llmGovernanceFailure('ambiguous_context');
    }
    return llmGovernanceOk(Object.freeze({ axis, version: current.version }));
  }
  const profiles = validateTenantProfiles(
    verificationCase.tenantId,
    input.legalProfileVersions,
    input.taxProfileVersions,
  );
  if (!profiles.ok) {
    return profiles;
  }
  const current =
    axis === 'legal'
      ? legalProfileVersionAt(profiles.value.legal, decidedAt)
      : taxProfileVersionAt(profiles.value.tax, decidedAt);
  if (current === undefined) {
    return llmGovernanceFailure('ambiguous_context');
  }
  return llmGovernanceOk(Object.freeze({ axis, version: current.version }));
}

function maybeActivatePrincipal(
  principal: FirstPartyLegalPrincipal,
  axis: 'legal' | 'tax',
  decisionCase: VerificationCase,
  decidedAt: number,
  principalCoverage: unknown,
): FirstPartyLegalPrincipal | undefined {
  if (principal.status !== 'reverification_required') {
    // `blocked` không bao giờ `active` lại qua approval (unblock trước, §7);
    // `active` giữ nguyên.
    return undefined;
  }
  const pin = decisionCase.verifiedProfileVersions.find((candidate) => candidate.axis === axis);
  if (pin === undefined) {
    return undefined;
  }
  if (principalCoverage !== undefined && !isPrincipalCoverage(principalCoverage)) {
    return undefined;
  }
  const coverage: PrincipalCoverageSnapshot = principalCoverage ?? {};
  const currentLegal = principalLegalProfileVersionAt(principal, decidedAt);
  const currentTax = principalTaxProfileVersionAt(principal, decidedAt);
  if (currentLegal === undefined || currentTax === undefined) {
    return undefined;
  }
  const coveredLegal = axis === 'legal' ? pin.version : coverage.legal;
  const coveredTax = axis === 'tax' ? pin.version : coverage.tax;
  if (coveredLegal !== currentLegal.version || coveredTax !== currentTax.version) {
    // Approval này chưa làm coverage phủ đủ cặp revision hiện hành — principal
    // ở lại `reverification_required`, không lỗi.
    return undefined;
  }
  return principal;
}

function isVersionOrNullable(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)
  );
}

function isPrincipalCoverage(value: unknown): value is PrincipalCoverageSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof PrincipalCoverageSnapshot, unknown>>;
  return isVersionOrNullable(candidate.legal) && isVersionOrNullable(candidate.tax);
}

/** Bộ profile tenant đã qua guard shape — dùng nội bộ cho coverage rule. */
interface TenantProfiles {
  readonly legal: readonly LegalProfileVersion[];
  readonly tax: readonly TaxProfileVersion[];
}

function validateTenantProfiles(
  tenantId: unknown,
  legalProfileVersions: unknown,
  taxProfileVersions: unknown,
): LlmGovernanceResult<TenantProfiles> {
  const legal = legalProfileVersions ?? [];
  const tax = taxProfileVersions ?? [];
  if (!Array.isArray(legal) || !Array.isArray(tax)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!legal.every(isLegalProfileVersion) || !tax.every(isTaxProfileVersion)) {
    return llmGovernanceFailure('invalid_profile_version');
  }
  // Profile của tenant khác trộn vào collection là dữ liệu hỏng — không lọc
  // lặng lẽ mà từ chối nguyên khối.
  if (
    typeof tenantId === 'string' &&
    (legal.some((version) => version.tenantId !== tenantId) ||
      tax.some((version) => version.tenantId !== tenantId))
  ) {
    return llmGovernanceFailure('inconsistent_context');
  }
  return llmGovernanceOk({ legal, tax });
}

function principalAxisCovered(
  assessment: PrincipalAssessment | undefined,
  axis: 'legal' | 'tax',
  now: number,
): boolean {
  if (assessment === undefined) {
    return false;
  }
  const { principal, approvedCoverage } = assessment;
  const current =
    axis === 'legal'
      ? principalLegalProfileVersionAt(principal, now)
      : principalTaxProfileVersionAt(principal, now);
  const coverageVersion = axis === 'legal' ? approvedCoverage.legal : approvedCoverage.tax;
  return current !== undefined && coverageVersion === current.version;
}

function pinCovers(
  testCase: VerificationCase,
  axis: 'legal' | 'tax',
  effectiveVersion: number | undefined,
): boolean {
  if (effectiveVersion === undefined) {
    return false;
  }
  return testCase.verifiedProfileVersions.some(
    (pin) => pin.axis === axis && pin.version === effectiveVersion,
  );
}

function effectiveTenantVersion(
  profiles: TenantProfiles,
  axis: 'legal' | 'tax' | undefined,
  now: number,
): number | undefined {
  if (axis === undefined) {
    return undefined;
  }
  const current =
    axis === 'legal'
      ? legalProfileVersionAt(profiles.legal, now)
      : taxProfileVersionAt(profiles.tax, now);
  return current?.version;
}

function eligibilityResult(
  blockers: EligibilityBlocker[],
): LlmGovernanceResult<OperationalEligibility> {
  // Blocker là tập loại chặn, không phải danh sách sự kiện — cùng loại bị hai
  // guard chạm tới chỉ báo một lần.
  const unique = [...new Set(blockers)];
  return llmGovernanceOk(
    Object.freeze({ eligible: unique.length === 0, blockers: Object.freeze(unique) }),
  );
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
