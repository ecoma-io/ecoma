/**
 * Taxonomy lỗi của tầng domain `llm-financial`.
 *
 * Pattern: `libs/llm-seller-pricing-domain/src/errors.ts` — một domain error chỉ mang
 * `code` ổn định + `message` tiếng Anh ngắn gọn. Không field nào cho identifier,
 * token, secret hay payload tuỳ ý: error object đi thẳng ra log/response nên nó
 * là nơi rò rỉ dữ liệu dễ nhất.
 *
 * Message là runtime string nên viết bằng English theo language policy; comment
 * và JSDoc viết bằng tiếng Việt.
 */

/** Mã lỗi ổn định — contract với consumer, không đổi nghĩa theo thời gian. */
export type LlmFinancialDomainErrorCode =
  | 'invalid_id'
  | 'invalid_amount'
  | 'invalid_denomination'
  | 'denomination_mismatch'
  | 'amount_overflow'
  | 'invalid_epoch_millis'
  | 'invalid_fencing_token'
  | 'stale_fencing_token'
  | 'invalid_idempotency_key'
  | 'invalid_ledger_transaction'
  | 'unbalanced_transaction'
  | 'invalid_ledger_account'
  | 'invalid_ledger_reference'
  | 'idempotency_conflict'
  | 'insufficient_funds'
  | 'insufficient_available_balance'
  | 'insufficient_held_balance'
  | 'insufficient_charged_balance'
  | 'invalid_wallet'
  | 'wallet_not_found'
  | 'wallet_invariant_violation'
  | 'deposit_not_found'
  | 'invalid_deposit_transition'
  | 'invalid_reservation'
  | 'reservation_not_found'
  | 'reservation_already_finalized'
  | 'remainder_release_required'
  | 'invalid_settlement'
  | 'invalid_charge'
  | 'invalid_charge_transition'
  | 'charge_not_found'
  | 'refund_exceeds_charge'
  | 'invalid_refund'
  | 'invalid_adjustment'
  | 'invalid_payable'
  | 'payable_not_found'
  | 'payable_on_hold'
  | 'invalid_payable_transition'
  | 'payout_evidence_required'
  | 'invalid_hold'
  | 'hold_not_found'
  | 'invalid_budget_lease'
  | 'budget_lease_not_found'
  | 'escrow_not_found'
  | 'lease_not_stale'
  | 'reconciliation_required'
  | 'invalid_conversion'
  | 'invalid_conversion_ratio'
  | 'conversion_authorization_missing'
  | 'conversion_authorization_mismatch'
  | 'conversion_not_exact'
  | 'conversion_source_unavailable'
  | 'invalid_reconciliation'
  | 'sponsor_not_found'
  | 'funding_authorization_not_found'
  | 'funding_authorization_required'
  | 'sponsor_ceiling_exceeded'
  | 'authorization_ceiling_exceeded'
  | 'grant_not_found'
  | 'invalid_grant_transition';

/**
 * Bảng message canonical — nguồn duy nhất của factory.
 *
 * Freeze để call site không thể sửa message và làm lệch bảng mà
 * `isLlmFinancialDomainError` dùng để nhận diện lỗi do factory sinh ra.
 */
