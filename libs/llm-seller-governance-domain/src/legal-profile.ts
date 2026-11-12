/**
 * Legal profile của Seller tenant.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §1, §3.4;
 * ADR-0006.
 *
 * Profile là **append-only theo version**: không update, không delete, không có
 * cờ `current`. Kỳ hiệu lực suy ra từ `effectiveFrom` của version kế tiếp:
 * version `i` hiệu lực trong `[effectiveFrom_i, effectiveFrom_{i+1})`; version
 * cuối không có cận trên.
 *
 * Domain chỉ giữ **dữ liệu định danh pháp lý**, không tính thuế, không quyết
 * định withholding (thuộc `llm-financial`).
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
  type SellerTenantId,
} from './shared';
import {
  isVersionedProfileCommon,
  nextProfileVersion,
  versionedProfileAt,
} from './versioned-profile';

/** Một version của legal profile. */
export interface LegalProfileVersion {
  readonly tenantId: SellerTenantId;
  /** Số thứ tự do domain cấp, bắt đầu từ 1. */
  readonly version: number;
  readonly legalName: string;
  /** Loại pháp lý (`company`, `sole_proprietor`, ...) — opaque label. */
  readonly legalType: string;
  readonly jurisdiction: string;
  readonly registrationReference: string;
  readonly effectiveFrom: number;
  readonly recordedAt: number;
  readonly recordedBy: SellerActorId;
}

/** Input ghi version mới. */
export interface AppendLegalProfileVersionInput {
  readonly tenantId: unknown;
  readonly legalName: unknown;
  readonly legalType: unknown;
  readonly jurisdiction: unknown;
  readonly registrationReference: unknown;
  readonly effectiveFrom: unknown;
  readonly recordedAt: unknown;
  readonly recordedBy: unknown;
}

/**
 * Ghi thêm một version legal profile.
 *
 * Guard:
 * - Mọi field bắt buộc và là text/label hợp lệ (`invalid_profile_field`).
 * - `effectiveFrom`, `recordedAt`, `recordedBy` hợp lệ.
 * - Mọi version hiện có thuộc đúng tenant và đúng shape
 *   (`inconsistent_context` / `invalid_profile_version`).
 * - `effectiveFrom` **tăng nghiêm ngặt** so với version cuối
 *   (`effective_from_not_increasing`).
 *
 * `version = 1` cho bản ghi đầu; sau đó `last + 1`. Hàm không sắp xếp hay sửa
 * input: collection được trả về là collection mới, input giữ nguyên.
 */
export function appendLegalProfileVersion(
  versions: readonly LegalProfileVersion[],
  input: AppendLegalProfileVersionInput,
): LlmGovernanceResult<readonly LegalProfileVersion[]> {
  const tenantId = input.tenantId;
  if (!isSellerTenantId(tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (
    !isSellerText(input.legalName) ||
    !isOpaqueLabel(input.legalType) ||
    !isSellerText(input.jurisdiction) ||
    !isSellerText(input.registrationReference)
  ) {
    return llmGovernanceFailure('invalid_profile_field');
  }
  if (!isEpochMillis(input.effectiveFrom)) {
    return llmGovernanceFailure('invalid_effective_from');
  }
  if (!isEpochMillis(input.recordedAt)) {
    return llmGovernanceFailure('invalid_timestamp');
  }
  if (!isSellerActorId(input.recordedBy)) {
    return llmGovernanceFailure('invalid_actor');
  }
  const nextVersion = nextProfileVersion(
    versions,
    tenantId,
    (version) => version.tenantId,
    input.effectiveFrom,
    isLegalProfileVersion,
  );
  if (!nextVersion.ok) {
    return nextVersion;
  }
  return llmGovernanceOk(
    Object.freeze([
      ...versions,
      Object.freeze({
        tenantId,
        version: nextVersion.value,
        legalName: input.legalName,
        legalType: input.legalType,
        jurisdiction: input.jurisdiction,
        registrationReference: input.registrationReference,
        effectiveFrom: input.effectiveFrom,
        recordedAt: input.recordedAt,
        recordedBy: input.recordedBy,
      }),
    ]),
  );
}

/**
 * Version legal profile hiệu lực tại `at`, hoặc `undefined` nếu chưa có version
 * nào bắt đầu hiệu lực.
 *
 * `at` không hợp lệ ⇒ `undefined`: hàm chỉ đọc, không có result type để trả lỗi.
 * Caller phải validate `at` trước nếu cần phân biệt.
 */
export function legalProfileVersionAt(
  versions: readonly LegalProfileVersion[],
  at: number,
): LegalProfileVersion | undefined {
  return versionedProfileAt(versions, at, isLegalProfileVersion);
}

/**
 * Shape guard cho legal profile version đọc từ storage.
 *
 * Adapter phải gọi trước khi dùng version cho eligibility/authorization. Phần
 * khung không mang chủ thể (`versioned-profile`), nên guard này tự kiểm
 * `tenantId` — profile tenant-scoped chỉ tồn tại trên đường customer (§3.4).
 */
export function isLegalProfileVersion(value: unknown): value is LegalProfileVersion {
  if (!isVersionedProfileCommon(value)) {
    return false;
  }
  const candidate = value as Partial<Record<keyof LegalProfileVersion, unknown>>;
  return (
    isSellerTenantId(candidate.tenantId) &&
    isSellerText(candidate.legalName) &&
    isOpaqueLabel(candidate.legalType) &&
    isSellerText(candidate.jurisdiction) &&
    isSellerText(candidate.registrationReference)
  );
}
