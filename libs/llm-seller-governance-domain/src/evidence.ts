/**
 * Evidence reference của Seller tenant.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §1, §3.5;
 * ADR-0006, ADR-0008.
 *
 * Evidence là **tham chiếu bất biến** tới tài liệu do storage ngoài giữ: domain
 * chỉ biết `storageRef` và `contentHash`, không biết nội dung, không upload,
 * không xoá. Retention/physical deletion là quyết định chưa chốt (ADR-0008).
 *
 * Cross-tenant là guard trọng yếu: verification của tenant A không được tham
 * chiếu evidence của tenant B, kể cả khi client gửi ID hợp lệ.
 */

import {
  isEpochMillis,
  isEvidenceId,
  isLegalPrincipalId,
  isOpaqueLabel,
  isSellerActorId,
  isSellerTenantId,
  isSellerText,
  llmGovernanceFailure,
  llmGovernanceOk,
  type EvidenceId,
  type LegalPrincipalId,
  type LlmGovernanceResult,
  type SellerActorId,
  type SellerTenantId,
} from './shared';

/**
 * Một tham chiếu evidence.
 *
 * Không có `status`, không có `deletedAt`: evidence là bản ghi append-only của
 * một lần ghi nhận tài liệu.
 */
export interface EvidenceReference {
  readonly id: EvidenceId;
  readonly tenantId: SellerTenantId;
  /** Loại tài liệu (opaque label: `business_registration`, `tax_certificate`, ...). */
  readonly kind: string;
  /** Tham chiếu opaque tới storage ngoài domain. */
  readonly storageRef: string;
  /** Hash nội dung để phát hiện thay đổi. */
  readonly contentHash: string;
  readonly recordedAt: number;
  readonly recordedBy: SellerActorId;
}

/** Input tạo evidence reference. */
export interface CreateEvidenceReferenceInput {
  readonly id: unknown;
  readonly tenantId: unknown;
  readonly kind: unknown;
  readonly storageRef: unknown;
  readonly contentHash: unknown;
  readonly recordedAt: unknown;
  readonly recordedBy: unknown;
  /** Evidence đã có của tenant — dùng cho guard trùng `id`. */
  readonly existing?: readonly EvidenceReference[];
}

/**
 * Ghi nhận một evidence reference.
 *
 * Guard: mọi field đọc được; `existing` (nếu cấp) thuộc đúng tenant và chưa có
 * `id` trùng. Hàm thuần — không kiểm tra tài liệu có thật ở storage hay không;
 * đó là việc của adapter.
 */
