/**
 * Verification case — record và tạo case, với subject hai trục.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §3.3, §3.6, §3.8;
 * [ADR-0027](../../../docs/domains/llm-seller-tenant/adr/0027-first-party-seller-provider-identity-and-legal-principal.md) §4.
 *
 * Một case có **đúng một** subject: `tenantId` (đường customer) **hoặc**
 * `principalId` (đường first-party, §3.8) — không bao giờ cả hai, không bao giờ
 * neither. Case principal-scoped phục vụ principal pháp lý first-party: hồ sơ
 * được review là profile versions của principal, không phải của tenant.
 *
 * `verifiedProfileVersions` là **pin coverage** (§3.6): version profile mà
 * approval đã xác minh trên trục tương ứng, ghi tại thời điểm `approved`. Type
 * không gắn trục profile nào thì không có pin và không thuộc coverage rule.
 * Ánh xạ `type → trục` là **cấu hình của caller** (types là định danh mở),
 * không phải enum của domain.
 *
 * Lifecycle ops (submit/review/decide/expire) nằm ở `verification.ts`; module
 * này chỉ giữ record, guard và thao tác tạo — để `principal-association` có
 * thể phụ thuộc record mà không kéo theo lifecycle/derivation.
 */

import {
  isEpochMillis,
  isLegalPrincipalId,
  isOpaqueLabel,
  isSellerActorId,
  isSellerTenantId,
  isSellerText,
  isVerificationCaseId,
  llmGovernanceFailure,
  llmGovernanceOk,
  type LegalPrincipalId,
  type LlmGovernanceResult,
  type SellerActorId,
  type SellerTenantId,
  type VerificationCaseId,
} from './shared';

/** Trạng thái verification case. `expired` là terminal. */
export type VerificationStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'expired';

/** Một lần nộp hồ sơ — bất biến sau khi tạo. Subject phản chiếu subject của case. */
export interface VerificationSubmission {
  readonly id: string;
  readonly caseId: VerificationCaseId;
  /** Đúng một trong hai, khớp subject của case. */
  readonly tenantId: SellerTenantId | null;
  readonly principalId: LegalPrincipalId | null;
  readonly evidenceIds: readonly string[];
  readonly submittedBy: SellerActorId;
  readonly submittedAt: number;
}

/**
 * Pin coverage: version profile mà một approval đã xác minh trên một trục.
 *
 * `axis` là trục profile (`legal` hoặc `tax`), `version` là số version (của
 * tenant hoặc của principal tùy subject case) đã được review tại thời điểm
 * approved. Thiếu pin hoặc pin lệch version ⇒ approval không còn được tính
 * (§3.6, §5 invariant 9).
 */
export interface VerifiedProfileVersionPin {
  readonly axis: 'legal' | 'tax';
  readonly version: number;
}

/**
 * Ánh xạ cấu hình `type verification → trục profile`.
 *
 * Caller cấp khi gọi `decideVerification`/`deriveOnboardingState`/
 * `deriveOperationalEligibility`. Một type gắn **nhiều nhất một** trục; type
 * không có trong ánh xạ không có pin và approval của nó tính theo trạng thái
 * `approved` cho tới `expired` (§3.6).
 */
export interface VerificationProfileAxisBinding {
  readonly type: string;
  readonly axis: 'legal' | 'tax';
}

/** Ánh xạ `type → trục profile` — danh sách binding, không dùng Map. */
export type VerificationProfileAxes = readonly VerificationProfileAxisBinding[];

/** Một verification case — subject là tenant **hoặc** principal, đúng một. */
export interface VerificationCase {
  readonly id: VerificationCaseId;
  /** Đúng một trong hai khác `null`, kia phải `null` (§3.3). */
  readonly tenantId: SellerTenantId | null;
  readonly principalId: LegalPrincipalId | null;
  /** Loại verification (`business`, `legal-identity`, `tax`, ...) — opaque label. */
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
  /**
   * Pin coverage — chỉ có sau khi `decideVerification` approved một type gắn
   * trục profile; type không gắn trục thì mảng rỗng và không thuộc coverage rule.
   */
  readonly verifiedProfileVersions: readonly VerifiedProfileVersionPin[];
}

/** Input tạo verification case. */
export interface CreateVerificationCaseInput {
  readonly id: unknown;
  /** Subject tenant — bắt buộc khi `principalId` vắng mặt. */
  readonly tenantId?: unknown;
  /** Subject principal — bắt buộc khi `tenantId` vắng mặt. */
  readonly principalId?: unknown;
  readonly type: unknown;
  readonly createdAt: unknown;
  /** Case đã có (cùng subject) — dùng cho guard trùng `id`. */
  readonly existing?: readonly VerificationCase[];
}

/**
 * Tạo verification case ở trạng thái `draft` với **đúng một** subject (§3.3).
 *
 * Guard subject: cả hai subject cùng xuất hiện ⇒ `inconsistent_context`; không
 * subject nào ⇒ `ambiguous_context`; subject xuất hiện nhưng sai shape ⇒ mã
 * validate của subject đó.
 */
