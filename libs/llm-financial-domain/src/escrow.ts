/**
 * Budget escrow và budget lease.
 *
 * Ba bất biến liên quan nằm ở đây:
 *
 * - **Escrow là tiền đã giữ** (invariant 12): mở escrow là `available → held`. Vì
 *   vậy unused escrow là **held money**, không phải outstanding liability. Không
 *   có tài khoản "nghĩa vụ" nào được sinh ra từ escrow.
 * - **Lease ≠ quota lease** (invariant 11): lease ở đây cấp một hạn mức **tiền**
 *   trong một cửa sổ; nó không cấp token/request quota, và không có operation nào
 *   ở đây trả về quota.
 * - **Không reallocate khi chưa reconcile** (invariant 6): đóng escrow đòi
 *   `reconciliationRef` và đòi mọi lease không còn `active`. Lease hết hạn theo
 *   thời gian **không** chứng minh gateway cũ đã ngừng tiêu; chỉ epoch mới
 *   (`revokeLease`) cộng reconciliation mới cho phép trả tiền về available.
 */

import {
  commitTransaction,
  derivedIdempotencyKey,
  derivedTransactionId,
  locateWallet,
  type FinancialBook,
} from './book';
import {
  isBudgetEscrow,
  referenceOf,
  type BudgetEscrow,
  type BudgetLease,
  type EscrowState,
  type LeaseState,
} from './records';
import { isMoney, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type BillingAccountId,
  type FencingToken,
  type FinancialResult,
  type WalletId,
} from './shared';

/** Input của `openEscrow`. */
export interface OpenEscrowInput {
  readonly escrowId: string;
  readonly walletId: string;
  readonly amount: Money;
  readonly createdAt: number;
  readonly fencingToken: string;
}

