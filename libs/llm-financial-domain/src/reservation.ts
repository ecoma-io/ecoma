/**
 * Reservation tài chính — `available → held`, capture, release.
 *
 * Reservation giữ **tiền**, không giữ quota (invariant 10: reservation quota ≠
 * charge money). Vì vậy module này chỉ mô hình hoá phần tiền; quota reservation
 * do `llm-api` sở hữu (A7) và không xuất hiện ở đây.
 *
 * State machine (§4.2): `reserved → captured | released | expired`.
 *
 * - `reserve`: `available -= amount; held += amount`.
 * - `capture`: `held -= amount; charged += amount`. Capture một phần bắt buộc
 *   phải kèm `releaseRemainder` tường minh — không có chỗ nào âm thầm trả phần
 *   thừa về available, vì "âm thầm release" chính là cách một khoản giữ bị mất
 *   dấu.
 * - `release`: `held -= amount; available += amount`.
 *
 * Cả ba idempotent theo `reservation_id`: replay cùng payload trả state gốc,
 * khác payload là `idempotency_conflict`. Capture/release một reservation đã
 * finalize là `reservation_already_finalized`.
 */

import {
  commitTransaction,
  derivedIdempotencyKey,
  derivedTransactionId,
  locateWallet,
  type FinancialBook,
  type RequestedLeg,
} from './book';
import { isReservation, referenceOf, type Reservation } from './records';
import { createMoney, isMoney, isZeroMoney, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type BillingAccountId,
  type FencingToken,
  type FinancialResult,
  type ReservationId,
  type WalletId,
} from './shared';

/** Input của `reserve`. */
export interface ReserveInput {
  readonly reservationId: string;
  readonly walletId: string;
  readonly billingAccountId: string;
  readonly amount: Money;
  readonly createdAt: number;
  readonly fencingToken: string;
}

/** Kết quả của một operation reservation. */
export interface ReservationOutcome {
  readonly book: FinancialBook;
  readonly reservation: Reservation;
  readonly replayed: boolean;
}

/** Tìm reservation theo id trong book. */
export function findReservation(
  book: FinancialBook,
  reservationId: ReservationId,
): FinancialResult<Reservation> {
  const reservation = book.reservations.find(
    (candidate) => candidate.reservation_id === reservationId,
  );
  return reservation === undefined
    ? financialFailure('reservation_not_found')
    : financialOk(reservation);
}

/** Thay một reservation trong book. */
function replaceReservation(book: FinancialBook, reservation: Reservation): FinancialBook {
  return Object.freeze({
    ...book,
    reservations: freezeArray(
      book.reservations.map((candidate) =>
        candidate.reservation_id === reservation.reservation_id ? reservation : candidate,
      ),
    ),
  });
}

/** Thêm reservation mới vào book. */
function appendReservation(book: FinancialBook, reservation: Reservation): FinancialBook {
  return Object.freeze({
    ...book,
    reservations: freezeArray([...book.reservations, reservation]),
  });
}

/**
 * Giữ tiền cho một request/lease sắp tới.
 *
 * Từ chối khi số dư available không đủ (`insufficient_available_balance`), khi
 * wallet không thuộc đúng billing account, hoặc khi reservation id đã tồn tại
 * với payload khác. Replay cùng payload trả state gốc và không post thêm bút
 * toán.
 */