export function createVerificationCase(
  input: CreateVerificationCaseInput,
): LlmGovernanceResult<VerificationCase> {
  if (!isVerificationCaseId(input.id)) {
    return llmGovernanceFailure('invalid_verification_case_id');
  }
  const hasTenantId = input.tenantId !== undefined && input.tenantId !== null;
  const hasPrincipalId = input.principalId !== undefined && input.principalId !== null;
  if (hasTenantId && hasPrincipalId) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (!hasTenantId && !hasPrincipalId) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (hasTenantId && !isSellerTenantId(input.tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (hasPrincipalId && !isLegalPrincipalId(input.principalId)) {
    return llmGovernanceFailure('invalid_legal_principal_id');
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
  const tenantId = hasTenantId ? (input.tenantId as SellerTenantId) : null;
  const principalId = hasPrincipalId ? (input.principalId as LegalPrincipalId) : null;
  if (existing.some((testCase) => testCase.tenantId !== tenantId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (existing.some((testCase) => testCase.principalId !== principalId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (existing.some((testCase) => testCase.id === input.id)) {
    return llmGovernanceFailure('duplicate_verification_case_id');
  }
  return llmGovernanceOk(
    Object.freeze({
      id: input.id,
      tenantId,
      principalId,
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
      verifiedProfileVersions: Object.freeze([]) as readonly VerifiedProfileVersionPin[],
    }),
  );
}

/**
 * Shape guard cho verification case đọc từ storage.
 *
 * Adapter phải gọi trước khi dùng case cho eligibility. Guard đòi subject XOR
 * ở cả case lẫn mọi submission, và pin coverage có shape hợp lệ không trùng
 * trục — sai subject hay pin là dữ liệu hỏng, fail-closed.
 */
export function isVerificationCase(value: unknown): value is VerificationCase {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof VerificationCase, unknown>>;
  const hasTenantId = isSellerTenantId(candidate.tenantId);
  const hasPrincipalId = isLegalPrincipalId(candidate.principalId);
  // XOR: đúng một subject.
  if (hasTenantId === hasPrincipalId) {
    return false;
  }
  const otherSubjectIsNull = hasTenantId
    ? candidate.principalId === null
    : candidate.tenantId === null;
  if (!otherSubjectIsNull) {
    return false;
  }
  if (
    !isVerificationCaseId(candidate.id) ||
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
  if (!Array.isArray(candidate.verifiedProfileVersions)) {
    return false;
  }
  const seenAxes = new Set<string>();
  for (const pin of candidate.verifiedProfileVersions) {
    if (!isVerifiedProfileVersionPin(pin)) {
      return false;
    }
    if (seenAxes.has(pin.axis)) {
      return false;
    }
    seenAxes.add(pin.axis);
  }
  return candidate.submissions.every(
    (submission) =>
      submission.caseId === candidate.id &&
      submission.tenantId === candidate.tenantId &&
      submission.principalId === candidate.principalId,
  );
}

/** Shape guard cho ánh xạ `type → trục` do caller cấu hình. */
export function isVerificationProfileAxes(value: unknown): value is VerificationProfileAxes {
  if (!Array.isArray(value)) {
    return false;
  }
  const seenTypes = new Set<string>();
  for (const binding of value) {
    if (typeof binding !== 'object' || binding === null) {
      return false;
    }
    const candidate = binding as Partial<Record<keyof VerificationProfileAxisBinding, unknown>>;
    if (
      !isOpaqueLabel(candidate.type) ||
      !(candidate.axis === 'legal' || candidate.axis === 'tax')
    ) {
      return false;
    }
    if (seenTypes.has(candidate.type)) {
      return false;
    }
    seenTypes.add(candidate.type);
  }
  return true;
}

function isVerificationSubmission(value: unknown): value is VerificationSubmission {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof VerificationSubmission, unknown>>;
  const hasTenantId = isSellerTenantId(candidate.tenantId);
  const hasPrincipalId = isLegalPrincipalId(candidate.principalId);
  if (hasTenantId === hasPrincipalId) {
    return false;
  }
  const otherSubjectIsNull = hasTenantId
    ? candidate.principalId === null
    : candidate.tenantId === null;
  if (!otherSubjectIsNull) {
    return false;
  }
  if (!isSellerText(candidate.id) || !isVerificationCaseId(candidate.caseId)) {
    return false;
  }
  if (!isSellerActorId(candidate.submittedBy) || !isEpochMillis(candidate.submittedAt)) {
    return false;
  }
  return (
    Array.isArray(candidate.evidenceIds) &&
    candidate.evidenceIds.length > 0 &&
    candidate.evidenceIds.every(isSellerText)
  );
}

function isVerifiedProfileVersionPin(value: unknown): value is VerifiedProfileVersionPin {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof VerifiedProfileVersionPin, unknown>>;
  return (
    (candidate.axis === 'legal' || candidate.axis === 'tax') &&
    typeof candidate.version === 'number' &&
    Number.isSafeInteger(candidate.version) &&
    candidate.version >= 1
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
