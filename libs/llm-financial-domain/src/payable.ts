/**
 * Seller payable — nghĩa vụ phải trả cho seller, tách khỏi payout.
 *
 * Bốn bất biến liên quan:
 *
 * - **Payable ≠ payout** (invariant 9): payable không có beneficiary, không có
 *   fiat disbursement. `paid` chỉ là state sau khi caller cấp **bằng chứng
 *   payout** opaque; `payout`/`payment` sở hữu việc thực thi và bằng chứng đó.
 * - **Payable ≠ provider cost** (invariant 8): payable là phần seller nhận từ
 *   customer charge. Provider cost là đại lượng độc lập, ownership còn OPEN, và
 *   không có kiểu nào ở đây đại diện cho nó.
 * - **Append-only**: mỗi transition là một record version mới cùng `payable_id`;
 *   không sửa record cũ. `latestPayable` trả version cao nhất.
 * - **Hold ≠ restriction** (ADR-0007): một settlement hold chặn `settle` của
 *   đúng kỳ; account hold chặn mọi kỳ. Hold không xoá earnings và không chặn
 *   seller đăng nhập/publish.
 *
 * State machine (§4.4): `accrued → settled → paid | adjusted`.
 */

import type { FinancialBook } from './book';
import {
  hasBlockingHold,
  isSellerPayable,
  latestPayable,
  type PayableState,
  type SellerPayable,
} from './records';
import { isMoney, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type ChargeId,
  type FencingToken,
  type FinancialResult,
  type PayableId,
  type PayoutEvidenceRef,
  type SettlementId,
  type TenantRef,
} from './shared';

/** Input của `accruePayable`. */
export interface AccruePayableInput {
  readonly payableId: string;
  readonly sellerTenant: string;
  readonly amount: Money<'EC'>;
  readonly period: string;
  readonly availableAt: number;
  readonly accruedAt: number;
  readonly settlementId: string | null;
  readonly chargeId: string | null;
  readonly fencingToken: string;
}

/** Kết quả của một operation payable. */
export interface PayableOutcome {
  readonly book: FinancialBook;
  readonly payable: SellerPayable;
  readonly replayed: boolean;
}

/** Thêm record payable mới vào book. */
function appendPayable(book: FinancialBook, payable: SellerPayable): FinancialBook {
  return Object.freeze({
    ...book,
    payables: freezeArray([...book.payables, payable]),
  });
}

/** Đọc version mới nhất của một payable, trả domain error nếu không có. */
export function currentPayable(
  book: FinancialBook,
  payableId: PayableId,
): FinancialResult<SellerPayable> {
  const payable = latestPayable(book.payables, payableId);
  return payable === null ? financialFailure('payable_not_found') : financialOk(payable);
}

/**
 * Ghi nhận earnings đã phát sinh (`accrued`).
 *
 * `period` và `availableAt` do caller cấp: ADR-0007 chốt policy theo calendar
 * month và ngày 20, nhưng domain không đọc đồng hồ và không tính lịch; nó chỉ
 * giữ mốc caller đã tính. `amount` là earnings của seller sau mọi split policy
 * — split/commission/tax không thuộc lib này (ADR-0008).
 */
export function accruePayable(
  book: FinancialBook,
  input: AccruePayableInput,
): FinancialResult<PayableOutcome> {
  if (
    !isOpaqueId(input.payableId) ||
    !isOpaqueId(input.sellerTenant) ||
    !isOpaqueId(input.period) ||
    !isOpaqueId(input.fencingToken) ||
    !isEpochMillis(input.availableAt) ||
    !isEpochMillis(input.accruedAt) ||
    (input.settlementId !== null && !isOpaqueId(input.settlementId)) ||
    (input.chargeId !== null && !isOpaqueId(input.chargeId)) ||
    !isMoney(input.amount) ||
    input.amount.denomination !== 'EC'
  ) {
    return financialFailure('invalid_payable');
  }
  if (input.amount.minor <= 0n) {
    return financialFailure('invalid_amount');
  }
  const existing = latestPayable(book.payables, input.payableId as PayableId);
  if (existing !== null) {
    if (
      existing.seller_tenant !== input.sellerTenant ||
      existing.period !== input.period ||
      existing.amount.minor !== input.amount.minor
    ) {
      return financialFailure('idempotency_conflict');
    }
    if (existing.state !== 'accrued') {
      // Cùng payload nhưng payable đã đi tiếp (`settled`/`paid`/`adjusted`):
      // không phải xung đột idempotency mà là một accrual đã được xử lý.
      return financialFailure('invalid_payable_transition');
    }
    return financialOk(Object.freeze({ book, payable: existing, replayed: true }));
  }
  const payable: SellerPayable = Object.freeze({
    payable_id: input.payableId as PayableId,
    version: 1,
    seller_tenant: input.sellerTenant as TenantRef,
    denomination: 'EC',
    amount: input.amount,
    state: 'accrued',
    period: input.period,
    available_at: input.availableAt,
    accrued_at: input.accruedAt,
    settled_at: null,
    paid_at: null,
    payout_evidence_ref: null,
    settlement_id: input.settlementId as SettlementId | null,
    charge_id: input.chargeId as ChargeId | null,
    fencing_token: input.fencingToken as FencingToken,
  });
  if (!isSellerPayable(payable)) {
    return financialFailure('invalid_payable');
  }
  return financialOk(
    Object.freeze({ book: appendPayable(book, payable), payable, replayed: false }),
  );
}

/** Input của `settlePayable`. */
export interface SettlePayableInput {
  readonly payableId: string;
  readonly settledAt: number;
  readonly fencingToken: string;
}

