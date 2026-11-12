/**
 * Public surface của `@ecoma-io/llm-seller-governance-domain`.
 *
 * Library này là nửa **governance** của bounded context LLM Seller (ADR-0018):
 * restriction record + evaluation, appeal lifecycle, verification/onboarding,
 * legal/tax profile, evidence reference, `FirstPartyLegalPrincipal` + principal
 * association (ADR-0027) và operational eligibility suy ra.
 *
 * ## Ranh giới
 *
 * - **Thuần TypeScript.** Không database/ORM, không HTTP/network, không
 *   Cloudflare Workers API, không filesystem, không đọc clock, không randomness,
 *   không global mutable state. Mọi thời gian và định danh do caller cấp.
 * - **Phụ thuộc một chiều `llm-seller-tenant-domain`**, và chỉ cho
 *   identity/value primitive (`SellerTenantId`, `SellerActorId`,
 *   `MembershipId`, các guard tương ứng, `isEpochMillis`,
 *   `MAX_OPAQUE_ID_LENGTH`). Tenant không phụ thuộc ngược lại.
 * - Result type, error table và error code là **của riêng** governance:
 *   `LlmGovernanceResult`, `llmGovernanceOk`, `llmGovernanceFailure`,
 *   `LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES`. Không tái dùng mã lỗi tenant.
 * - **Governance là owner duy nhất của eligibility verdict.** Marketplace,
 *   Financial và Routing tiêu thụ kết luận (restriction/operational
 *   eligibility) như giá trị hợp đồng; chúng không đọc evidence pháp lý và
 *   không tự diễn giải restriction record.
 *
 * ## Quyết định chưa chốt
 *
 * Domain **không** áp các giá trị sau; xem `docs/domains/llm-seller-governance/domain-model.md` §8:
 *
 * - Tập policy restriction, ngữ nghĩa policy và thời hạn appeal mặc định
 *   (§9.4).
 * - Role/thẩm quyền của reviewer appeal và verification (§9.3).
 * - Retention, legal hold, archive/export/anonymization/physical deletion
 *   (§9.1, §9.6; ADR-0008).
 * - Thuế suất, withholding và treaty — thuộc `llm-financial`.
 * - Số lần appeal lại sau reject (§9.4).
 */

export {
  LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES,
  isLlmGovernanceDomainError,
  llmGovernanceDomainError,
  type LlmGovernanceDomainError,
  type LlmGovernanceDomainErrorCode,
} from './errors';

export {
  MAX_OPAQUE_ID_LENGTH,
  MAX_SELLER_TEXT_LENGTH,
  createAppealId,
  createEvidenceId,
  createLegalPrincipalId,
  createRestrictionId,
  createVerificationCaseId,
  isAppealId,
  isEpochMillis,
  isEvidenceId,
  isLegalPrincipalId,
  isMembershipId,
  isOpaqueLabel,
  isRestrictionId,
  isSellerActorId,
  isSellerTenantId,
  isSellerText,
  isVerificationCaseId,
  llmGovernanceFailure,
  llmGovernanceOk,
  type AppealId,
  type EvidenceId,
  type LegalPrincipalId,
  type LlmGovernanceFailure,
  type LlmGovernanceOk,
  type LlmGovernanceResult,
  type MembershipId,
  type RestrictionId,
  type SellerActorId,
  type SellerTenantId,
  type VerificationCaseId,
} from './shared';

export {
  evaluateRestrictions,
  createRestrictionRecord,
  isRestrictionEffective,
  isRestrictionEvaluation,
  isRestrictionRecord,
  isRestrictionScope,
  isRestrictionTarget,
  liftRestriction,
  toPublicRestriction,
  type CreateRestrictionRecordInput,
  type EvaluateRestrictionsInput,
  type LiftRestrictionInput,
  type PublicRestriction,
  type RestrictionEvaluation,
  type RestrictionPolicy,
  type RestrictionRecord,
  type RestrictionScope,
  type RestrictionTarget,
} from './restriction';

