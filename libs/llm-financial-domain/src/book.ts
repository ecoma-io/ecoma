/**
 * `FinancialBook` — aggregate root của tầng domain `llm-financial`.
 *
 * Book giữ **toàn bộ** state mà lib này sở hữu (billing account + wallet, ledger,
 * deposit, reservation, customer charge, seller payable, conversion) và là nơi
 * duy nhất biến một operation thành bút toán. Mọi operation công khai nhận book,
 * trả book mới; không operation nào mutate book nhận vào.
 *
 * Vì sao balance là **projection của ledger** chứ không phải state tự do: nếu
 * balance và ledger là hai nguồn có thể lệch, invariant 5 (`available + held +
 * charged = total`) trở thành một lời hứa thay vì một bất biến. Ở đây mỗi
 * operation post transaction trước, rồi **suy lại** ba balance từ ledger bằng
 * `deriveWalletBalances`. Không có đường nào để balance đi trước ledger.
 *
 * Quy ước định danh: caller cấp id của entity nghiệp vụ (reservation,
 * settlement, refund, conversion...); ledger transaction id và entry id được
 * suy ra **tất định** từ id đó (`<entity>:<operation>` và `<tx>#<index>`), nên
 * replay cùng input sinh cùng id và không cần randomness.
 */

import {
  deriveWalletBalances,
  isLedger,
  createLedger,
  postTransaction,
  createLedgerTransaction,
  type Ledger,
  type LedgerAccount,
  type LedgerDirection,
  type LedgerReference,
  type LedgerTransaction,
} from './ledger';
import type { Denomination, Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  type BillingAccountId,
  type FinancialResult,
  type WalletId,
} from './shared';
import {
  isBillingAccount,
  replaceWallet,
  type BillingAccount,
  type Deposit,
  type Wallet,
} from './wallet';
import type {
  BudgetEscrow,
  ChargeAdjustment,
  Conversion,
  CustomerCharge,
  FinancialAuditEntry,
  FinancialHold,
  Refund,
  Reservation,
  SellerPayable,
} from './records';

/** Một leg do operation yêu cầu; entry id do book suy ra. */
export interface RequestedLeg {
  readonly account: LedgerAccount;
  readonly direction: LedgerDirection;
  readonly amount: Money;
}

/**
 * Ledger transaction id tất định của một operation trên một entity.
 *
 * Ví dụ `reservation:rsv_1:hold`. Sinh từ id caller cấp nên replay cùng input
 * luôn trỏ cùng transaction.
 */
export function derivedTransactionId(
  entityType: string,
  entityId: string,
  operation: string,
): string {
  return `${entityType}:${entityId}:${operation}`;
}

/** Idempotency key tất định của một operation trên một entity. */
export function derivedIdempotencyKey(
  entityType: string,
  entityId: string,
  operation: string,
): string {
  return `idem:${entityType}:${entityId}:${operation}`;
}

/** State đầy đủ do `llm-financial` sở hữu. */
export interface FinancialBook {
  readonly accounts: readonly BillingAccount[];
  readonly ledger: Ledger;
  readonly deposits: readonly Deposit[];
  readonly reservations: readonly Reservation[];
  readonly charges: readonly CustomerCharge[];
  readonly refunds: readonly Refund[];
  readonly adjustments: readonly ChargeAdjustment[];
  readonly payables: readonly SellerPayable[];
  readonly holds: readonly FinancialHold[];
  readonly escrows: readonly BudgetEscrow[];
  readonly conversions: readonly Conversion[];
  readonly audit: readonly FinancialAuditEntry[];
}

/** Tạo book rỗng. */
export function openFinancialBook(): FinancialBook {
  return Object.freeze({
    accounts: freezeArray<BillingAccount>([]),
    ledger: createLedger(),
    deposits: freezeArray<Deposit>([]),
    reservations: freezeArray<Reservation>([]),
    charges: freezeArray<CustomerCharge>([]),
    refunds: freezeArray<Refund>([]),
    adjustments: freezeArray<ChargeAdjustment>([]),
    payables: freezeArray<SellerPayable>([]),
    holds: freezeArray<FinancialHold>([]),
    escrows: freezeArray<BudgetEscrow>([]),
    conversions: freezeArray<Conversion>([]),
    audit: freezeArray<FinancialAuditEntry>([]),
  });
}

/** Thêm billing account; từ chối account trùng id. */
export function addBillingAccount(
  book: FinancialBook,
  account: BillingAccount,
): FinancialResult<FinancialBook> {
  if (!isBillingAccount(account)) {
    return financialFailure('invalid_wallet');
  }
  if (
    book.accounts.some((candidate) => candidate.billing_account_id === account.billing_account_id)
  ) {
    return financialFailure('invalid_wallet');
  }
  return financialOk(
    Object.freeze({ ...book, accounts: freezeArray([...book.accounts, account]) }),
  );
}