/**
 * Chuyển payable `accrued → settled`.
 *
 * Từ chối khi còn hold đang hiệu lực cho Seller tenant/kỳ (`payable_on_hold`) —
 * hold là điều kiện chặn settlement, không phải một cờ trang trí. Từ chối khi
 * chưa tới `available_at`: earnings chưa available thì chưa được settle, và
 * domain không tự đọc lịch để quyết định thay.
 */
export function settlePayable(
  book: FinancialBook,
  input: SettlePayableInput,
): FinancialResult<PayableOutcome> {
  const found = currentPayable(book, input.payableId as PayableId);
  if (!found.ok) {
    return found;
  }
  const payable = found.value;
  if (payable.state === 'settled') {
    return financialOk(Object.freeze({ book, payable, replayed: true }));
  }
  if (payable.state !== 'accrued') {
    return financialFailure('invalid_payable_transition');
  }
  if (!isEpochMillis(input.settledAt) || !isOpaqueId(input.fencingToken)) {
    return financialFailure('invalid_epoch_millis');
  }
  if (input.settledAt < payable.available_at) {
    return financialFailure('invalid_payable_transition');
  }
  if (hasBlockingHold(book.holds, payable.seller_tenant, payable.period, input.settledAt)) {
    return financialFailure('payable_on_hold');
  }
  const next: SellerPayable = Object.freeze({
    ...payable,
    version: payable.version + 1,
    state: 'settled',
    settled_at: input.settledAt,
    fencing_token: input.fencingToken as FencingToken,
  });
  return financialOk(
    Object.freeze({ book: appendPayable(book, next), payable: next, replayed: false }),
  );
}

/** Input của `markPayablePaid`. */
export interface MarkPayablePaidInput {
  readonly payableId: string;
  readonly paidAt: number;
  readonly payoutEvidenceRef: string;
  readonly fencingToken: string;
}

/**
 * Chuyển payable `settled → paid`.
 *
 * Đòi **bằng chứng payout** (opaque reference tới execution evidence do
 * `payout`/`payment` sở hữu). Không có evidence thì từ chối
 * (`payout_evidence_required`): request timeout hoặc sự tồn tại của một payout
 * request không chứng minh tiền đã được chi.
 */
export function markPayablePaid(
  book: FinancialBook,
  input: MarkPayablePaidInput,
): FinancialResult<PayableOutcome> {
  const found = currentPayable(book, input.payableId as PayableId);
  if (!found.ok) {
    return found;
  }
  const payable = found.value;
  if (payable.state === 'paid') {
    if (payable.payout_evidence_ref === input.payoutEvidenceRef) {
      return financialOk(Object.freeze({ book, payable, replayed: true }));
    }
    return financialFailure('idempotency_conflict');
  }
  if (payable.state !== 'settled') {
    return financialFailure('invalid_payable_transition');
  }
  if (!isOpaqueId(input.payoutEvidenceRef)) {
    return financialFailure('payout_evidence_required');
  }
  if (!isEpochMillis(input.paidAt) || !isOpaqueId(input.fencingToken)) {
    return financialFailure('invalid_epoch_millis');
  }
  const next: SellerPayable = Object.freeze({
    ...payable,
    version: payable.version + 1,
    state: 'paid',
    paid_at: input.paidAt,
    payout_evidence_ref: input.payoutEvidenceRef as PayoutEvidenceRef,
    fencing_token: input.fencingToken as FencingToken,
  });
  return financialOk(
    Object.freeze({ book: appendPayable(book, next), payable: next, replayed: false }),
  );
}

/** Input của `adjustPayable`. */
export interface AdjustPayableInput {
  readonly payableId: string;
  readonly amount: Money<'EC'>;
  readonly reasonRef: string;
  readonly adjustedAt: number;
  readonly fencingToken: string;
}

/**
 * Điều chỉnh payable bằng một version mới (`adjusted`).
 *
 * Đây là **transition**, không phải mutation: record cũ giữ nguyên amount/state,
 * record mới mang amount đã sửa. Chỉ áp dụng cho `accrued` hoặc `settled`; một
 * payable đã `paid` cần correction riêng qua payout flow, không sửa tại đây.
 */
export function adjustPayable(
  book: FinancialBook,
  input: AdjustPayableInput,
): FinancialResult<PayableOutcome> {
  const found = currentPayable(book, input.payableId as PayableId);
  if (!found.ok) {
    return found;
  }
  const payable = found.value;
  // `adjusted` và `paid` đều là trạng thái cuối của nhánh tương ứng: §5 của
  // `03-domain-design.md` chỉ cho `accrued | settled → adjusted`. Điều chỉnh một
  // bản đã adjusted sẽ tạo chuỗi version không có transition hợp lệ nào sinh ra.
  if (payable.state !== 'accrued' && payable.state !== 'settled') {
    return financialFailure('invalid_payable_transition');
  }
  if (
    !isMoney(input.amount) ||
    input.amount.denomination !== 'EC' ||
    input.amount.minor <= 0n ||
    !isOpaqueId(input.reasonRef) ||
    !isEpochMillis(input.adjustedAt) ||
    !isOpaqueId(input.fencingToken)
  ) {
    return financialFailure('invalid_adjustment');
  }
  const next: SellerPayable = Object.freeze({
    ...payable,
    version: payable.version + 1,
    amount: input.amount,
    state: 'adjusted',
    fencing_token: input.fencingToken as FencingToken,
  });
  return financialOk(
    Object.freeze({ book: appendPayable(book, next), payable: next, replayed: false }),
  );
}

/** Trạng thái hiện tại của một payable — dùng trong test và projection. */
export function payableState(payable: SellerPayable): PayableState {
  return payable.state;
}
