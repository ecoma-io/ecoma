/**
 * Taxonomy lỗi của tầng domain `llm-inference`.
 *
 * Pattern: `libs/llm-consumer-tenant-domain/src/errors.ts` và
 * `libs/llm-consumer-routing-domain/src/errors.ts` — một domain error chỉ mang `code` ổn
 * định + `message` ngắn gọn, không field nào cho identifier thật, provider
 * model, endpoint, prompt/response hay payload tuỳ ý. Error object đi thẳng ra
 * log và response, nên nó là nơi rò rỉ dễ nhất.
 *
 * Message là ENGLISH theo language policy của repo: đây là runtime string,
 * không phải documentation.
 */

/**
 * Mã lỗi ổn định — contract với consumer, không đổi nghĩa theo thời gian.
 *
 * Tám mã `request_closed`, `requires_reconciliation`, `attempt_in_flight`,
 * `client_output_committed`, `deadline_exhausted`, `attempts_exhausted`,
 * `previous_attempt_uncertain`, `previous_attempt_completed` trùng tên với
 * `RetryRejectionReason`: cùng một lý do, một vocabulary.
 */
export type InferenceDomainErrorCode =
  | 'invalid_request_id'
  | 'invalid_attempt_id'
  | 'invalid_candidate_ref'
  | 'invalid_timestamp'
  | 'invalid_attempt_limit'
  | 'invalid_deadline'
  | 'invalid_evidence'
  | 'invalid_evidence_transition'
  | 'invalid_delivery_transition'
  | 'invalid_cancellation_reason'
  | 'duplicate_attempt_id'
  | 'attempt_not_found'
  | 'attempt_in_flight'
  | 'attempt_not_in_flight'
  | 'request_closed'
  | 'requires_reconciliation'
  | 'client_output_committed'
  | 'inconsistent_execution_state'
  | 'timestamp_regression'
  | 'deadline_exhausted'
  | 'attempts_exhausted'
  | 'previous_attempt_uncertain'
  | 'previous_attempt_completed'
  | 'no_uncertainty_to_reconcile'
  | 'uncertain_execution_unresolved'
  | 'completion_requires_completed_attempt'
  | 'reconciliation_not_pending'
  | 'attempt_not_uncertain'
  | 'reconciliation_requires_confirmation';

/**
 * Message của từng mã — nguồn duy nhất của factory. Message là ENGLISH:
 * runtime string không viết tiếng Việt.
 *
 * Freeze: consumer chỉ được **đọc** bảng này. Không freeze thì một call site
 * có thể sửa message và mọi error sinh ra sau đó mang text không canonical.
 */
export const INFERENCE_DOMAIN_ERROR_MESSAGES: Record<InferenceDomainErrorCode, string> =
  Object.freeze({
    invalid_request_id: 'Request ID is not valid.',
    invalid_attempt_id: 'Attempt ID is not valid.',
    invalid_candidate_ref: 'The routing candidate reference is not valid.',
    invalid_timestamp: 'Timestamp is not a valid epoch millisecond value.',
    invalid_attempt_limit: 'The attempt limit is not a positive integer.',
    invalid_deadline: 'The request deadline is not valid.',
    invalid_evidence: 'The execution evidence value is not valid.',
    invalid_evidence_transition: 'The execution evidence transition is not allowed.',
    invalid_delivery_transition: 'The client delivery transition is not allowed.',
    invalid_cancellation_reason: 'The cancellation reason is not valid.',
    duplicate_attempt_id: 'The attempt ID is already used with different facts.',
    attempt_not_found: 'The provider attempt does not belong to this logical request.',
    attempt_in_flight: 'A provider attempt is still open for this logical request.',
    attempt_not_in_flight: 'The provider attempt is already closed.',
    request_closed: 'The logical request is already closed.',
    requires_reconciliation: 'The logical request must be reconciled before it can continue.',
    client_output_committed: 'Client-visible output was already committed.',
    inconsistent_execution_state: 'The operation is inconsistent with the execution state.',
    timestamp_regression: 'The timestamp precedes a fact already recorded.',
    deadline_exhausted: 'The request deadline has passed.',
    attempts_exhausted: 'The attempt budget is exhausted.',
    previous_attempt_uncertain: 'The previous attempt may have executed without confirmation.',
    previous_attempt_completed: 'The previous attempt is already confirmed completed.',
    no_uncertainty_to_reconcile: 'No uncertain attempt is awaiting reconciliation.',
    uncertain_execution_unresolved: 'An attempt may have executed without confirmation.',
    completion_requires_completed_attempt: 'Completion requires a confirmed provider completion.',
    reconciliation_not_pending: 'The logical request is not awaiting reconciliation.',
    attempt_not_uncertain: 'The provider attempt is not uncertain.',
    reconciliation_requires_confirmation:
      'Reconciliation requires authoritative provider confirmation.',
  });

/** Error domain: `code` ổn định + `message` ngắn gọn. */
export interface InferenceDomainError {
  readonly code: InferenceDomainErrorCode;
  readonly message: string;
}

/**
 * Dựng domain error. Constructor duy nhất của taxonomy: chỉ ghép `code` với
 * message lấy từ `INFERENCE_DOMAIN_ERROR_MESSAGES`.
 *
 * @throws TypeError nếu `code` không có trong taxonomy.
 */
export function inferenceDomainError(code: InferenceDomainErrorCode): InferenceDomainError {
  const message = Object.hasOwn(INFERENCE_DOMAIN_ERROR_MESSAGES, code)
    ? INFERENCE_DOMAIN_ERROR_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    throw new TypeError(`LLM Inference domain error code is not valid: ${String(code)}`);
  }
  return { code, message };
}

/**
 * Type guard: có phải object mang `code` thuộc taxonomy không.
 *
 * Dùng `Object.hasOwn`, không dùng `in`: `in` đi cả prototype chain nên
 * `{ code: 'toString' }` sẽ lọt guard trong khi factory ném `TypeError`.
 */
export function isInferenceDomainError(value: unknown): value is InferenceDomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== 2 || !ownKeys.includes('code') || !ownKeys.includes('message')) {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && Object.hasOwn(INFERENCE_DOMAIN_ERROR_MESSAGES, code);
}