/** Input của `issueLease`. */
export interface IssueLeaseInput {
  readonly leaseId: string;
  readonly escrowId: string;
  readonly amount: Money;
  readonly epoch: number;
  readonly fencingToken: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Input của `revokeLease`. */
export interface RevokeLeaseInput {
  readonly leaseId: string;
  /** Epoch mới quan sát được; phải lớn hơn epoch của lease thì lease mới là stale. */
  readonly observedEpoch: number;
  readonly revokedAt: number;
}

/** Input của `closeEscrow`. */
export interface CloseEscrowInput {
  readonly escrowId: string;
  /** Bằng chứng reconciliation — không có thì không được trả tiền về available. */
  readonly reconciliationRef: string;
  readonly closedAt: number;
  readonly fencingToken: string;
}

/** Kết quả của một operation escrow. */
export interface EscrowOutcome {
  readonly book: FinancialBook;
  readonly escrow: BudgetEscrow;
  readonly replayed: boolean;
}

/** Kết quả của một operation lease. */
export interface LeaseOutcome {
  readonly book: FinancialBook;
  readonly lease: BudgetLease;
  readonly replayed: boolean;
}

/** Tìm escrow theo id. */
export function findEscrow(book: FinancialBook, escrowId: string): FinancialResult<BudgetEscrow> {
  const escrow = book.escrows.find((candidate) => candidate.escrow_id === escrowId);
  return escrow === undefined ? financialFailure('escrow_not_found') : financialOk(escrow);
}

/** Tìm lease trong escrow. */
export function findLease(escrow: BudgetEscrow, leaseId: string): FinancialResult<BudgetLease> {
  const lease = escrow.leases.find((candidate) => candidate.lease_id === leaseId);
  return lease === undefined ? financialFailure('budget_lease_not_found') : financialOk(lease);
}

/** Thay một escrow trong book. */
function replaceEscrow(book: FinancialBook, escrow: BudgetEscrow): FinancialBook {
  return Object.freeze({
    ...book,
    escrows: freezeArray(
      book.escrows.map((candidate) =>
        candidate.escrow_id === escrow.escrow_id ? escrow : candidate,
      ),
    ),
  });
}

/** Tổng tiền đã cấp cho các lease đang `active`. */
function allocatedAmount(escrow: BudgetEscrow): bigint {
  let total = 0n;
  for (const lease of escrow.leases) {
    if (lease.state === 'active' || lease.state === 'exhausted') {
      total += lease.amount.minor;
    }
  }
  return total;
}

/** Escrow còn mở (chưa release) hay không. */
export function isEscrowOpen(escrow: BudgetEscrow): boolean {
  return escrow.released_at === null;
}

/** Trạng thái suy ra của một escrow — dùng cho projection và test. */
export function escrowState(escrow: BudgetEscrow): EscrowState {
  return escrow.released_at === null ? 'open' : 'released';
}

/**
 * Mở một escrow — `available → held`.
 *
 * Tiền rời available ngay khi earmark: nếu không, một lease đã cấp vẫn có thể bị
 * tiêu bởi đường khác trong cùng wallet, và "bounded risk" của §7 trở thành
 * không bounded. Idempotent theo `escrow_id`.
 */
export function openEscrow(
  book: FinancialBook,
  input: OpenEscrowInput,
): FinancialResult<EscrowOutcome> {
  if (
    !isOpaqueId(input.escrowId) ||
    !isOpaqueId(input.walletId) ||
    !isOpaqueId(input.fencingToken) ||
    !isEpochMillis(input.createdAt) ||
    !isMoney(input.amount)
  ) {
    return financialFailure('invalid_budget_lease');
  }
  if (input.amount.minor <= 0n) {
    return financialFailure('invalid_amount');
  }
  const existing = book.escrows.find((candidate) => candidate.escrow_id === input.escrowId);
  if (existing !== undefined) {
    if (
      existing.wallet_id !== input.walletId ||
      existing.amount.minor !== input.amount.minor ||
      existing.amount.denomination !== input.amount.denomination
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ book, escrow: existing, replayed: true }));
  }
  const located = locateWallet(book, input.walletId as WalletId);
  if (!located.ok) {
    return located;
  }
  const wallet = located.value.wallet;
  if (wallet.denomination !== input.amount.denomination) {
    return financialFailure('denomination_mismatch');
  }
  if (wallet.balances.available.minor < input.amount.minor) {
    return financialFailure('insufficient_available_balance');
  }
  const commit = commitTransaction(book, {
    accountId: located.value.account.billing_account_id as BillingAccountId,
    walletId: wallet.wallet_id,
    denomination: wallet.denomination,
    transactionId: derivedTransactionId('escrow', input.escrowId, 'open'),
    idempotencyKey: derivedIdempotencyKey('escrow', input.escrowId, 'open'),
    reference: referenceOf('escrow', input.escrowId),
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
  const escrow: BudgetEscrow = Object.freeze({
    escrow_id: input.escrowId,
    wallet_id: wallet.wallet_id,
    billing_account_id: wallet.billing_account_id,
    denomination: wallet.denomination,
    amount: input.amount,
    leases: freezeArray<BudgetLease>([]),
    created_at: input.createdAt,
    fencing_token: input.fencingToken as FencingToken,
    released_at: null,
    reconciliation_ref: null,
  });
  if (!isBudgetEscrow(escrow)) {
    return financialFailure('invalid_budget_lease');
  }
  return financialOk(
    Object.freeze({
      book: Object.freeze({
        ...commit.value.book,
        escrows: freezeArray([...commit.value.book.escrows, escrow]),
      }),
      escrow,
      replayed: false,
    }),
  );
}

/**
 * Cấp một lease từ phần escrow chưa allocate.
 *
 * Không post bút toán: tiền đã nằm trong `held` từ lúc mở escrow. Lease chỉ là
 * một phân bổ trong phần đã giữ, nên cấp lease không đổi balance và không thể
 * làm vượt escrow. `epoch` do caller cấp và phải đơn điệu tăng trong cùng escrow.
 */
export function issueLease(
  book: FinancialBook,
  input: IssueLeaseInput,
): FinancialResult<LeaseOutcome> {
  if (
    !isOpaqueId(input.leaseId) ||
    !isOpaqueId(input.escrowId) ||
    !isOpaqueId(input.fencingToken) ||
    !isEpochMillis(input.issuedAt) ||
    !isEpochMillis(input.expiresAt) ||
    !isMoney(input.amount)
  ) {
    return financialFailure('invalid_budget_lease');
  }
  if (input.amount.minor <= 0n) {
    return financialFailure('invalid_amount');
  }
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0 || input.expiresAt <= input.issuedAt) {
    return financialFailure('invalid_budget_lease');
  }
  const found = findEscrow(book, input.escrowId);
  if (!found.ok) {
    return found;
  }
  const escrow = found.value;
  if (!isEscrowOpen(escrow)) {
    return financialFailure('invalid_budget_lease');
  }
  if (input.amount.denomination !== escrow.denomination) {
    return financialFailure('denomination_mismatch');
  }
  const existing = escrow.leases.find((candidate) => candidate.lease_id === input.leaseId);
  if (existing !== undefined) {
    if (
      existing.escrow_id !== input.escrowId ||
      existing.amount.minor !== input.amount.minor ||
      existing.epoch !== input.epoch
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ book, lease: existing, replayed: true }));
  }
  const allocated = allocatedAmount(escrow);
  if (allocated + input.amount.minor > escrow.amount.minor) {
    return financialFailure('invalid_budget_lease');
  }
  for (const lease of escrow.leases) {
    if (lease.epoch >= input.epoch) {
      return financialFailure('invalid_budget_lease');
    }
  }
  const lease: BudgetLease = Object.freeze({
    lease_id: input.leaseId,
    escrow_id: escrow.escrow_id,
    amount: input.amount,
    epoch: input.epoch,
    fencing_token: input.fencingToken as FencingToken,
    state: 'active',
    issued_at: input.issuedAt,
    expires_at: input.expiresAt,
    reconciliation_ref: null,
    reallocated_at: null,
  });
  const nextEscrow: BudgetEscrow = Object.freeze({
    ...escrow,
    leases: freezeArray([...escrow.leases, lease]),
  });
  return financialOk(
    Object.freeze({
      book: replaceEscrow(book, nextEscrow),
      lease,
      replayed: false,
    }),
  );
}

