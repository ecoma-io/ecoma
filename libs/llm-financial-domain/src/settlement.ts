/**
 * Settlement — chốt một reservation đã phục vụ thành customer charge.
 *
 * Settlement khác reservation ở ba điểm:
 *
 * - Reservation chỉ **giữ chỗ** tiền; settlement biến nó thành khoản **đã thu**.
 * - Settlement tiêu thụ bằng chứng usage/price do caller cấp; lib không tính giá
 *   (`llm-seller-pricing` sở hữu customer price) và không đo usage (`llm-usage`).
 * - Settlement idempotent theo `settlement_id`, không chỉ theo `reservation_id`:
 *   hai settlement id khác nhau trên cùng reservation là hai lần settle, và lần
 *   thứ hai bị từ chối vì reservation đã finalize.
 *
 * Settlement không phát minh split giữa platform và seller: nếu caller cấp phần
 * earnings của seller (`seller`), một payable `accrued` được ghi trong cùng
 * operation. Payable là **projection EC**, không phải payout và không phải
 * provider cost.
 */

import type { FinancialBook } from './book';
import { accruePayable } from './payable';
import { isCustomerCharge, type CustomerCharge } from './records';
import { capture, findReservation } from './reservation';
import { createMoney, isMoney, isZeroMoney, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type ChargeId,
  type FinancialResult,
  type ReservationId,
  type SettlementId,
} from './shared';

/** Phần earnings của seller trong một settlement — caller cấp split policy. */
export interface SettlementSellerShare {
  readonly sellerTenant: string;
  readonly payableId: string;
  readonly period: string;
  readonly availableAt: number;
  /** Số EC seller được hưởng cho usage này. */
  readonly amount: Money<'EC'>;
}

/** Input của `settle`. */
export interface SettleInput {
  readonly settlementId: string;
  readonly reservationId: string;
  readonly chargeId: string;
  /** Số tiền thực thu từ customer; phần còn lại của reservation được release. */
  readonly chargeAmount: Money;
  readonly settledAt: number;
  readonly fencingToken: string;
  /** Optional: accrual seller payable trong cùng settlement. */
  readonly seller: SettlementSellerShare | null;
}

/** Kết quả của `settle`. */
export interface SettlementOutcome {
  readonly book: FinancialBook;
  readonly charge: CustomerCharge;
  readonly settlementId: SettlementId;
  readonly replayed: boolean;
}

/** Tìm charge theo id. */
export function findCharge(
  book: FinancialBook,
  chargeId: ChargeId,
): FinancialResult<CustomerCharge> {
  const charge = book.charges.find((candidate) => candidate.charge_id === chargeId);
  return charge === undefined ? financialFailure('charge_not_found') : financialOk(charge);
}

/**
 * Settle một reservation thành customer charge.
 *
 * Bước tiền tệ: capture phần được tính (`chargeAmount`) và release phần thừa
 * trong cùng transaction (nhờ đó settlement giữ nguyên conservation). Bước ghi
 * nhận: tạo charge `posted` với `reservation_id` và `settlement_id` immutable.
 * Bước tuỳ chọn: accrual seller payable.
 *
 * Replay cùng `settlementId` và cùng payload trả charge gốc. Replay khác payload
 * là `idempotency_conflict`. Settlement lần hai trên reservation đã finalize bị
 * từ chối bởi `capture`.
 */
