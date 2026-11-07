/**
 * Taxonomy lỗi của tầng domain `llm-seller-governance`.
 *
 * Pattern: `libs/llm-consumer-tenant-domain/src/errors.ts` và
 * `libs/llm-seller-pricing-domain/src/errors.ts` — một domain error chỉ mang
 * `code` ổn định + `message` ngắn gọn, không field nào cho identifier thật,
 * reason nội bộ hay payload tuỳ ý.
 *
 * Bảng mã này là **của riêng** governance: ADR-0018 chốt rằng governance khai
 * báo result type, error table và error code độc lập, không tái dùng mã của
 * `llm-seller-tenant`. Một mã chỉ tồn tại ở context thực sự sở hữu hành vi
 * sinh ra nó.
 *
 * Message là ENGLISH theo language policy của repo: đây là runtime string,
 * không phải documentation.
 */

/** Mã lỗi ổn định — contract với consumer, không đổi nghĩa theo thời gian. */
export type LlmGovernanceDomainErrorCode =
  // Định danh và validate.
  | 'invalid_seller_tenant_id'
  | 'invalid_actor'
  | 'invalid_timestamp'
  | 'invalid_restriction_id'
  | 'invalid_restriction_record'
  | 'invalid_restriction_window'
  | 'invalid_appeal_id'
  | 'invalid_verification_case_id'
  | 'invalid_evidence_id'
  | 'invalid_evidence_reference'
  | 'invalid_profile_version'
  | 'invalid_profile_field'
  | 'invalid_effective_from'
  // Ngữ cảnh.
  | 'ambiguous_context'
  | 'inconsistent_context'
  // Restriction.
  | 'duplicate_restriction_id'
  | 'restriction_already_lifted'
  | 'restriction_not_effective'
  | 'restriction_not_in_tenant'
  // Appeal.
  | 'duplicate_appeal_id'
  | 'invalid_appeal_record'
  | 'appeal_deadline_passed'
  | 'appeal_actor_not_eligible'
  | 'invalid_appeal_transition'
  | 'invalid_decision_reason'
  | 'invalid_decision'
  | 'missing_public_decision_reason'
  // Verification, evidence.
  | 'duplicate_verification_case_id'
  | 'invalid_verification_case'
  | 'invalid_verification_type'
  | 'invalid_submission_id'
  | 'duplicate_submission_id'
  | 'invalid_verification_transition'
  | 'evidence_missing'
  | 'duplicate_evidence'
  | 'evidence_not_in_tenant'
  | 'duplicate_evidence_reference_id'
  // Profile.
  | 'effective_from_not_increasing';

/**
 * Message của từng mã — bảng đọc nguồn duy nhất của factory. Message là
 * ENGLISH: runtime string không viết tiếng Việt.
 *
 * Freeze: consumer chỉ được **đọc** bảng này. Không freeze thì một call site
 * có thể sửa message và mọi error sinh ra sau đó mang text không canonical.
 */
export const LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES: Record<LlmGovernanceDomainErrorCode, string> =
  Object.freeze({
    invalid_seller_tenant_id: 'Seller tenant ID is not valid.',
    invalid_actor: 'Actor account ID is not valid.',
    invalid_timestamp: 'Timestamp is not a valid epoch millisecond value.',
    invalid_restriction_id: 'Restriction ID is not valid.',
    invalid_restriction_record: 'Restriction record is not valid.',
    invalid_restriction_window: 'The restriction validity window is not valid.',
    invalid_appeal_id: 'Appeal ID is not valid.',
    invalid_verification_case_id: 'Verification case ID is not valid.',
    invalid_evidence_id: 'Evidence ID is not valid.',
    invalid_evidence_reference: 'Evidence reference is not valid.',
    invalid_profile_version: 'Profile version is not valid.',
    invalid_profile_field: 'Profile field is not valid.',
    invalid_effective_from: 'Profile effective time is not valid.',
    ambiguous_context: 'The domain context is ambiguous.',
    inconsistent_context: 'The domain context is inconsistent with the tenant.',
    duplicate_restriction_id: 'The restriction ID is duplicated in the tenant.',
    restriction_already_lifted: 'The restriction has already been lifted.',
    restriction_not_effective: 'The restriction is not effective at the given time.',
    restriction_not_in_tenant: 'The restriction does not belong to the tenant.',
    duplicate_appeal_id: 'The appeal ID is duplicated in the tenant.',
    invalid_appeal_record: 'The appeal record is not valid.',
    appeal_deadline_passed: 'The appeal deadline has passed.',
    appeal_actor_not_eligible: 'The actor is not eligible to submit an appeal.',
    invalid_appeal_transition: 'The appeal state transition is not allowed.',
    invalid_decision_reason: 'The decision reason is not valid.',
    invalid_decision: 'The decision is not valid.',
    missing_public_decision_reason: 'A public decision reason is required.',
    duplicate_verification_case_id: 'The verification case ID is duplicated in the tenant.',
    invalid_verification_case: 'The verification case is not valid.',
    invalid_verification_type: 'The verification type is not valid.',
    invalid_submission_id: 'The verification submission ID is not valid.',
    duplicate_submission_id: 'The submission ID is duplicated for this verification case.',
    invalid_verification_transition: 'The verification state transition is not allowed.',
    evidence_missing: 'At least one evidence reference is required.',
    duplicate_evidence: 'The evidence reference is duplicated in the submission.',
    evidence_not_in_tenant: 'The evidence reference does not belong to the tenant.',
    duplicate_evidence_reference_id: 'The evidence reference ID is duplicated in the tenant.',
    effective_from_not_increasing:
      'The effective time must be strictly later than the previous profile version.',
  });

/** Error domain: `code` ổn định + `message` ngắn gọn. */
export interface LlmGovernanceDomainError {
  readonly code: LlmGovernanceDomainErrorCode;
  readonly message: string;
}

/**
 * Dựng domain error. Constructor duy nhất của taxonomy: chỉ ghép `code` với
 * message lấy từ `LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES`, không có chỗ nào lọt
 * dữ liệu call site.
 *
 * @throws TypeError nếu `code` không có trong taxonomy.
 */
export function llmGovernanceDomainError(
  code: LlmGovernanceDomainErrorCode,
): LlmGovernanceDomainError {
  const message = Object.hasOwn(LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES, code)
    ? LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    throw new TypeError(`LLM governance domain error code is not valid: ${String(code)}`);
  }
  return Object.freeze({ code, message });
}

/**
 * Type guard: có phải object mang `code` thuộc taxonomy không.
 *
 * Dùng `Object.hasOwn`, không dùng `in`: `in` đi cả prototype chain nên
 * `{ code: 'toString' }` sẽ lọt guard trong khi factory ném `TypeError`.
 */
export function isLlmGovernanceDomainError(value: unknown): value is LlmGovernanceDomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== 2 || !ownKeys.includes('code') || !ownKeys.includes('message')) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string' || !Object.hasOwn(LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES, code)) {
    return false;
  }
  return (
    (value as { message?: unknown }).message ===
    LLM_GOVERNANCE_DOMAIN_ERROR_MESSAGES[code as LlmGovernanceDomainErrorCode]
  );
}
