/**
 * Tax profile của Seller tenant.
 *
 * Source of truth: `docs/domains/llm-seller-governance/domain-model.md` §1, §3.4;
 * ADR-0006; [`llm-financial/adr/0008`](../../../docs/domains/llm-financial/adr/0008-seller-tax-profile.md).
 *
 * Cùng cấu trúc versioned append-only như legal profile. Ranh giới:
 * - `llm-seller` sở hữu **dữ liệu** tax profile (residency, identifier,
 *   declaration reference).
 * - `llm-financial` sở hữu **tính toán** thuế/withholding dựa trên dữ liệu đó.
 * - Domain này không có hàm tính thuế, không hardcode thuế suất, không biết
 *   treaty hay rate nào.
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

/** Một version của tax profile. */
export interface TaxProfileVersion {
  readonly tenantId: SellerTenantId;
  /** Số thứ tự do domain cấp, bắt đầu từ 1. */
  readonly version: number;
  /** Nơi cư trú thuế — opaque label. */
  readonly taxResidency: string;
  readonly taxIdentifier: string;
  /** Tham chiếu tới declaration/tài liệu thuế. */
  readonly declarationReference: string;
  readonly effectiveFrom: number;
  readonly recordedAt: number;
  readonly recordedBy: SellerActorId;
}

/** Input ghi version mới. */
export interface AppendTaxProfileVersionInput {
  readonly tenantId: unknown;
  readonly taxResidency: unknown;
  readonly taxIdentifier: unknown;
  readonly declarationReference: unknown;
  readonly effectiveFrom: unknown;
  readonly recordedAt: unknown;
  readonly recordedBy: unknown;
}

/**
 * Ghi thêm một version tax profile.
 *
 * Cùng guard với `appendLegalProfileVersion`: field hợp lệ, collection cùng
 * tenant, `effectiveFrom` tăng nghiêm ngặt.
 */
export function appendTaxProfileVersion(
  versions: readonly TaxProfileVersion[],
  input: AppendTaxProfileVersionInput,
): LlmGovernanceResult<readonly TaxProfileVersion[]> {
  const tenantId = input.tenantId;
  if (!isSellerTenantId(tenantId)) {
    return llmGovernanceFailure('invalid_seller_tenant_id');
  }
  if (
    !isOpaqueLabel(input.taxResidency) ||
    !isSellerText(input.taxIdentifier) ||
    !isSellerText(input.declarationReference)
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
    isTaxProfileVersion,
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
        taxResidency: input.taxResidency,
        taxIdentifier: input.taxIdentifier,
        declarationReference: input.declarationReference,
        effectiveFrom: input.effectiveFrom,
        recordedAt: input.recordedAt,
        recordedBy: input.recordedBy,
      }),
    ]),
  );
}

/**
 * Version tax profile hiệu lực tại `at`, hoặc `undefined`.
 *
 * `at` không hợp lệ ⇒ `undefined`.
 */
export function taxProfileVersionAt(
  versions: readonly TaxProfileVersion[],
  at: number,
): TaxProfileVersion | undefined {
  return versionedProfileAt(versions, at, isTaxProfileVersion);
}

/** Shape guard cho tax profile version đọc từ storage. */
export function isTaxProfileVersion(value: unknown): value is TaxProfileVersion {
  if (!isVersionedProfileCommon(value)) {
    return false;
  }
  const candidate = value as Partial<Record<keyof TaxProfileVersion, unknown>>;
  return (
    isSellerTenantId(candidate.tenantId) &&
    isOpaqueLabel(candidate.taxResidency) &&
    isSellerText(candidate.taxIdentifier) &&
    isSellerText(candidate.declarationReference)
  );
}