export function createEvidenceReference(
  input: CreateEvidenceReferenceInput,
): LlmGovernanceResult<EvidenceReference> {
  if (!isEvidenceId(input.id)) {
    return llmGovernanceFailure('invalid_evidence_id');
  }
  if (!isSellerTenantId(input.tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (!isOpaqueLabel(input.kind)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (!isSellerText(input.storageRef) || !isSellerText(input.contentHash)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!isSellerActorId(input.recordedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!existing.every(isEvidenceReference)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (existing.some((evidence) => evidence.tenantId !== input.tenantId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (existing.some((evidence) => evidence.id === input.id)) {
    return llmGovernanceFailure('duplicate_evidence_reference_id');
  }
  return llmGovernanceOk(
    Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      kind: input.kind,
      storageRef: input.storageRef,
      contentHash: input.contentHash,
      recordedAt: input.recordedAt,
      recordedBy: input.recordedBy,
    }),
  );
}

/**
 * Khẳng định evidence thuộc đúng tenant rồi trả lại nó.
 *
 * Trả `evidence_not_in_tenant` khi lệch: consumer không được "bỏ qua evidence
 * lạ rồi tiếp tục".
 */
export function assertEvidenceInTenant(
  evidence: EvidenceReference,
  tenantId: SellerTenantId,
): LlmGovernanceResult<EvidenceReference> {
  if (!isSellerTenantId(tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (!isEvidenceReference(evidence)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (evidence.tenantId !== tenantId) {
    return llmGovernanceFailure('evidence_not_in_tenant');
  }
  return llmGovernanceOk(evidence);
}

/**
 * Shape guard cho evidence đọc từ storage.
 *
 * Adapter phải gọi trước khi dùng evidence cho verification.
 */
export function isEvidenceReference(value: unknown): value is EvidenceReference {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof EvidenceReference, unknown>>;
  return (
    isEvidenceId(candidate.id) &&
    isSellerTenantId(candidate.tenantId) &&
    isOpaqueLabel(candidate.kind) &&
    isSellerText(candidate.storageRef) &&
    isSellerText(candidate.contentHash) &&
    isEpochMillis(candidate.recordedAt) &&
    isSellerActorId(candidate.recordedBy)
  );
}

/**
 * Tham chiếu evidence trên **trục principal** (§3.8).
 *
 * Evidence của case principal-scoped gắn vào chính `FirstPartyLegalPrincipal`
 * record (`principalId`, không phải `tenantId`) và trỏ tới hồ sơ authoritative
 * ngoài sản phẩm. Hai shape tách biệt là guard cấu trúc: một evidence không thể
 * "vừa tenant vừa principal", nên `assertEvidenceInTenant` không thể bị dùng
 * cho evidence principal và ngược lại — không có đường nào làm yếu rule cùng
 * tenant của §3.5.
 */
export interface PrincipalEvidenceReference {
  readonly id: EvidenceId;
  readonly principalId: LegalPrincipalId;
  /** Loại tài liệu (opaque label) — cùng nghĩa với `kind` trên trục tenant. */
  readonly kind: string;
  /** Tham chiếu opaque tới hồ sơ authoritative ngoài sản phẩm. */
  readonly storageRef: string;
  readonly contentHash: string;
  readonly recordedAt: number;
  readonly recordedBy: SellerActorId;
}

/** Input tạo evidence reference trên trục principal. */
export interface CreatePrincipalEvidenceReferenceInput {
  readonly id: unknown;
  readonly principalId: unknown;
  readonly kind: unknown;
  readonly storageRef: unknown;
  readonly contentHash: unknown;
  readonly recordedAt: unknown;
  readonly recordedBy: unknown;
  /** Evidence principal đã có — dùng cho guard trùng `id`. */
  readonly existing?: readonly PrincipalEvidenceReference[];
}

/**
 * Ghi nhận evidence reference trên trục principal.
 *
 * Cùng nghi thức guard với `createEvidenceReference`, nhưng phạm vi trùng lặp
 * là tập evidence của principal (`existing` mọi phần tử phải thuộc đúng
 * principal đó — lệch ⇒ `inconsistent_context`).
 */
export function createPrincipalEvidenceReference(
  input: CreatePrincipalEvidenceReferenceInput,
): LlmGovernanceResult<PrincipalEvidenceReference> {
  if (!isEvidenceId(input.id)) {
    return llmGovernanceFailure('invalid_evidence_id');
  }
  if (!isLegalPrincipalId(input.principalId)) {
    return llmGovernanceFailure('invalid_legal_principal_id');
  }
  if (!isOpaqueLabel(input.kind)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (!isSellerText(input.storageRef) || !isSellerText(input.contentHash)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!isSellerActorId(input.recordedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  const existing = input.existing ?? [];
  if (!Array.isArray(existing)) {
    return llmGovernanceFailure('ambiguous_context');
  }
  if (!existing.every(isPrincipalEvidenceReference)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (existing.some((evidence) => evidence.principalId !== input.principalId)) {
    return llmGovernanceFailure('inconsistent_context');
  }
  if (existing.some((evidence) => evidence.id === input.id)) {
    return llmGovernanceFailure('duplicate_evidence_reference_id');
  }
  return llmGovernanceOk(
    Object.freeze({
      id: input.id,
      principalId: input.principalId,
      kind: input.kind,
      storageRef: input.storageRef,
      contentHash: input.contentHash,
      recordedAt: input.recordedAt,
      recordedBy: input.recordedBy,
    }),
  );
}

/**
 * Khẳng định evidence principal thuộc đúng principal rồi trả lại nó.
 *
 * Trả `inconsistent_context` khi lệch: case principal-scoped không được tham
 * chiếu evidence của principal khác, kể cả khi client gửi ID hợp lệ.
 */
export function assertEvidenceInPrincipal(
  evidence: PrincipalEvidenceReference,
  principalId: LegalPrincipalId,
): LlmGovernanceResult<PrincipalEvidenceReference> {
  if (!isLegalPrincipalId(principalId)) {
    return llmGovernanceFailure('invalid_legal_principal_id');
  }
  if (!isPrincipalEvidenceReference(evidence)) {
    return llmGovernanceFailure('invalid_evidence_reference');
  }
  if (evidence.principalId !== principalId) {
    return llmGovernanceFailure('inconsistent_context');
  }
  return llmGovernanceOk(evidence);
}

/** Shape guard cho evidence principal đọc từ storage. */
export function isPrincipalEvidenceReference(value: unknown): value is PrincipalEvidenceReference {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof PrincipalEvidenceReference, unknown>>;
  return (
    isEvidenceId(candidate.id) &&
    isLegalPrincipalId(candidate.principalId) &&
    isOpaqueLabel(candidate.kind) &&
    isSellerText(candidate.storageRef) &&
    isSellerText(candidate.contentHash) &&
    isEpochMillis(candidate.recordedAt) &&
    isSellerActorId(candidate.recordedBy)
  );
}
