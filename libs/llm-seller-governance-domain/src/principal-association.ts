/**
 * Principal association — liên kết giữa một Seller tenant first-party và
 * `FirstPartyLegalPrincipal`, cùng snapshot `principalAssessment` cho derivation.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §3.6, §3.8;
 * [ADR-0027](../../../docs/domains/llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §3, §4, §5.
 *
 * Nguyên tắc:
 * - **Đúng một association cho mỗi tenant first_party**; tenant `customer`
 *   không có association. Không có operation reassignment hay đổi principal
 *   trong model MVP; Seller Tenant Owner authority của `llm-seller-tenant`
 *   không chạm governance records.
 * - Association pin **cặp revision được accept** (`acceptedLegalProfileVersion`,
 *   `acceptedTaxProfileVersion`). Thiết lập chỉ qua bề mặt provisioning có kiểm
 *   soát — dữ liệu đầu vào của domain (ADR-0020 Quyết định 3).
 * - `establish` và `accept` đòi principal `active` **và** approved coverage phủ
 *   **đúng** cặp revision được accept. Coverage không suy ra từ `status` — nó
 *   là snapshot `approvedCoverage` do caller cấp từ durable state (các case
 *   principal-scoped `approved` còn chưa `expired`); domain đối chiếu cả ba:
 *   accepted == coverage == revision hiện hành tại thời điểm thao tác. Lệch ở
 *   bất kỳ đâu ⇒ `principal_revision_not_verified`.
 * - `principalAssessment` là snapshot application lắp cho
 *   `deriveOperationalEligibility` (§3.6, §3.8): principal + association (hoặc
 *   `null`) + approved coverage per trục + thời điểm đánh giá. Domain chỉ kiểm
 *   shape (như `RestrictionEvaluation`); mọi lệch/bất nhất do derivation kết
 *   luận thành ineligible — guard không tự suy ra verdict.
 */

import {
  isEpochMillis,
  isLegalPrincipalId,
  isSellerActorId,
  isSellerTenantId,
  llmGovernanceFailure,
  llmGovernanceOk,
  type LegalPrincipalId,
  type LlmGovernanceResult,
  type SellerActorId,
  type SellerTenantId,
} from './shared';
import {
  isFirstPartyLegalPrincipal,
  principalLegalProfileVersionAt,
  principalTaxProfileVersionAt,
  type FirstPartyLegalPrincipal,
} from './principal';

/**
 * Cặp revision hiện hành được approved coverage phủ, theo trục.
 *
 * `null` nghĩa là trục đó chưa có approved coverage nào còn hiệu lực. Caller
 * lắp từ durable state: case principal-scoped `approved` của trục, chưa
 * `expired`, pin còn khớp.
 */
export interface PrincipalApprovedCoverage {
  readonly legal: number | null;
  readonly tax: number | null;
}

/** Association tenant first_party → principal, pin cặp revision đã accept. */
export interface PrincipalAssociation {
  readonly tenantId: SellerTenantId;
  readonly principalId: LegalPrincipalId;
  readonly acceptedLegalProfileVersion: number;
  readonly acceptedTaxProfileVersion: number;
  readonly establishedAt: number;
  readonly establishedBy: SellerActorId;
  /** Audit lần accept cuối; bằng cặp established khi chưa accept lại lần nào. */
  readonly lastAcceptedAt: number;
  readonly lastAcceptedBy: SellerActorId;
}

/** Input thiết lập association. */
export interface EstablishFirstPartyPrincipalAssociationInput {
  readonly tenantId: unknown;
  readonly principal: FirstPartyLegalPrincipal;
  readonly acceptedLegalProfileVersion: unknown;
  readonly acceptedTaxProfileVersion: unknown;
  /** Approved coverage do caller lắp từ durable state — phải phủ đúng cặp được accept. */
  readonly approvedCoverage: PrincipalApprovedCoverage;
  readonly establishedBy: unknown;
  readonly establishedAt: unknown;
  /** Association đã có — dùng cho guard trùng tenant. */
  readonly existing?: readonly PrincipalAssociation[];
}