export function settle(
  book: FinancialBook,
  input: SettleInput,
): FinancialResult<SettlementOutcome> {
  if (
    !isOpaqueId(input.settlementId) ||
    !isOpaqueId(input.reservationId) ||
    !isOpaqueId(input.chargeId) ||
    !isOpaqueId(input.fencingToken) ||
    !isEpochMillis(input.settledAt) ||
    !isMoney(input.chargeAmount) ||
    input.chargeAmount.minor <= 0n
  ) {
    return financialFailure('invalid_settlement');
  }
  const existingCharge = book.charges.find(
    (candidate) => candidate.settlement_id === input.settlementId,
  );
  if (existingCharge !== undefined) {
    if (
      existingCharge.charge_id !== input.chargeId ||
      existingCharge.reservation_id !== input.reservationId ||
      existingCharge.amount.minor !== input.chargeAmount.minor ||
      existingCharge.denomination !== input.chargeAmount.denomination
    ) {
      return financialFailure('idempotency_conflict');
    }
    // Phần seller cũng là payload của settlement: một replay cùng id nhưng
    // split khác không phải lần gọi lặp của cùng quyết định, và im lặng trả
    // charge gốc sẽ che mất việc caller đang cố ghi một accrual khác.
    // `settledAt`/`fencingToken` không so — retry mang mốc và token mới.
    const accruedPayable = book.payables.find(
      (candidate) => candidate.settlement_id === input.settlementId,
    );
    if (input.seller === null) {
      if (accruedPayable !== undefined) {
        return financialFailure('idempotency_conflict');
      }
    } else if (
      accruedPayable === undefined ||
      accruedPayable.seller_tenant !== input.seller.sellerTenant ||
      accruedPayable.payable_id !== input.seller.payableId ||
      accruedPayable.period !== input.seller.period ||
      accruedPayable.amount.minor !== input.seller.amount.minor ||
      accruedPayable.available_at !== input.seller.availableAt
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(
      Object.freeze({
        book,
        charge: existingCharge,
        settlementId: input.settlementId as SettlementId,
        replayed: true,
      }),
    );
  }
  const reservation = findReservation(book, input.reservationId as ReservationId);
  if (!reservation.ok) {
    return reservation;
  }
  if (reservation.value.denomination !== input.chargeAmount.denomination) {
    return financialFailure('denomination_mismatch');
  }
  if (reservation.value.state !== 'reserved') {
    return financialFailure('reservation_already_finalized');
  }

  const captured = capture(book, {
    reservationId: input.reservationId,
    amount: input.chargeAmount,
    releaseRemainder: true,
    capturedAt: input.settledAt,
    fencingToken: input.fencingToken,
  });
  if (!captured.ok) {
    return captured;
  }

  // Settlement **không** post thêm bút toán balance: capture trong `capture()` đã
  // là toàn bộ mutation tiền tệ (`held → charged`, phần thừa `held → available`).
  // Ghi thêm một bút toán "doanh thu" lên cùng balance sẽ cộng đúp và phá bất
  // biến `available + held + charged = total`. Ghi nhận doanh thu là projection
  // kế toán bên ngoài wallet, không phải một balance khác của wallet.
  const zero = createMoney(reservation.value.denomination, 0n);
  if (!zero.ok) {
    return zero;
  }
  const charge: CustomerCharge = Object.freeze({
    charge_id: input.chargeId as ChargeId,
    wallet_id: reservation.value.wallet_id,
    billing_account_id: reservation.value.billing_account_id,
    denomination: reservation.value.denomination,
    amount: input.chargeAmount,
    refunded: zero.value,
    increase: zero.value,
    decrease: zero.value,
    state: 'posted',
    reservation_id: reservation.value.reservation_id,
    settlement_id: input.settlementId as SettlementId,
    created_at: input.settledAt,
    posted_at: input.settledAt,
  });
  if (!isCustomerCharge(charge)) {
    return financialFailure('invalid_charge');
  }
  let nextBook: FinancialBook = Object.freeze({
    ...captured.value.book,
    charges: freezeArray([...captured.value.book.charges, charge]),
  });

  if (input.seller !== null) {
    const accrued = accruePayable(nextBook, {
      payableId: input.seller.payableId,
      sellerTenant: input.seller.sellerTenant,
      amount: input.seller.amount,
      period: input.seller.period,
      availableAt: input.seller.availableAt,
      accruedAt: input.settledAt,
      settlementId: input.settlementId,
      chargeId: input.chargeId,
      fencingToken: input.fencingToken,
    });
    if (!accrued.ok) {
      return accrued;
    }
    nextBook = accrued.value.book;
  }

  return financialOk(
    Object.freeze({
      book: nextBook,
      charge,
      settlementId: input.settlementId as SettlementId,
      replayed: false,
    }),
  );
}

/** Kiểm một charge là zero — helper cho test về charge đã hoàn toàn. */
export function isFullyRefunded(charge: CustomerCharge): boolean {
  return (
    isZeroMoney(charge.amount) ||
    (charge.refunded.denomination === charge.amount.denomination &&
      charge.refunded.minor >= charge.amount.minor)
  );
}