/** Tìm billing account theo id. */
export function findBillingAccount(
  book: FinancialBook,
  accountId: BillingAccountId,
): FinancialResult<BillingAccount> {
  const account = book.accounts.find((candidate) => candidate.billing_account_id === accountId);
  return account === undefined ? financialFailure('invalid_wallet') : financialOk(account);
}

/**
 * Tìm wallet theo id trên toàn book. Trả cả account chứa nó để operation ghi
 * ngược state mà không phải truyền account id riêng.
 */
export function locateWallet(
  book: FinancialBook,
  walletId: WalletId,
): FinancialResult<{ account: BillingAccount; wallet: Wallet }> {
  for (const account of book.accounts) {
    const wallet = account.wallets.find((candidate) => candidate.wallet_id === walletId);
    if (wallet !== undefined) {
      return financialOk({ account, wallet });
    }
  }
  return financialFailure('wallet_not_found');
}

/** Thay một wallet trong book bằng state mới. */
export function replaceWalletInBook(
  book: FinancialBook,
  accountId: BillingAccountId,
  wallet: Wallet,
): FinancialResult<FinancialBook> {
  const account = book.accounts.find((candidate) => candidate.billing_account_id === accountId);
  if (account === undefined) {
    return financialFailure('invalid_wallet');
  }
  const replaced = replaceWallet(account, wallet);
  if (!replaced.ok) {
    return replaced;
  }
  return financialOk(
    Object.freeze({
      ...book,
      accounts: freezeArray(
        book.accounts.map((candidate) =>
          candidate.billing_account_id === accountId ? replaced.value : candidate,
        ),
      ),
    }),
  );
}

/** Input của `commitTransaction`. */
export interface CommitTransactionInput {
  readonly accountId: BillingAccountId;
  readonly walletId: WalletId;
  readonly denomination: Denomination;
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly reference: LedgerReference;
  readonly fencingToken: string;
  readonly createdAt: number;
  readonly legs: readonly RequestedLeg[];
}

/** Kết quả commit: book mới (hoặc book gốc khi replay), transaction, và cờ replay. */
export interface CommitTransactionOutcome {
  readonly book: FinancialBook;
  readonly transaction: LedgerTransaction;
  readonly replayed: boolean;
}

/**
 * Post một transaction và suy lại balance của wallet từ ledger.
 *
 * Đây là **điểm duy nhất** trong lib làm thay đổi balance. Nó không tự kiểm
 * nghiệp vụ (đủ tiền, đúng state) — operation gọi nó chịu trách nhiệm kiểm trước;
 * nhưng nó luôn bảo đảm transaction cân bằng và balance khớp ledger.
 */
export function commitTransaction(
  book: FinancialBook,
  input: CommitTransactionInput,
): FinancialResult<CommitTransactionOutcome> {
  const located = locateWallet(book, input.walletId);
  if (!located.ok) {
    return located;
  }
  if (located.value.wallet.billing_account_id !== input.accountId) {
    return financialFailure('invalid_wallet');
  }
  if (located.value.wallet.denomination !== input.denomination) {
    return financialFailure('denomination_mismatch');
  }
  if (input.fencingToken !== located.value.wallet.fencing_token) {
    return financialFailure('stale_fencing_token');
  }
  const legs = input.legs.map((leg, index) => ({
    entry_id: `${input.transactionId}#${index}`,
    account: leg.account,
    direction: leg.direction,
    amount: leg.amount,
  }));
  const transaction = createLedgerTransaction({
    transactionId: input.transactionId,
    idempotencyKey: input.idempotencyKey,
    walletId: input.walletId,
    billingAccountId: input.accountId,
    denomination: input.denomination,
    legs,
    reference: input.reference,
    fencingToken: input.fencingToken,
    createdAt: input.createdAt,
  });
  if (!transaction.ok) {
    return transaction;
  }
  const posted = postTransaction(book.ledger, transaction.value);
  if (!posted.ok) {
    return posted;
  }
  if (posted.value.replayed) {
    return financialOk(
      Object.freeze({ book, transaction: posted.value.transaction, replayed: true }),
    );
  }
  const balances = deriveWalletBalances(posted.value.ledger, input.walletId, input.denomination);
  if (!balances.ok) {
    return balances;
  }
  const nextWallet: Wallet = Object.freeze({
    ...located.value.wallet,
    balances: balances.value,
  });
  const nextBook = replaceWalletInBook(book, input.accountId, nextWallet);
  if (!nextBook.ok) {
    return nextBook;
  }
  return financialOk(
    Object.freeze({
      book: Object.freeze({ ...nextBook.value, ledger: posted.value.ledger }),
      transaction: posted.value.transaction,
      replayed: false,
    }),
  );
}

/** Book với ledger mới nhưng state khác giữ nguyên — helper cho operation không đổi balance. */
export function withLedger(book: FinancialBook, ledger: Ledger): FinancialResult<FinancialBook> {
  if (!isLedger(ledger)) {
    return financialFailure('invalid_ledger_transaction');
  }
  return financialOk(Object.freeze({ ...book, ledger }));
}