/**
 * Thiết lập association tenant first_party → principal (§3.8, §4).
 *
 * Guard:
 * - `tenantId`, `principal`, cặp accepted, `approvedCoverage`, actor/time hợp lệ.
 * - Principal `active` (`principal_not_active`) — association chỉ thiết lập
 *   được khi principal đang phục vụ được.
 * - Coverage phủ **đúng** cặp được accept và cặp đó là revision hiện hành của
 *   principal tại `establishedAt` (`principal_revision_not_verified`).
 * - `existing` (nếu cấp) mọi phần tử hợp lệ; tenant đã có association ⇒
 *   `duplicate_principal_association`; association của tenant khác trong cùng
 *   collection ⇒ `principal_association_not_in_tenant` (collection phải là của
 *   target tenant).
 */
export function establishFirstPartyPrincipalAssociation(
  input: EstablishFirstPartyPrincipalAssociationInput,
): LlmGovernanceResult<PrincipalAssociation> {
  if (!isSellerTenantId(input.tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (!isFirstPartyLegalPrincipal(input.principal)) {
    return llmGovernanceFailure('invalid_legal_principal');
  }
  if (input.principal.status !== 'active') {
    return llmGovernanceFailure('principal_not_active');
  }
  if (
    !isAcceptedVersion(input.acceptedLegalProfileVersion) ||
    !isAcceptedVersion(input.acceptedTaxProfileVersion)
  ) {
    return llmGovernanceFailure('invalid_profile_version');
  }
  if (!isPrincipalApprovedCoverage(input.approvedCoverage)) {
    return llmGovernanceFailure('invalid_principal_association');
  }
  if (!isSellerActorId(input.establishedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.establishedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (input.establishedAt < input.principal.createdAt) {
    return llmGovernanceFailure('invalid_principal_association');
  }
  const currentLegal = principalLegalProfileVersionAt(input.principal, input.establishedAt);
  const currentTax = principalTaxProfileVersionAt(input.principal, input.establishedAt);
  if (
    currentLegal === undefined ||
    currentTax === undefined ||
    input.acceptedLegalProfileVersion !== currentLegal.version ||
    input.acceptedTaxProfileVersion !== currentTax.version ||
    input.approvedCoverage.legal !== currentLegal.version ||
    input.approvedCoverage.tax !== currentTax.version
  ) {
    return llmGovernanceFailure('principal_revision_not_verified');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!existing.every(isPrincipalAssociation)) {
    return llmGovernanceFailure('invalid_principal_association');
  }
  if (existing.some((association) => association.tenantId === input.tenantId)) {
    return llmGovernanceFailure('duplicate_principal_association');
  }
  if (existing.some((association) => association.tenantId !== input.tenantId)) {
    // Collection association phải là của target tenant; entry của tenant khác
    // không được mang vào để "mượn" liên kết.
    return llmGovernanceFailure('principal_association_not_in_tenant');
  }
  const tenantId = input.tenantId;
  return llmGovernanceOk(
    Object.freeze({
      tenantId,
      principalId: input.principal.principalId,
      acceptedLegalProfileVersion: input.acceptedLegalProfileVersion,
      acceptedTaxProfileVersion: input.acceptedTaxProfileVersion,
      establishedAt: input.establishedAt,
      establishedBy: input.establishedBy,
      lastAcceptedAt: input.establishedAt,
      lastAcceptedBy: input.establishedBy,
    }),
  );
}

/** Input accept revision mới của association. */
export interface AcceptPrincipalRevisionInput {
  readonly association: PrincipalAssociation;
  readonly principal: FirstPartyLegalPrincipal;
  /** Approved coverage do caller lắp từ durable state — phải phủ cặp hiện hành. */
  readonly approvedCoverage: PrincipalApprovedCoverage;
  readonly acceptedBy: unknown;
  readonly acceptedAt: unknown;
}

/**
 * Cập nhật accepted revisions của association lên **cặp revision hiện hành**
 * của principal (§3.8, §4).
 *
 * Guard: principal `active`; coverage (do caller lắp) phủ đúng revision hiện
 * hành tại `acceptedAt` — khi đó accepted mới == cặp hiện hành. Principal lệch
 * với association ⇒ `inconsistent_context`; thời điểm trước lần thiết lập ⇒
 * `invalid_principal_association`.
 *
 * Acceptance không đụng restriction hay dữ liệu tenant khác — chỉ đổi cặp
 * accepted và audit lần accept cuối.
 */
export function acceptPrincipalRevision(
  input: AcceptPrincipalRevisionInput,
): LlmGovernanceResult<PrincipalAssociation> {
  if (!isPrincipalAssociation(input.association)) {
    return llmGovernanceFailure('invalid_principal_association');
  }
  if (!isFirstPartyLegalPrincipal(input.principal)) {
    return llmGovernanceFailure('invalid_legal_principal');
  }
  if (input.principal.principalId !== input.association.principalId) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (input.principal.status !== 'active') {
    return llmGovernanceFailure('principal_not_active');
  }
  if (!isPrincipalApprovedCoverage(input.approvedCoverage)) {
    return llmGovernanceFailure('invalid_principal_association');
  }
  if (!isSellerActorId(input.acceptedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  if (!isEpochMillis(input.acceptedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (input.acceptedAt < input.association.establishedAt) {
    return llmGovernanceFailure('invalid_principal_association');
  }
  const currentLegal = principalLegalProfileVersionAt(input.principal, input.acceptedAt);
  const currentTax = principalTaxProfileVersionAt(input.principal, input.acceptedAt);
  if (
    currentLegal === undefined ||
    currentTax === undefined ||
    input.approvedCoverage.legal !== currentLegal.version ||
    input.approvedCoverage.tax !== currentTax.version
  ) {
    return llmGovernanceFailure('principal_revision_not_verified');
  }
  return llmGovernanceOk(
    Object.freeze({
      ...input.association,
      acceptedLegalProfileVersion: currentLegal.version,
      acceptedTaxProfileVersion: currentTax.version,
      lastAcceptedAt: input.acceptedAt,
      lastAcceptedBy: input.acceptedBy,
    }),
  );
}

/**
 * Snapshot application lắp cho derivation trên đường first_party (§3.6, §3.8).
 *
 * Chứa principal, association (hoặc `null` khi tenant chưa liên kết) và
 * approved coverage per trục tại `assessedAt`. Domain kiểm shape; mọi kết luận
 * eligibility thuộc `deriveOperationalEligibility`.
 */
export interface PrincipalAssessment {
  readonly principal: FirstPartyLegalPrincipal;
  readonly association: PrincipalAssociation | null;
  readonly approvedCoverage: PrincipalApprovedCoverage;
  readonly assessedAt: number;
}

/** Shape guard cho `principalAssessment` đọc từ application snapshot. */
export function isPrincipalAssessment(value: unknown): value is PrincipalAssessment {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof PrincipalAssessment, unknown>>;
  if (
    !isFirstPartyLegalPrincipal(candidate.principal) ||
    !isPrincipalApprovedCoverage(candidate.approvedCoverage) ||
    !isEpochMillis(candidate.assessedAt)
  ) {
    return false;
  }
  return candidate.association === null || isPrincipalAssociation(candidate.association);
}

/** Shape guard cho association đọc từ storage. */
export function isPrincipalAssociation(value: unknown): value is PrincipalAssociation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof PrincipalAssociation, unknown>>;
  return (
    isSellerTenantId(candidate.tenantId) &&
    isLegalPrincipalId(candidate.principalId) &&
    isAcceptedVersion(candidate.acceptedLegalProfileVersion) &&
    isAcceptedVersion(candidate.acceptedTaxProfileVersion) &&
    isEpochMillis(candidate.establishedAt) &&
    isSellerActorId(candidate.establishedBy) &&
    isEpochMillis(candidate.lastAcceptedAt) &&
    isSellerActorId(candidate.lastAcceptedBy)
  );
}

function isPrincipalApprovedCoverage(value: unknown): value is PrincipalApprovedCoverage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof PrincipalApprovedCoverage, unknown>>;
  return (
    (candidate.legal === null || isAcceptedVersion(candidate.legal)) &&
    (candidate.tax === null || isAcceptedVersion(candidate.tax))
  );
}

function isAcceptedVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
