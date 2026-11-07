/**
 * Refund và adjustment — sửa sai bằng bút toán mới.
 *
 * Invariant 7 (append-only): không operation nào sửa entry hay charge đã ghi.
 * Refund và adjustment đều là transaction mới; charge gốc giữ nguyên `amount`,
 * chỉ tích luỹ `refunded` / `increase` / `decrease` trên record mới.
 *
 * Phân biệt:
 *
 * - **Refund**: trả lại tiền **trong ví** — `charged → available`. Tiền fiat rời
 *   hệ thống là việc của `payment`; lib này chỉ trả credit nội bộ và không bao
 *   giờ tuyên bố đã disbursed.
 * - **Adjustment**: `increase` thu thêm (available → charged) hoặc `decrease`
 *   giảm bớt (charged → available) với lý do tường minh. Adjustment là cách duy
 *   nhất sửa một charge đã posted.
 */

import {
  commitTransaction,
  derivedIdempotencyKey,
  derivedTransactionId,
  locateWallet,
  type FinancialBook,
} from './book';
import { findCharge } from './settlement';
import {
  referenceOf,
  refundableAmount,
  type ChargeAdjustment,
  type CustomerCharge,
  type Refund,
} from './records';
import { createMoney, isMoney, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type ChargeId,
  type FencingToken,
  type FinancialResult,
  type RefundId,
} from './shared';

/** Input của `refundCharge`. */
export interface RefundChargeInput {
  readonly refundId: string;
  readonly chargeId: string;
  readonly amount: Money;
  readonly reasonRef: string | null;
  readonly refundedAt: number;
  readonly fencingToken: string;
}

/** Kết quả của một correction. */
export interface CorrectionOutcome {
  readonly book: FinancialBook;
  readonly charge: CustomerCharge;
  readonly replayed: boolean;
}

/** Thay một charge trong book. */
function replaceCharge(book: FinancialBook, charge: CustomerCharge): FinancialBook {
  return Object.freeze({
    ...book,
    charges: freezeArray(
      book.charges.map((candidate) =>
        candidate.charge_id === charge.charge_id ? charge : candidate,
      ),
    ),
  });
}

/**
 * Hoàn một phần hoặc toàn bộ customer charge.
 *
 * Idempotent theo `refund_id`. Từ chối khi số tiền vượt phần còn hoàn được
 * (`refund_exceeds_charge`), khi charge chưa `posted`, hoặc khi available của ví
 * không đủ để nhận bút toán đảo. Không có đường nào sửa `amount` gốc.
 */
export function refundCharge(
  book: FinancialBook,
  input: RefundChargeInput,
): FinancialResult<CorrectionOutcome> {
  if (
    !isOpaqueId(input.refundId) ||
    !isOpaqueId(input.chargeId) ||
    !isOpaqueId(input.fencingToken) ||
    !isEpochMillis(input.refundedAt) ||
    (input.reasonRef !== null && !isOpaqueId(input.reasonRef)) ||
    !isMoney(input.amount) ||
    input.amount.minor <= 0n
  ) {
    return financialFailure('invalid_refund');
  }
  const existing = book.refunds.find((candidate) => candidate.refund_id === input.refundId);
  if (existing !== undefined) {
    // `reason_ref` là bằng chứng của một lần hoàn tiền, không phải metadata thực
    // thi: hai request cùng `refundId` nhưng lý do khác nhau không phải replay
    // của cùng một quyết định. `created_at` không so vì retry mang mốc mới.
    if (
      existing.charge_id !== input.chargeId ||
      existing.amount.minor !== input.amount.minor ||
      existing.amount.denomination !== input.amount.denomination ||
      existing.reason_ref !== input.reasonRef
    ) {
      return financialFailure('idempotency_conflict');
    }
    const charge = findCharge(book, existing.charge_id);
    return charge.ok
      ? financialOk(Object.freeze({ book, charge: charge.value, replayed: true }))
      : charge;
  }
  const found = findCharge(book, input.chargeId as ChargeId);
  if (!found.ok) {
    return found;
  }
  const charge = found.value;
  if (charge.state === 'pending') {
    return financialFailure('invalid_charge_transition');
  }
  if (input.amount.denomination !== charge.denomination) {
    return financialFailure('denomination_mismatch');
  }
  if (input.amount.minor > refundableAmount(charge).minor) {
    return financialFailure('refund_exceeds_charge');
  }
  const commit = commitTransaction(book, {
    accountId: charge.billing_account_id,
    walletId: charge.wallet_id,
    denomination: charge.denomination,
    transactionId: derivedTransactionId('refund', input.refundId, 'refund'),
    idempotencyKey: derivedIdempotencyKey('refund', input.refundId, 'refund'),
    reference: referenceOf('refund', input.refundId),
    fencingToken: input.fencingToken,
    createdAt: input.refundedAt,
    legs: [
      { account: 'wallet_charged', direction: 'credit', amount: input.amount },
      { account: 'wallet_available', direction: 'debit', amount: input.amount },
    ],
  });
  if (!commit.ok) {
    return commit;
  }
  const refund: Refund = Object.freeze({
    refund_id: input.refundId as RefundId,
    charge_id: charge.charge_id,
    wallet_id: charge.wallet_id,
    amount: input.amount,
    reason_ref: input.reasonRef,
    created_at: input.refundedAt,
    fencing_token: input.fencingToken as FencingToken,
  });
  const nextRefunded = createMoney(charge.denomination, charge.refunded.minor + input.amount.minor);
  if (!nextRefunded.ok) {
    return financialFailure('amount_overflow');
  }
  const nextCharge: CustomerCharge = Object.freeze({
    ...charge,
    refunded: nextRefunded.value,
    state: nextRefunded.value.minor >= charge.amount.minor ? 'refunded' : charge.state,
  });
  const nextBook = Object.freeze({
    ...replaceCharge(commit.value.book, nextCharge),
    refunds: freezeArray([...commit.value.book.refunds, refund]),
  });
  return financialOk(Object.freeze({ book: nextBook, charge: nextCharge, replayed: false }));
}

