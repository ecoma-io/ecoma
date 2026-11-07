/**
 * Kiến trúc dùng chung của domain library `llm-seller-governance`.
 *
 * Đây là nửa **governance** của bounded context Seller (ADR-0018): restriction
 * record + evaluation, appeal lifecycle, verification/onboarding, legal/tax
 * profile, evidence reference và operational eligibility suy ra.
 *
 * ## Ranh giới với `llm-seller-tenant`
 *
 * Governance được phép phụ thuộc tenant (một chiều) — **chỉ** cho các
 * identity/value primitive: `SellerTenantId`, `SellerActorId`, `MembershipId`,
 * `isSellerTenantId`, `isSellerActorId`, `isMembershipId`, `isEpochMillis`,
 * `MAX_OPAQUE_ID_LENGTH`. Chiều ngược lại bị cấm.
 *
 * Result type, error table và error code là của riêng governance: nó **không**
 * tái dùng `LlmSellerResult`/`LlmSellerDomainError` của tenant, vì hai context
 * tiến hoá độc lập (ADR-0018).
 *
 * Mọi giá trị thời gian là epoch millis kiểu `number` do caller truyền vào —
 * domain không đọc đồng hồ, không parse RFC 3339, không sinh số ngẫu nhiên.
 * Runtime string (error message) viết bằng ENGLISH.
 */

import {
  MAX_OPAQUE_ID_LENGTH,
  isEpochMillis,
  isMembershipId,
  isSellerActorId,
  isSellerTenantId,
  type MembershipId,
  type SellerActorId,
  type SellerTenantId,
} from '@ecoma-io/llm-seller-tenant-domain';

import {
  llmGovernanceDomainError,
  type LlmGovernanceDomainError,
  type LlmGovernanceDomainErrorCode,
} from './errors';

export {
  MAX_OPAQUE_ID_LENGTH,
  isEpochMillis,
  isMembershipId,
  isSellerActorId,
  isSellerTenantId,
  type MembershipId,
  type SellerActorId,
  type SellerTenantId,
};

// ---------------------------------------------------------------------------
// Kết quả
// ---------------------------------------------------------------------------

/** Nhánh thành công: mang giá trị đã validate. */
export interface LlmGovernanceOk<Value> {
  readonly ok: true;
  readonly value: Value;
}

/** Nhánh bị từ chối: mang đúng một domain error, không mang dữ liệu call site. */
export interface LlmGovernanceFailure {
  readonly ok: false;
  readonly error: LlmGovernanceDomainError;
}

/** Kết quả của một operation domain governance. */
export type LlmGovernanceResult<Value> = LlmGovernanceOk<Value> | LlmGovernanceFailure;

/** Dựng nhánh thành công. */
export function llmGovernanceOk<Value>(value: Value): LlmGovernanceResult<Value> {
  return Object.freeze({ ok: true, value });
}

/** Dựng nhánh bị từ chối từ một mã lỗi trong taxonomy governance. */
export function llmGovernanceFailure<Value = never>(
  code: LlmGovernanceDomainErrorCode,
): LlmGovernanceResult<Value> {
  return Object.freeze({ ok: false, error: llmGovernanceDomainError(code) });
}

// ---------------------------------------------------------------------------
// Định danh và text riêng của governance
// ---------------------------------------------------------------------------

/** Độ dài tối đa của text tự do (reason, legal field, storage ref) trong governance. */
export const MAX_SELLER_TEXT_LENGTH = 500;

declare const restrictionIdBrand: unique symbol;

/** Định danh một restriction record. */
export type RestrictionId = string & { readonly [restrictionIdBrand]?: true };

declare const appealIdBrand: unique symbol;

/** Định danh một appeal. */
export type AppealId = string & { readonly [appealIdBrand]?: true };

declare const verificationCaseIdBrand: unique symbol;

/** Định danh một verification case. */
export type VerificationCaseId = string & { readonly [verificationCaseIdBrand]?: true };

declare const evidenceIdBrand: unique symbol;

/** Định danh một evidence reference. */
export type EvidenceId = string & { readonly [evidenceIdBrand]?: true };

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    value.trim() === value
  );
}

/** Type guard cho `RestrictionId`. */
export function isRestrictionId(value: unknown): value is RestrictionId {
  return isOpaqueId(value);
}

/** Type guard cho `AppealId`. */
export function isAppealId(value: unknown): value is AppealId {
  return isOpaqueId(value);
}

/** Type guard cho `VerificationCaseId`. */
export function isVerificationCaseId(value: unknown): value is VerificationCaseId {
  return isOpaqueId(value);
}

/** Type guard cho `EvidenceId`. */
export function isEvidenceId(value: unknown): value is EvidenceId {
  return isOpaqueId(value);
}

/** Dựng `RestrictionId`. @throws TypeError khi giá trị không hợp lệ. */
export function createRestrictionId(value: string): RestrictionId {
  if (!isRestrictionId(value)) {
    throw new TypeError('Restriction ID is not valid.');
  }
  return value;
}

/** Dựng `AppealId`. @throws TypeError khi giá trị không hợp lệ. */
export function createAppealId(value: string): AppealId {
  if (!isAppealId(value)) {
    throw new TypeError('Appeal ID is not valid.');
  }
  return value;
}

/** Dựng `VerificationCaseId`. @throws TypeError khi giá trị không hợp lệ. */
export function createVerificationCaseId(value: string): VerificationCaseId {
  if (!isVerificationCaseId(value)) {
    throw new TypeError('Verification case ID is not valid.');
  }
  return value;
}

/** Dựng `EvidenceId`. @throws TypeError khi giá trị không hợp lệ. */
export function createEvidenceId(value: string): EvidenceId {
  if (!isEvidenceId(value)) {
    throw new TypeError('Evidence ID is not valid.');
  }
  return value;
}

/** Text tự do hợp lệ: string đã trim, không rỗng, không quá `MAX_SELLER_TEXT_LENGTH`. */
export function isSellerText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SELLER_TEXT_LENGTH &&
    value.trim() === value
  );
}

/**
 * Opaque label (policy, type, kind, legalType, taxResidency).
 *
 * Đây là **dữ liệu cấu hình** do caller cấp, không phải enum của lib. Lib
 * validate hình dạng, không liệt kê giá trị hợp lệ.
 */
export function isOpaqueLabel(value: unknown): value is string {
  return isOpaqueId(value);
}