/**
 * Thu hồi một lease đã stale — epoch mới đã vượt qua epoch của lease.
 *
 * Từ chối khi `observedEpoch <= lease.epoch` (`lease_not_stale`): một lease còn
 * là epoch hiện tại thì chưa bị fencing loại, nên thu hồi nó là bỏ qua bằng
 * chứng. Cũng từ chối nếu lease đã `revoked`.
 */
export function revokeLease(
  book: FinancialBook,
  input: RevokeLeaseInput,
): FinancialResult<LeaseOutcome> {
  if (
    !isOpaqueId(input.leaseId) ||
    !isEpochMillis(input.revokedAt) ||
    !Number.isSafeInteger(input.observedEpoch) ||
    input.observedEpoch < 0
  ) {
    return financialFailure('invalid_budget_lease');
  }
  for (const escrow of book.escrows) {
    const lease = escrow.leases.find((candidate) => candidate.lease_id === input.leaseId);
    if (lease === undefined) {
      continue;
    }
    if (lease.state === 'revoked') {
      return financialOk(Object.freeze({ book, lease, replayed: true }));
    }
    if (lease.state !== 'active') {
      return financialFailure('invalid_budget_lease');
    }
    if (input.observedEpoch <= lease.epoch) {
      return financialFailure('lease_not_stale');
    }
    const nextLease: BudgetLease = Object.freeze({
      ...lease,
      state: 'revoked',
      reallocated_at: input.revokedAt,
    });
    const nextEscrow: BudgetEscrow = Object.freeze({
      ...escrow,
      leases: freezeArray(
        escrow.leases.map((candidate) =>
          candidate.lease_id === nextLease.lease_id ? nextLease : candidate,
        ),
      ),
    });
    return financialOk(
      Object.freeze({ book: replaceEscrow(book, nextEscrow), lease: nextLease, replayed: false }),
    );
  }
  return financialFailure('budget_lease_not_found');
}

