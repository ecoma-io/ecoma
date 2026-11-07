/**
 * Kiến trúc dùng chung của domain library `llm-financial`.
 *
 * Mọi giá trị thời gian là epoch millis kiểu `number` do caller truyền vào —
 * domain không đọc đồng hồ (`Date.now()`), không parse RFC 3339, không sinh số
 * ngẫu nhiên, không sinh identifier. Mọi hàm là thuần: không sửa input, không
 * giữ state, và trả `FinancialResult` (`ok`/`error`) thay vì ném exception cho
 * dữ liệu đầu vào hỏng.
 *
 * Runtime string (error message) viết bằng English theo language policy của
 * repo.
 */

import {
  llmFinancialDomainError,
  type LlmFinancialDomainError,
  type LlmFinancialDomainErrorCode,
} from './errors';

// ---------------------------------------------------------------------------
// Kết quả
// ---------------------------------------------------------------------------

/** Nhánh thành công: mang giá trị đã validate và đã freeze. */
export interface FinancialOk<Value> {
  readonly ok: true;
  readonly value: Value;
}

/** Nhánh bị từ chối: mang đúng một domain error, không mang dữ liệu call site. */
export interface FinancialFailure {
  readonly ok: false;
  readonly error: LlmFinancialDomainError;
}

/** Kết quả của một operation domain. */
export type FinancialResult<Value> = FinancialOk<Value> | FinancialFailure;

/** Dựng nhánh thành công. */
export function financialOk<Value>(value: Value): FinancialResult<Value> {
  return Object.freeze({ ok: true, value });
}

/** Dựng nhánh bị từ chối từ một mã lỗi trong taxonomy. */
export function financialFailure<Value = never>(
  code: LlmFinancialDomainErrorCode,
): FinancialResult<Value> {
  return Object.freeze({ ok: false, error: llmFinancialDomainError(code) });
}

// ---------------------------------------------------------------------------
// Định danh
// ---------------------------------------------------------------------------

declare const opaqueBrand: unique symbol;

/** Chuỗi mang brand của một loại định danh — chỉ tồn tại ở tầng kiểu. */
type Branded<Name extends string> = string & { readonly [opaqueBrand]?: Name };

/** Định danh billing account. */
export type BillingAccountId = Branded<'BillingAccountId'>;
/** Định danh wallet. */
export type WalletId = Branded<'WalletId'>;
/** Định danh một lần nạp tiền (deposit/credit). */
export type DepositId = Branded<'DepositId'>;
/** Định danh reservation tài chính. */
export type ReservationId = Branded<'ReservationId'>;
/** Định danh settlement. */
export type SettlementId = Branded<'SettlementId'>;
/** Định danh customer charge. */
export type ChargeId = Branded<'ChargeId'>;
/** Định danh refund. */
export type RefundId = Branded<'RefundId'>;
/** Định danh seller payable. */
export type PayableId = Branded<'PayableId'>;
/** Định danh EC→UC conversion. */
export type ConversionId = Branded<'ConversionId'>;
/** Định danh ledger transaction. */
export type LedgerTransactionId = Branded<'LedgerTransactionId'>;
/** Định danh ledger entry (một leg trong transaction). */
export type LedgerEntryId = Branded<'LedgerEntryId'>;
/** Fencing token của operation đã sinh ra ledger entry. */
export type FencingToken = Branded<'FencingToken'>;
/** Idempotency key của một financial mutation. */
export type IdempotencyKey = Branded<'IdempotencyKey'>;
/** Tham chiếu opaque tới owner (workspace/customer) — không FK xuyên database. */
export type AccountOwnerRef = Branded<'AccountOwnerRef'>;
/** Tham chiếu opaque tới Seller tenant hoặc Console tenant. */
export type TenantRef = Branded<'TenantRef'>;
/** Tham chiếu opaque tới actor (`sub`) đã verified. */
export type ActorRef = Branded<'ActorRef'>;
/** Tham chiếu opaque tới bằng chứng payout — payout execution không thuộc lib này. */
export type PayoutEvidenceRef = Branded<'PayoutEvidenceRef'>;