export {
  decideAppeal,
  isAppeal,
  startAppealReview,
  submitAppeal,
  toPublicAppeal,
  withdrawAppeal,
  type Appeal,
  type AppealDecision,
  type AppealStatus,
  type DecideAppealInput,
  type PublicAppeal,
  type StartAppealReviewInput,
  type SubmitAppealInput,
  type WithdrawAppealInput,
} from './appeal';

export {
  createVerificationCase,
  decideVerification,
  deriveOnboardingState,
  deriveOperationalEligibility,
  expireVerificationCase,
  isVerificationCase,
  isVerificationProfileAxes,
  startVerificationReview,
  submitPrincipalVerificationCase,
  submitVerificationCase,
  type CreateVerificationCaseInput,
  type DecideVerificationInput,
  type DeriveOnboardingStateInput,
  type DeriveOperationalEligibilityInput,
  type EligibilityBlocker,
  type ExpireVerificationCaseInput,
  type OnboardingState,
  type OperationalEligibility,
  type PrincipalCoverageSnapshot,
  type StartVerificationReviewInput,
  type SubmitPrincipalVerificationCaseInput,
  type SubmitVerificationCaseInput,
  type TenantClassification,
  type VerificationCase,
  type VerificationDecision,
  type VerificationProfileAxisBinding,
  type VerificationProfileAxes,
  type VerificationStatus,
  type VerificationSubmission,
  type VerifiedProfileVersionPin,
} from './verification';

export {
  appendLegalProfileVersion,
  isLegalProfileVersion,
  legalProfileVersionAt,
  type AppendLegalProfileVersionInput,
  type LegalProfileVersion,
} from './legal-profile';

// `SubmitAppealInput` mang hai kiểu này, nên consumer phải import được chúng từ
// cùng public surface — nếu không, chúng xuất hiện trong signature mà không có
// đường khai báo kiểu tham số. Chỉ xuất **kiểu**: `submitAppeal` tự validate
// bằng guard nội bộ, nên guard không phải một operation công khai của domain
// (và không được trông như một thang authorization của tenant).
export type { GovernanceMembershipRef, GovernanceTenantRef } from './tenant-ref';

export {
  appendTaxProfileVersion,
  isTaxProfileVersion,
  taxProfileVersionAt,
  type AppendTaxProfileVersionInput,
  type TaxProfileVersion,
} from './tax-profile';

export {
  assertEvidenceInTenant,
  createEvidenceReference,
  isEvidenceReference,
  type CreateEvidenceReferenceInput,
  type EvidenceReference,
} from './evidence';

export {
  appendPrincipalLegalProfileVersion,
  appendPrincipalTaxProfileVersion,
  blockLegalPrincipal,
  createFirstPartyLegalPrincipal,
  isFirstPartyLegalPrincipal,
  isPrincipalLegalProfileVersion,
  isPrincipalTaxProfileVersion,
  principalLegalProfileVersionAt,
  principalTaxProfileVersionAt,
  unblockLegalPrincipal,
  type AppendPrincipalProfileVersionInput,
  type AppendPrincipalTaxProfileVersionInput,
  type BlockLegalPrincipalInput,
  type CreateFirstPartyLegalPrincipalInput,
  type FirstPartyLegalPrincipal,
  type LegalPrincipalStatus,
  type PrincipalLegalProfileVersion,
  type PrincipalTaxProfileVersion,
  type UnblockLegalPrincipalInput,
} from './principal';

export {
  acceptPrincipalRevision,
  establishFirstPartyPrincipalAssociation,
  isPrincipalAssessment,
  isPrincipalAssociation,
  type AcceptPrincipalRevisionInput,
  type EstablishFirstPartyPrincipalAssociationInput,
  type PrincipalApprovedCoverage,
  type PrincipalAssessment,
  type PrincipalAssociation,
} from './principal-association';

export {
  assertEvidenceInPrincipal,
  createPrincipalEvidenceReference,
  isPrincipalEvidenceReference,
  type CreatePrincipalEvidenceReferenceInput,
  type PrincipalEvidenceReference,
} from './evidence';
