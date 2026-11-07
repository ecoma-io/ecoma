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
  isOpaqueLabel,
  isSellerActorId,
  isSellerTenantId,
  isSellerText,
  llmGovernanceFailure,
  llmGovernanceOk,
  type EvidenceId,
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
