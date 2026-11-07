/**
 * Credit và deposit — nguồn duy nhất làm tăng `total` của một wallet.
 *
 * State (§4.1): `pending → credited → reversed`.
 *
 * - `pending`: Payment đã khởi tạo nhưng chưa xác nhận; chưa có bút toán và
 *   chưa tăng balance. Lib giữ record để caller đối chiếu.
 * - `credited`: bút toán `funding_clearing` debit / `wallet_available` credit —
 *   đây là chỗ duy nhất `total` tăng.
 * - `reversed`: deposit bị đảo (payment fail/refund). Bút toán đối ứng **giữ
 *   nguyên bất biến conservation**: `wallet_available` debit / `funding_clearing`
 *   credit, và `total` giảm đúng bằng số đã credit. Không có đường nào giảm
 *   `total` mà không ghi bút toán đối ứng.
 *
 * Idempotent theo `deposit_id` ở mọi transition: replay cùng payload trả record
 * gốc; transition không hợp lệ là domain error.
 */

import {
  commitTransaction,
  derivedIdempotencyKey,
  derivedTransactionId,
  locateWallet,
  type FinancialBook,
} from './book';
import { referenceOf } from './records';
import { isDepositState, type Deposit, type Deposit as DepositRecord } from './wallet';
import { isMoney, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type WalletId,
  type FinancialResult,
} from './shared';

export type { Deposit } from './wallet';

/** Trạng thái deposit mà caller đăng ký khi Payment báo một khoản nạp. */
export interface RegisterDepositInput {
  readonly depositId: string;
  readonly walletId: string;
  readonly amount: Money;
  readonly paymentReference: string;
  readonly createdAt: number;
}

/** Kết quả của một operation deposit. */
export interface DepositOutcome {
  readonly book: FinancialBook;
  readonly deposit: Deposit;
  readonly replayed: boolean;
}

/** Tìm deposit theo id. */
export function findDeposit(book: FinancialBook, depositId: string): FinancialResult<Deposit> {
  const deposit = book.deposits.find((candidate) => candidate.deposit_id === depositId);
  return deposit === undefined ? financialFailure('deposit_not_found') : financialOk(deposit);
}

/** Thay một deposit trong book. */
function replaceDeposit(book: FinancialBook, deposit: Deposit): FinancialBook {
  return Object.freeze({
    ...book,
    deposits: freezeArray(
      book.deposits.map((candidate) =>
        candidate.deposit_id === deposit.deposit_id ? deposit : candidate,
      ),
    ),
  });
}

/**
 * Đăng ký một deposit ở trạng thái `pending`.
 *
 * Chưa có bút toán, chưa đổi balance: một pending deposit không phải tiền trong
 * ví, và không bao giờ được dùng để reserve.
 */
export function registerDeposit(
  book: FinancialBook,
  input: RegisterDepositInput,
): FinancialResult<DepositOutcome> {
  if (
    !isOpaqueId(input.depositId) ||
    !isOpaqueId(input.walletId) ||
    !isOpaqueId(input.paymentReference) ||
    !isEpochMillis(input.createdAt) ||
    !isMoney(input.amount) ||
    input.amount.minor <= 0n
  ) {
    return financialFailure('invalid_amount');
  }
  const located = locateWallet(book, input.walletId as WalletId);
  if (!located.ok) {
    return located;
  }
  if (located.value.wallet.denomination !== input.amount.denomination) {
    return financialFailure('denomination_mismatch');
  }
  const existing = book.deposits.find((candidate) => candidate.deposit_id === input.depositId);
  if (existing !== undefined) {
    if (
      existing.wallet_id !== input.walletId ||
      existing.amount.minor !== input.amount.minor ||
      existing.payment_reference !== input.paymentReference
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ book, deposit: existing, replayed: true }));
  }
  const deposit: DepositRecord = Object.freeze({
    deposit_id: input.depositId,
    wallet_id: located.value.wallet.wallet_id,
    amount: input.amount,
    state: 'pending',
    created_at: input.createdAt,
    payment_reference: input.paymentReference,
  });
  return financialOk(
    Object.freeze({
      book: Object.freeze({ ...book, deposits: freezeArray([...book.deposits, deposit]) }),
      deposit,
      replayed: false,
    }),
  );
}

/** Input của `creditDeposit`. */
export interface CreditDepositInput {
  readonly depositId: string;
  readonly creditedAt: number;
  readonly fencingToken: string;
}

/**
 * Chuyển deposit `pending → credited` và nạp tiền vào available balance.
 *
 * Đây là operation duy nhất làm tăng `total`. Từ chối nếu deposit không ở trạng
 * thái `pending`; replay một deposit đã `credited` trả record gốc.
 */