export const LLM_FINANCIAL_DOMAIN_ERROR_MESSAGES: Record<LlmFinancialDomainErrorCode, string> =
  Object.freeze({
    invalid_id: 'Identifier is not a valid opaque identifier.',
    invalid_amount: 'Monetary amount is not valid.',
    invalid_denomination: 'Denomination is not valid.',
    denomination_mismatch: 'Monetary amounts use different denominations.',
    amount_overflow: 'Monetary arithmetic exceeded the supported magnitude.',
    invalid_epoch_millis: 'Timestamp is not valid epoch milliseconds.',
    invalid_fencing_token: 'Fencing token is not valid.',
    stale_fencing_token: 'Fencing token is older than the ledger watermark for this wallet.',
    invalid_idempotency_key: 'Idempotency key is not valid.',
    invalid_ledger_transaction: 'Ledger transaction is not valid.',
    unbalanced_transaction: 'Ledger transaction debit and credit legs do not balance.',
    invalid_ledger_account: 'Ledger account is not part of the canonical account vocabulary.',
    invalid_ledger_reference: 'Ledger reference is not valid.',
    idempotency_conflict: 'The idempotency key was already used with a different payload.',
    insufficient_funds: 'The balance is not sufficient for this operation.',
    insufficient_available_balance: 'Available balance is not sufficient for this operation.',
    insufficient_held_balance: 'Held balance is not sufficient for this operation.',
    insufficient_charged_balance: 'Charged balance is not sufficient for this operation.',
    invalid_wallet: 'Wallet structure or balance invariant is not valid.',
    wallet_not_found: 'Wallet was not found in the account.',
    wallet_invariant_violation:
      'Wallet balances violate available plus held plus charged equals total.',
    deposit_not_found: 'Deposit was not found in the wallet.',
    invalid_deposit_transition: 'Deposit state transition is not allowed.',
    invalid_reservation: 'Reservation is not valid.',
    reservation_not_found: 'Reservation was not found in the account.',
    reservation_already_finalized: 'Reservation is already captured or released.',
    remainder_release_required: 'A partial capture requires an explicit release of the remainder.',
    invalid_settlement: 'Settlement is not valid.',
    invalid_charge: 'Customer charge is not valid.',
    invalid_charge_transition: 'Customer charge state transition is not allowed.',
    charge_not_found: 'Customer charge was not found in the account.',
    refund_exceeds_charge: 'Refund exceeds the refundable amount of the charge.',
    invalid_refund: 'Refund is not valid.',
    invalid_adjustment: 'Adjustment is not valid.',
    invalid_payable: 'Seller payable is not valid.',
    payable_not_found: 'Seller payable was not found in the register.',
    payable_on_hold: 'Seller payable settlement is blocked by an active hold.',
    invalid_payable_transition: 'Seller payable state transition is not allowed.',
    payout_evidence_required: 'Payout evidence is required to mark a payable as paid.',
    invalid_hold: 'Financial hold is not valid.',
    hold_not_found: 'Financial hold was not found.',
    invalid_budget_lease: 'Budget lease is not valid.',
    budget_lease_not_found: 'Budget lease was not found.',
    escrow_not_found: 'Budget escrow was not found.',
    lease_not_stale: 'Budget lease is not stale, so its escrow cannot be reallocated.',
    reconciliation_required: 'The operation requires a completed reconciliation step.',
    invalid_conversion: 'EC to UC conversion is not valid.',
    invalid_conversion_ratio: 'Conversion ratio is not a valid positive exact ratio.',
    conversion_authorization_missing: 'EC to UC conversion requires dual authorization evidence.',
    conversion_authorization_mismatch:
      'Dual authorization evidence does not match the conversion parties.',
    conversion_not_exact: 'Conversion ratio does not produce an exact integer amount.',
    conversion_source_unavailable: 'Source EC is held, reserved, or insufficient for conversion.',
    invalid_reconciliation: 'Reconciliation input is not valid.',
    sponsor_not_found: 'Sponsor was not found in the book.',
    funding_authorization_not_found: 'Sponsor funding authorization was not found in the book.',
    funding_authorization_required:
      'Sponsor funding requires an active sponsor and an active funding authorization.',
    sponsor_ceiling_exceeded: 'Sponsor grant exceeds the sponsor funding ceiling.',
    authorization_ceiling_exceeded:
      'Sponsor grant exceeds the funding authorization ceiling for this billing account.',
    grant_not_found: 'Sponsor grant was not found in the book.',
    invalid_grant_transition: 'Sponsor grant state transition is not allowed.',
  });

/** Error domain: `code` ổn định + `message` tiếng Anh ngắn gọn. */
export interface LlmFinancialDomainError {
  readonly code: LlmFinancialDomainErrorCode;
  readonly message: string;
}

/**
 * Dựng domain error từ mã. Đây là constructor duy nhất của taxonomy: chỉ ghép
 * `code` với message lấy từ bảng canonical, không nhận dữ liệu call site.
 *
 * @throws TypeError nếu `code` không có trong taxonomy.
 */
export function llmFinancialDomainError(
  code: LlmFinancialDomainErrorCode,
): LlmFinancialDomainError {
  const message = Object.hasOwn(LLM_FINANCIAL_DOMAIN_ERROR_MESSAGES, code)
    ? LLM_FINANCIAL_DOMAIN_ERROR_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    throw new TypeError(`LLM Financial domain error code is not valid: ${String(code)}`);
  }
  return Object.freeze({ code, message });
}

/**
 * Type guard: object có đúng hai field `code` + `message`, và message khớp
 * nguyên văn bảng canonical. Khớp nguyên văn biến guard thành kiểm "error này do
 * factory sinh ra", nên một object dựng lại từ log/cache không lọt qua.
 */
export function isLlmFinancialDomainError(value: unknown): value is LlmFinancialDomainError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const ownKeys = Object.keys(value);
  if (ownKeys.length !== 2 || !ownKeys.includes('code') || !ownKeys.includes('message')) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  if (typeof candidate.code !== 'string') {
    return false;
  }
  const expected = Object.hasOwn(LLM_FINANCIAL_DOMAIN_ERROR_MESSAGES, candidate.code)
    ? LLM_FINANCIAL_DOMAIN_ERROR_MESSAGES[candidate.code as LlmFinancialDomainErrorCode]
    : undefined;
  return expected !== undefined && candidate.message === expected;
}