/** Input của `adjustCharge`. */
export interface AdjustChargeInput {
  readonly adjustmentId: string;
  readonly chargeId: string;
  readonly direction: 'increase' | 'decrease';
  readonly amount: Money;
  readonly reasonRef: string;
  readonly adjustedAt: number;
  readonly fencingToken: string;
}

/** Lý do adjustment bắt buộc — một correction không có lý do là một mutation không giải thích được. */
/**
 * Điều chỉnh một charge đã posted.
 *
 * - `increase`: `available → charged` (undercharge).
 * - `decrease`: `charged → available` (overcharge).
 *
 * Idempotent theo `adjustment_id`. Bắt buộc `reasonRef` để audit. Decrease
 * không vượt quá phần charged còn lại; increase không vượt quá available của ví
 * (bút toán sẽ tự từ chối nếu available âm).
 */
export function adjustCharge(
  book: FinancialBook,
  input: AdjustChargeInput,
): FinancialResult<CorrectionOutcome> {
  if (
    !isOpaqueId(input.adjustmentId) ||
    !isOpaqueId(input.chargeId) ||
    !isOpaqueId(input.reasonRef) ||
    !isOpaqueId(input.fencingToken) ||
    !isEpochMillis(input.adjustedAt) ||
    !isMoney(input.amount) ||
    input.amount.minor <= 0n ||
    (input.direction !== 'increase' && input.direction !== 'decrease')
  ) {
    return financialFailure('invalid_adjustment');
  }
  const existing = book.adjustments.find(
    (candidate) => candidate.adjustment_id === input.adjustmentId,
  );
  if (existing !== undefined) {
    if (
      existing.charge_id !== input.chargeId ||
      existing.amount.minor !== input.amount.minor ||
      existing.amount.denomination !== input.amount.denomination ||
      existing.direction !== input.direction ||
      existing.reason_ref !== input.reasonRef
    ) {
      return financialFailure('idempotency_conflict');
    }
    const charge = findCharge(book, existing.charge_id);
    return charge.ok
      ? financialOk(Object.freeze({ book, charge: charge.value, replayed: true }))
      : charge;
  }
  const found = findCharge(book, input.chargeId as ChargeId);
  if (!found.ok) {
    return found;
  }
  const charge = found.value;
  if (charge.state === 'pending') {
    return financialFailure('invalid_charge_transition');
  }
  if (input.amount.denomination !== charge.denomination) {
    return financialFailure('denomination_mismatch');
  }
  if (input.direction === 'decrease' && input.amount.minor > refundableAmount(charge).minor) {
    return financialFailure('insufficient_charged_balance');
  }
  if (input.direction === 'increase') {
    const located = locateWallet(book, charge.wallet_id);
    if (!located.ok) {
      return located;
    }
    if (located.value.wallet.balances.available.minor < input.amount.minor) {
      return financialFailure('insufficient_available_balance');
    }
  }
  const legs =
    input.direction === 'increase'
      ? [
          {
            account: 'wallet_available' as const,
            direction: 'credit' as const,
            amount: input.amount,
          },
          { account: 'wallet_charged' as const, direction: 'debit' as const, amount: input.amount },
        ]
      : [
          {
            account: 'wallet_charged' as const,
            direction: 'credit' as const,
            amount: input.amount,
          },
          {
            account: 'wallet_available' as const,
            direction: 'debit' as const,
            amount: input.amount,
          },
        ];
  const commit = commitTransaction(book, {
    accountId: charge.billing_account_id,
    walletId: charge.wallet_id,
    denomination: charge.denomination,
    transactionId: derivedTransactionId('adjustment', input.adjustmentId, 'adjust'),
    idempotencyKey: derivedIdempotencyKey('adjustment', input.adjustmentId, 'adjust'),
    reference: referenceOf('charge_adjustment', input.adjustmentId),
    fencingToken: input.fencingToken,
    createdAt: input.adjustedAt,
    legs,
  });
  if (!commit.ok) {
    return commit;
  }
  const adjustment: ChargeAdjustment = Object.freeze({
    adjustment_id: input.adjustmentId,
    charge_id: charge.charge_id,
    wallet_id: charge.wallet_id,
    direction: input.direction,
    amount: input.amount,
    reason_ref: input.reasonRef,
    created_at: input.adjustedAt,
    fencing_token: input.fencingToken as FencingToken,
  });
  const increase = createMoney(
    charge.denomination,
    input.direction === 'increase'
      ? charge.increase.minor + input.amount.minor
      : charge.increase.minor,
  );
  const decrease = createMoney(
    charge.denomination,
    input.direction === 'decrease'
      ? charge.decrease.minor + input.amount.minor
      : charge.decrease.minor,
  );
  if (!increase.ok || !decrease.ok) {
    return financialFailure('amount_overflow');
  }
  const nextCharge: CustomerCharge = Object.freeze({
    ...charge,
    increase: increase.value,
    decrease: decrease.value,
    state: 'adjusted',
  });
  const nextBook = Object.freeze({
    ...replaceCharge(commit.value.book, nextCharge),
    adjustments: freezeArray([...commit.value.book.adjustments, adjustment]),
  });
  return financialOk(Object.freeze({ book: nextBook, charge: nextCharge, replayed: false }));
}