export function creditDeposit(
  book: FinancialBook,
  input: CreditDepositInput,
): FinancialResult<DepositOutcome> {
  const found = findDeposit(book, input.depositId);
  if (!found.ok) {
    return found;
  }
  const deposit = found.value;
  if (deposit.state === 'credited') {
    return financialOk(Object.freeze({ book, deposit, replayed: true }));
  }
  if (deposit.state !== 'pending') {
    return financialFailure('invalid_deposit_transition');
  }
  if (!isEpochMillis(input.creditedAt) || !isOpaqueId(input.fencingToken)) {
    return financialFailure('invalid_epoch_millis');
  }
  const located = locateWallet(book, deposit.wallet_id);
  if (!located.ok) {
    return located;
  }
  const commit = commitTransaction(book, {
    accountId: located.value.account.billing_account_id,
    walletId: deposit.wallet_id,
    denomination: deposit.amount.denomination,
    transactionId: derivedTransactionId('credit', deposit.deposit_id, 'credit'),
    idempotencyKey: derivedIdempotencyKey('credit', deposit.deposit_id, 'credit'),
    reference: referenceOf('credit', deposit.deposit_id),
    fencingToken: input.fencingToken,
    createdAt: input.creditedAt,
    legs: [
      { account: 'funding_clearing', direction: 'credit', amount: deposit.amount },
      { account: 'wallet_available', direction: 'debit', amount: deposit.amount },
    ],
  });
  if (!commit.ok) {
    return commit;
  }
  const next: DepositRecord = Object.freeze({ ...deposit, state: 'credited' });
  return financialOk(
    Object.freeze({
      book: replaceDeposit(commit.value.book, next),
      deposit: next,
      replayed: false,
    }),
  );
}

/** Input của `reverseDeposit`. */
export interface ReverseDepositInput {
  readonly depositId: string;
  readonly reversedAt: number;
  readonly fencingToken: string;
  /** Tham chiếu tới bằng chứng đảo — caller cấp, opaque. */
  readonly evidenceRef: string;
}

/**
 * Đảo một deposit đã credit — `credited → reversed`.
 *
 * Bút toán đối ứng debit `wallet_available` / credit `funding_clearing`. Từ chối
 * nếu available không đủ để đảo (`insufficient_available_balance`) — khi tiền
 * đã bị giữ hoặc đã chi, đảo deposit cần xử lý tường minh, không được ép số dư
 * âm. Đó là lý do `reversed` không phải một phép "xoá" mà là một transaction
 * thật.
 */
export function reverseDeposit(
  book: FinancialBook,
  input: ReverseDepositInput,
): FinancialResult<DepositOutcome> {
  const found = findDeposit(book, input.depositId);
  if (!found.ok) {
    return found;
  }
  const deposit = found.value;
  if (deposit.state === 'reversed') {
    return financialOk(Object.freeze({ book, deposit, replayed: true }));
  }
  if (deposit.state !== 'credited') {
    return financialFailure('invalid_deposit_transition');
  }
  if (
    !isEpochMillis(input.reversedAt) ||
    !isOpaqueId(input.fencingToken) ||
    !isOpaqueId(input.evidenceRef)
  ) {
    return financialFailure('invalid_epoch_millis');
  }
  const located = locateWallet(book, deposit.wallet_id);
  if (!located.ok) {
    return located;
  }
  if (located.value.wallet.balances.available.minor < deposit.amount.minor) {
    return financialFailure('insufficient_available_balance');
  }
  const commit = commitTransaction(book, {
    accountId: located.value.account.billing_account_id,
    walletId: deposit.wallet_id,
    denomination: deposit.amount.denomination,
    transactionId: derivedTransactionId('credit', deposit.deposit_id, 'reverse'),
    idempotencyKey: derivedIdempotencyKey('credit', deposit.deposit_id, 'reverse'),
    reference: referenceOf('credit_reversal', deposit.deposit_id),
    fencingToken: input.fencingToken,
    createdAt: input.reversedAt,
    legs: [
      { account: 'wallet_available', direction: 'credit', amount: deposit.amount },
      { account: 'funding_clearing', direction: 'debit', amount: deposit.amount },
    ],
  });
  if (!commit.ok) {
    return commit;
  }
  const next: DepositRecord = Object.freeze({ ...deposit, state: 'reversed' });
  return financialOk(
    Object.freeze({
      book: replaceDeposit(commit.value.book, next),
      deposit: next,
      replayed: false,
    }),
  );
}

/** Type guard cho trạng thái deposit — re-export để consumer kiểm dữ liệu đọc từ ngoài. */
export { isDepositState };
