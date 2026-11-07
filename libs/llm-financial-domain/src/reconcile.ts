/**
 * Reconciliation — đối soát **thuần**, không sửa số liệu.
 *
 * §6 của `01-architecture.md`: mismatch tạo alert + audit, **không tự sửa** số
 * liệu mà không ghi adjustment entry. Vì vậy module này không có mutation: nó
 * chỉ so sánh hai nguồn và trả một báo cáo có cấu trúc.
 *
 * Hai nguồn được so:
 *
 * - **Expected**: balance suy ra từ ledger bền vững (`deriveWalletBalances`). Đây
 *   là nguồn domain tin được, vì mọi mutation đi qua ledger.
 * - **Observed**: balance mà caller đọc từ nơi khác (projection, snapshot, ledger
 *   của `payment` qua contract). Lib không tự đọc nguồn đó.
 *
 * Kết quả phân biệt ba trạng thái thay vì một boolean: `matched`,
 * `mismatched`, và `unverifiable` (thiếu một phía để so). Một boolean sẽ gộp
 * "không có dữ liệu" với "dữ liệu khớp", và đó là cách một khoảng trống đối soát
 * trở thành một tín hiệu xanh giả.
 */

import type { FinancialBook } from './book';
import { deriveWalletBalances } from './ledger';
import { isMoney, type Denomination, type Money } from './money';
import {
  financialFailure,
  financialOk,
  isOpaqueId,
  type FinancialResult,
  type WalletId,
} from './shared';

/** Trạng thái của một lần đối soát. */
export const RECONCILIATION_STATUSES = ['matched', 'mismatched', 'unverifiable'] as const;

/** Trạng thái đối soát. */
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** Một balance quan sát được từ nguồn ngoài. */
export interface ObservedBalances {
  readonly available: Money;
  readonly held: Money;
  readonly charged: Money;
  readonly total: Money;
}

/** Input của `reconcileWallet`. */
export interface ReconcileWalletInput {
  readonly walletId: string;
  readonly denomination: Denomination;
  /** `null` khi chưa đọc được nguồn ngoài — trạng thái sẽ là `unverifiable`. */
  readonly observed: ObservedBalances | null;
  readonly checkedAt: number;
}

/** Chênh lệch của một balance. */
export interface BalanceDiscrepancy {
  readonly field: 'available' | 'held' | 'charged' | 'total';
  readonly expected: Money;
  readonly observed: Money;
}

/** Báo cáo đối soát — dữ liệu thuần, caller quyết định alert/audit. */
export interface ReconciliationReport {
  readonly walletId: WalletId;
  readonly denomination: Denomination;
  readonly status: ReconciliationStatus;
  readonly expected: ObservedBalances | null;
  readonly observed: ObservedBalances | null;
  readonly discrepancies: readonly BalanceDiscrepancy[];
  readonly checkedAt: number;
}

/** Kiểm một nhóm balance quan sát được có đúng hình dạng và bất biến không. */
function isObservedBalances(value: unknown): value is ObservedBalances {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<ObservedBalances>;
  const { available, held, charged, total } = candidate;
  if (!isMoney(available) || !isMoney(held) || !isMoney(charged) || !isMoney(total)) {
    return false;
  }
  return (
    available.denomination === held.denomination &&
    available.denomination === charged.denomination &&
    available.denomination === total.denomination
  );
}

/** So sánh hai nhóm balance và liệt kê chênh lệch. */
function compareBalances(
  expected: ObservedBalances,
  observed: ObservedBalances,
): readonly BalanceDiscrepancy[] {
  const fields = ['available', 'held', 'charged', 'total'] as const;
  const discrepancies: BalanceDiscrepancy[] = [];
  for (const field of fields) {
    if (expected[field].minor !== observed[field].minor) {
      discrepancies.push(
        Object.freeze({ field, expected: expected[field], observed: observed[field] }),
      );
    }
  }
  return Object.freeze(discrepancies);
}

/**
 * Đối soát balance của một wallet giữa ledger và nguồn quan sát.
 *
 * Không mutation. Wallet không tồn tại trong book vẫn trả `unverifiable` nếu
 * caller chưa quan sát được, hoặc `invalid_wallet` nếu input sai hình dạng —
 * nhưng không bao giờ "matched" khi chưa có gì để so.
 */
export function reconcileWallet(
  book: FinancialBook,
  input: ReconcileWalletInput,
): FinancialResult<ReconciliationReport> {
  if (
    !isOpaqueId(input.walletId) ||
    !Number.isSafeInteger(input.checkedAt) ||
    (input.denomination !== 'UC' && input.denomination !== 'EC')
  ) {
    return financialFailure('invalid_reconciliation');
  }
  if (input.observed !== null && !isObservedBalances(input.observed)) {
    return financialFailure('invalid_reconciliation');
  }
  if (
    input.observed !== null &&
    (input.observed.available.denomination !== input.denomination ||
      input.observed.total.denomination !== input.denomination)
  ) {
    return financialFailure('denomination_mismatch');
  }
  const expected = deriveWalletBalances(
    book.ledger,
    input.walletId as WalletId,
    input.denomination,
  );
  if (!expected.ok) {
    return expected;
  }
  const expectedBalances: ObservedBalances = Object.freeze({
    available: expected.value.available,
    held: expected.value.held,
    charged: expected.value.charged,
    total: expected.value.total,
  });
  if (input.observed === null) {
    return financialOk(
      Object.freeze({
        walletId: input.walletId as WalletId,
        denomination: input.denomination,
        status: 'unverifiable' as const,
        expected: expectedBalances,
        observed: null,
        discrepancies: Object.freeze([]),
        checkedAt: input.checkedAt,
      }),
    );
  }
  const discrepancies = compareBalances(expectedBalances, input.observed);
  return financialOk(
    Object.freeze({
      walletId: input.walletId as WalletId,
      denomination: input.denomination,
      status: discrepancies.length === 0 ? ('matched' as const) : ('mismatched' as const),
      expected: expectedBalances,
      observed: input.observed,
      discrepancies,
      checkedAt: input.checkedAt,
    }),
  );
}

/**
 * Kiểm bất biến conservation của một balance bất kỳ — dùng như cổng trước khi
 * nhận một snapshot từ nguồn ngoài.
 *
 * Trả về `null` khi đúng, hoặc mô tả field lệch. Đây không phải reconciliation
 * (không so hai nguồn) mà là kiểm cấu trúc nội tại của một snapshot.
 */
export function findConservationViolation(balances: ObservedBalances): BalanceDiscrepancy | null {
  const summed = balances.available.minor + balances.held.minor + balances.charged.minor;
  if (summed === balances.total.minor) {
    return null;
  }
  return Object.freeze({
    field: 'total',
    // `expected` phải là tổng của ba balance, không phải một trong ba — nếu không
    // báo cáo in ra một con số không liên quan tới field `total` đang lệch.
    expected: Object.freeze({ denomination: balances.total.denomination, minor: summed }),
    observed: balances.total,
  });
}