/** Độ dài tối đa của mọi định danh/opaque reference để chặn payload bất thường. */
export const MAX_OPAQUE_ID_LENGTH = 200;

/**
 * Opaque identifier: chuỗi không rỗng, không có whitespace thừa ở hai đầu, và
 * không vượt `MAX_OPAQUE_ID_LENGTH`. Domain không diễn giải nội dung.
 */
export function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_ID_LENGTH &&
    value.trim() === value
  );
}

/** Type guard cho `BillingAccountId`. */
export function isBillingAccountId(value: unknown): value is BillingAccountId {
  return isOpaqueId(value);
}

/** Type guard cho `WalletId`. */
export function isWalletId(value: unknown): value is WalletId {
  return isOpaqueId(value);
}

/** Type guard cho `DepositId`. */
export function isDepositId(value: unknown): value is DepositId {
  return isOpaqueId(value);
}

/** Type guard cho `ReservationId`. */
export function isReservationId(value: unknown): value is ReservationId {
  return isOpaqueId(value);
}

/** Type guard cho `SettlementId`. */
export function isSettlementId(value: unknown): value is SettlementId {
  return isOpaqueId(value);
}

/** Type guard cho `ChargeId`. */
export function isChargeId(value: unknown): value is ChargeId {
  return isOpaqueId(value);
}

/** Type guard cho `RefundId`. */
export function isRefundId(value: unknown): value is RefundId {
  return isOpaqueId(value);
}

/** Type guard cho `PayableId`. */
export function isPayableId(value: unknown): value is PayableId {
  return isOpaqueId(value);
}

/** Type guard cho `ConversionId`. */
export function isConversionId(value: unknown): value is ConversionId {
  return isOpaqueId(value);
}

/** Type guard cho `LedgerTransactionId`. */
export function isLedgerTransactionId(value: unknown): value is LedgerTransactionId {
  return isOpaqueId(value);
}

/** Type guard cho `LedgerEntryId`. */
export function isLedgerEntryId(value: unknown): value is LedgerEntryId {
  return isOpaqueId(value);
}

/** Type guard cho `FencingToken`. */
export function isFencingToken(value: unknown): value is FencingToken {
  return isOpaqueId(value);
}

/** Type guard cho `IdempotencyKey`. */
export function isIdempotencyKey(value: unknown): value is IdempotencyKey {
  return isOpaqueId(value);
}

/** Type guard cho `AccountOwnerRef`. */
export function isAccountOwnerRef(value: unknown): value is AccountOwnerRef {
  return isOpaqueId(value);
}

/** Type guard cho `TenantRef`. */
export function isTenantRef(value: unknown): value is TenantRef {
  return isOpaqueId(value);
}

/** Type guard cho `ActorRef`. */
export function isActorRef(value: unknown): value is ActorRef {
  return isOpaqueId(value);
}

/** Type guard cho `PayoutEvidenceRef`. */
export function isPayoutEvidenceRef(value: unknown): value is PayoutEvidenceRef {
  return isOpaqueId(value);
}

/**
 * Dựng một định danh đã validate.
 * @throws TypeError khi giá trị không phải opaque ID hợp lệ.
 */
function createOpaqueId<Name extends string>(value: string, label: string): Branded<Name> {
  if (!isOpaqueId(value)) {
    throw new TypeError(`${label} must be a non-empty, trimmed opaque string.`);
  }
  return value;
}

/** Dựng `BillingAccountId`. @throws TypeError khi giá trị không hợp lệ. */
export function createBillingAccountId(value: string): BillingAccountId {
  return createOpaqueId(value, 'Billing account ID');
}

/** Dựng `WalletId`. @throws TypeError khi giá trị không hợp lệ. */
export function createWalletId(value: string): WalletId {
  return createOpaqueId(value, 'Wallet ID');
}