export function reserve(
  book: FinancialBook,
  input: ReserveInput,
): FinancialResult<ReservationOutcome> {
  if (
    !isOpaqueId(input.reservationId) ||
    !isOpaqueId(input.walletId) ||
    !isOpaqueId(input.billingAccountId) ||
    !isOpaqueId(input.fencingToken) ||
    !isEpochMillis(input.createdAt) ||
    !isMoney(input.amount)
  ) {
    return financialFailure('invalid_reservation');
  }
  if (input.amount.minor <= 0n) {
    return financialFailure('invalid_amount');
  }
  const located = locateWallet(book, input.walletId as WalletId);
  if (!located.ok) {
    return located;
  }
  const wallet = located.value.wallet;
  if (wallet.billing_account_id !== input.billingAccountId) {
    return financialFailure('invalid_wallet');
  }
  if (wallet.denomination !== input.amount.denomination) {
    return financialFailure('denomination_mismatch');
  }

  // Replay: reservation id đã tồn tại.
  const existingIndex = book.reservations.findIndex(
    (candidate) => candidate.reservation_id === input.reservationId,
  );
  if (existingIndex !== -1) {
    const existing = book.reservations[existingIndex];
    if (
      existing.wallet_id !== input.walletId ||
      existing.reserved.minor !== input.amount.minor ||
      existing.denomination !== input.amount.denomination
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ book, reservation: existing, replayed: true }));
  }

  if (wallet.balances.available.minor < input.amount.minor) {
    return financialFailure('insufficient_available_balance');
  }

  const commit = commitTransaction(book, {
    accountId: located.value.account.billing_account_id as BillingAccountId,
    walletId: wallet.wallet_id,
    denomination: wallet.denomination,
    transactionId: derivedTransactionId('reservation', input.reservationId, 'hold'),
    idempotencyKey: derivedIdempotencyKey('reservation', input.reservationId, 'hold'),
    reference: referenceOf('reservation', input.reservationId),
    fencingToken: input.fencingToken,
    createdAt: input.createdAt,
    legs: [
      { account: 'wallet_available', direction: 'credit', amount: input.amount },
      { account: 'wallet_held', direction: 'debit', amount: input.amount },
    ],
  });
  if (!commit.ok) {
    return commit;
  }
  const zero = createMoney(input.amount.denomination, 0n);
  if (!zero.ok) {
    return zero;
  }
  const reservation: Reservation = Object.freeze({
    reservation_id: input.reservationId as ReservationId,
    wallet_id: wallet.wallet_id,
    billing_account_id: wallet.billing_account_id,
    denomination: wallet.denomination,
    reserved: input.amount,
    captured: zero.value,
    released: zero.value,
    state: 'reserved',
    created_at: input.createdAt,
    finalized_at: null,
    fencing_token: input.fencingToken as FencingToken,
  });
  if (!isReservation(reservation)) {
    return financialFailure('invalid_reservation');
  }
  const nextBook = appendReservation(commit.value.book, reservation);
  return financialOk(Object.freeze({ book: nextBook, reservation, replayed: false }));
}

/** Input của `capture`. */
export interface CaptureInput {
  readonly reservationId: string;
  readonly amount: Money;
  /**
   * Release phần chênh còn lại trong cùng operation.
   *
   * Capture một phần mà không release phần còn lại bị từ chối
   * (`remainder_release_required`): phần giữ thừa phải có chủ đích rõ ràng,
   * không phải hệ quả của việc quên.
   */
  readonly releaseRemainder: boolean;
  readonly capturedAt: number;
  readonly fencingToken: string;
}

/**
 * Capture một reservation — `held → charged`.
 *
 * Capture toàn bộ hoặc một phần. Một phần chỉ hợp lệ khi `releaseRemainder` là
 * `true`, khi đó phần thừa trả về available trong cùng operation.
 */
export function capture(
  book: FinancialBook,
  input: CaptureInput,
): FinancialResult<ReservationOutcome> {
  const reservation = findReservation(book, input.reservationId as ReservationId);
  if (!reservation.ok) {
    return reservation;
  }
  const current = reservation.value;
  // Kiểm shape trước khi đọc field: `input.amount.minor` trên một giá trị không
  // phải `Money` sẽ ném `TypeError` tại runtime thay vì trả domain error. Token
  // và thời gian cũng được kiểm trước nhánh replay — replay vẫn phải là một
  // request hợp lệ, không phải đường bỏ qua validation.
  if (!isMoney(input.amount)) {
    return financialFailure('invalid_amount');
  }
  if (!isOpaqueId(input.fencingToken)) {
    return financialFailure('invalid_fencing_token');
  }
  if (!isEpochMillis(input.capturedAt)) {
    return financialFailure('invalid_reservation');
  }
  if (current.state !== 'reserved') {
    // Replay cùng payload trên reservation đã finalize là idempotent. Chỉ
    // `amount` (và phần thừa suy ra từ nó) là payload của capture; `capturedAt`
    // và `fencingToken` là metadata thực thi — retry hợp lệ mang mốc thời gian
    // mới, nên so sánh chúng sẽ từ chối đúng một lần retry.
    if (
      current.state === 'captured' &&
      current.captured.minor === input.amount.minor &&
      current.released.minor === current.reserved.minor - input.amount.minor
    ) {
      return financialOk(Object.freeze({ book, reservation: current, replayed: true }));
    }
    return financialFailure('reservation_already_finalized');
  }
  if (input.amount.minor <= 0n) {
    return financialFailure('invalid_amount');
  }
  if (input.amount.minor > current.reserved.minor) {
    return financialFailure('insufficient_held_balance');
  }
  if (input.amount.denomination !== current.denomination) {
    return financialFailure('denomination_mismatch');
  }
  const remainder = current.reserved.minor - input.amount.minor;
  if (remainder > 0n && !input.releaseRemainder) {
    return financialFailure('remainder_release_required');
  }
  const located = locateWallet(book, current.wallet_id);
  if (!located.ok) {
    return located;
  }
  const legs: RequestedLeg[] = [
    { account: 'wallet_held', direction: 'credit', amount: input.amount },
    { account: 'wallet_charged', direction: 'debit', amount: input.amount },
  ];
  const remainderAmount = createMoney(current.denomination, remainder);
  if (!remainderAmount.ok) {
    return remainderAmount;
  }
  if (!isZeroMoney(remainderAmount.value)) {
    legs.push(
      {
        account: 'wallet_held' as const,
        direction: 'credit' as const,
        amount: remainderAmount.value,
      },
      {
        account: 'wallet_available' as const,
        direction: 'debit' as const,
        amount: remainderAmount.value,
      },
    );
  }
  const commit = commitTransaction(book, {
    accountId: located.value.account.billing_account_id,
    walletId: current.wallet_id,
    denomination: current.denomination,
    transactionId: derivedTransactionId('reservation', current.reservation_id, 'capture'),
    idempotencyKey: derivedIdempotencyKey('reservation', current.reservation_id, 'capture'),
    reference: referenceOf('reservation_capture', current.reservation_id),
    fencingToken: input.fencingToken,
    createdAt: input.capturedAt,
    legs,
  });
  if (!commit.ok) {
    return commit;
  }
  const next: Reservation = Object.freeze({
    ...current,
    captured: input.amount,
    released: remainderAmount.value,
    state: 'captured',
    finalized_at: input.capturedAt,
  });
  return financialOk(
    Object.freeze({
      book: replaceReservation(commit.value.book, next),
      reservation: next,
      replayed: false,
    }),
  );
}