/**
 * Đóng escrow và trả phần chưa dùng về available — `held → available`.
 *
 * Hai điều kiện, cả hai đều là biểu hiện của invariant 6:
 *
 * 1. Phải có `reconciliationRef`. Không có nghĩa là chưa ai đối soát phần đã
 *    tiêu, và trả tiền lúc đó có thể trả đúp.
 * 2. Không được còn lease `active`. Một lease còn hiệu lực nghĩa là gateway có
 *    thể vẫn đang tiêu với epoch đó.
 */
export function closeEscrow(
  book: FinancialBook,
  input: CloseEscrowInput,
): FinancialResult<EscrowOutcome> {
  const found = findEscrow(book, input.escrowId);
  if (!found.ok) {
    return found;
  }
  const escrow = found.value;
  if (escrow.released_at !== null) {
    return financialOk(Object.freeze({ book, escrow, replayed: true }));
  }
  if (!isOpaqueId(input.reconciliationRef)) {
    return financialFailure('reconciliation_required');
  }
  if (!isEpochMillis(input.closedAt) || !isOpaqueId(input.fencingToken)) {
    return financialFailure('invalid_budget_lease');
  }
  if (escrow.leases.some((lease) => lease.state === 'active' || lease.state === 'exhausted')) {
    // `exhausted` nghĩa là lease đã tiêu hết phần được cấp, nhưng domain chưa mô
    // hình hoá bút toán cho phần đó — đóng escrow lúc này sẽ trả về available cả
    // phần đã tiêu. Chặn theo hướng fail-closed cho tới khi có operation ghi
    // nhận việc tiêu.
    return financialFailure('lease_not_stale');
  }
  const located = locateWallet(book, escrow.wallet_id);
  if (!located.ok) {
    return located;
  }
  const commit = commitTransaction(book, {
    accountId: located.value.account.billing_account_id,
    walletId: escrow.wallet_id,
    denomination: escrow.denomination,
    transactionId: derivedTransactionId('escrow', escrow.escrow_id, 'close'),
    idempotencyKey: derivedIdempotencyKey('escrow', escrow.escrow_id, 'close'),
    reference: referenceOf('escrow_release', escrow.escrow_id),
    fencingToken: input.fencingToken,
    createdAt: input.closedAt,
    legs: [
      { account: 'wallet_held', direction: 'credit', amount: escrow.amount },
      { account: 'wallet_available', direction: 'debit', amount: escrow.amount },
    ],
  });
  if (!commit.ok) {
    return commit;
  }
  const nextEscrow: BudgetEscrow = Object.freeze({
    ...escrow,
    released_at: input.closedAt,
    reconciliation_ref: input.reconciliationRef,
  });
  return financialOk(
    Object.freeze({
      book: replaceEscrow(commit.value.book, nextEscrow),
      escrow: nextEscrow,
      replayed: false,
    }),
  );
}

/** Tổng tiền còn giữ trong escrow — dùng cho reconciliation và test. */
export function escrowRemaining(escrow: BudgetEscrow): bigint {
  if (!isEscrowOpen(escrow)) {
    return 0n;
  }
  const remaining = escrow.amount.minor - allocatedAmount(escrow);
  return remaining > 0n ? remaining : 0n;
}

/** Trạng thái lease hiện tại — vocabulary đóng `LeaseState`. */
export type { LeaseState };