/** Dựng `DepositId`. @throws TypeError khi giá trị không hợp lệ. */
export function createDepositId(value: string): DepositId {
  return createOpaqueId(value, 'Deposit ID');
}

/** Dựng `ReservationId`. @throws TypeError khi giá trị không hợp lệ. */
export function createReservationId(value: string): ReservationId {
  return createOpaqueId(value, 'Reservation ID');
}

/** Dựng `SettlementId`. @throws TypeError khi giá trị không hợp lệ. */
export function createSettlementId(value: string): SettlementId {
  return createOpaqueId(value, 'Settlement ID');
}

/** Dựng `ChargeId`. @throws TypeError khi giá trị không hợp lệ. */
export function createChargeId(value: string): ChargeId {
  return createOpaqueId(value, 'Charge ID');
}

/** Dựng `RefundId`. @throws TypeError khi giá trị không hợp lệ. */
export function createRefundId(value: string): RefundId {
  return createOpaqueId(value, 'Refund ID');
}

/** Dựng `PayableId`. @throws TypeError khi giá trị không hợp lệ. */
export function createPayableId(value: string): PayableId {
  return createOpaqueId(value, 'Payable ID');
}

/** Dựng `ConversionId`. @throws TypeError khi giá trị không hợp lệ. */
export function createConversionId(value: string): ConversionId {
  return createOpaqueId(value, 'Conversion ID');
}

/** Dựng `LedgerTransactionId`. @throws TypeError khi giá trị không hợp lệ. */
export function createLedgerTransactionId(value: string): LedgerTransactionId {
  return createOpaqueId(value, 'Ledger transaction ID');
}

/** Dựng `LedgerEntryId`. @throws TypeError khi giá trị không hợp lệ. */
export function createLedgerEntryId(value: string): LedgerEntryId {
  return createOpaqueId(value, 'Ledger entry ID');
}

/** Dựng `FencingToken`. @throws TypeError khi giá trị không hợp lệ. */
export function createFencingToken(value: string): FencingToken {
  return createOpaqueId(value, 'Fencing token');
}

/** Dựng `IdempotencyKey`. @throws TypeError khi giá trị không hợp lệ. */
export function createIdempotencyKey(value: string): IdempotencyKey {
  return createOpaqueId(value, 'Idempotency key');
}

/** Dựng `AccountOwnerRef`. @throws TypeError khi giá trị không hợp lệ. */
export function createAccountOwnerRef(value: string): AccountOwnerRef {
  return createOpaqueId(value, 'Account owner reference');
}

/** Dựng `TenantRef`. @throws TypeError khi giá trị không hợp lệ. */
export function createTenantRef(value: string): TenantRef {
  return createOpaqueId(value, 'Tenant reference');
}

/** Dựng `ActorRef`. @throws TypeError khi giá trị không hợp lệ. */
export function createActorRef(value: string): ActorRef {
  return createOpaqueId(value, 'Actor reference');
}

/** Dựng `PayoutEvidenceRef`. @throws TypeError khi giá trị không hợp lệ. */
export function createPayoutEvidenceRef(value: string): PayoutEvidenceRef {
  return createOpaqueId(value, 'Payout evidence reference');
}

// ---------------------------------------------------------------------------
// Thời gian và cấu trúc
// ---------------------------------------------------------------------------

/**
 * Epoch millis hợp lệ: số nguyên an toàn.
 *
 * Dùng `Number.isSafeInteger` chứ không chỉ `Number.isFinite`: một mốc ngoài
 * miền số nguyên an toàn đã mất chính xác, nên mọi so sánh thời gian dựa trên
 * nó không còn đúng. Domain không có "hiện tại" để so, nên miền âm vẫn hợp lệ.
 */
export function isEpochMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Kiểm một giá trị là object thường (không `null`, không mảng). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Freeze một mảng thành readonly array mới (không giữ tham chiếu mutable). */
export function freezeArray<Value>(items: readonly Value[]): readonly Value[] {
  return Object.freeze([...items]);
}