/** Input của `release`. */
export interface ReleaseInput {
  readonly reservationId: string;
  readonly releasedAt: number;
  readonly fencingToken: string;
}

/**
 * Release một reservation chưa dùng — `held → available`.
 *
 * Release chỉ hợp lệ khi có bằng chứng provider chưa thực thi; lib không tự suy
 * điều đó từ timeout (invariant 6). Vì vậy operation không có tham số thời gian
 * quyết định: caller quyết định có gọi nó hay không.
 */
export function release(
  book: FinancialBook,
  input: ReleaseInput,
): FinancialResult<ReservationOutcome> {
  const reservation = findReservation(book, input.reservationId as ReservationId);
  if (!reservation.ok) {
    return reservation;
  }
  const current = reservation.value;
  // Validate trước nhánh replay: một request thiếu token hoặc mốc thời gian là
  // request hỏng, không phải replay hợp lệ của một release đã xảy ra.
  if (!isEpochMillis(input.releasedAt)) {
    return financialFailure('invalid_reservation');
  }
  if (!isOpaqueId(input.fencingToken)) {
    return financialFailure('invalid_fencing_token');
  }
  if (current.state !== 'reserved') {
    // Release không mang payload tiền tệ: reservation id là toàn bộ payload, nên
    // một lần gọi lại trên reservation đã `released` là replay hợp lệ.
    if (current.state === 'released') {
      return financialOk(Object.freeze({ book, reservation: current, replayed: true }));
    }
    return financialFailure('reservation_already_finalized');
  }
  const located = locateWallet(book, current.wallet_id);
  if (!located.ok) {
    return located;
  }
  const commit = commitTransaction(book, {
    accountId: located.value.account.billing_account_id,
    walletId: current.wallet_id,
    denomination: current.denomination,
    transactionId: derivedTransactionId('reservation', current.reservation_id, 'release'),
    idempotencyKey: derivedIdempotencyKey('reservation', current.reservation_id, 'release'),
    reference: referenceOf('reservation_release', current.reservation_id),
    fencingToken: input.fencingToken,
    createdAt: input.releasedAt,
    legs: [
      { account: 'wallet_held', direction: 'credit', amount: current.reserved },
      { account: 'wallet_available', direction: 'debit', amount: current.reserved },
    ],
  });
  if (!commit.ok) {
    return commit;
  }
  const next: Reservation = Object.freeze({
    ...current,
    released: current.reserved,
    state: 'released',
    finalized_at: input.releasedAt,
  });
  return financialOk(
    Object.freeze({
      book: replaceReservation(commit.value.book, next),
      reservation: next,
      replayed: false,
    }),
  );
}
