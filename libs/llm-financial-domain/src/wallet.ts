/**
 * Billing account và wallet.
 *
 * Một billing account là danh tính tài chính của consumer, trỏ tới owner bằng
 * `AccountOwnerRef` opaque — không FK xuyên database, và không thay thế Seller
 * tenant identity (ADR-0001, ADR-0003). Một billing account có thể có nhiều
 * wallet, mỗi wallet thuộc đúng một **denomination domain** (`UC` hoặc `EC`);
 * không mô hình hoá ví đa tiền tệ (ADR-0004).
 *
 * Bất biến balance (invariant 5 của `01-architecture.md`):
 *
 * ```
 * available >= 0, held >= 0, charged >= 0
 * available + held + charged = total
 * ```
 *
 * `total` chỉ đổi qua credit (nạp tiền) và compensating entry của một deposit bị
 * reversed. Mọi operation khác chỉ di chuyển tiền **giữa** ba balance: reserve
 * `available → held`, capture `held → charged`, release `held → available`. Vì
 * vậy không operation nào có thể làm mất hoặc sinh ra tiền mà không nằm trong
 * `total`.
 *
 * Lib này **không** sở hữu provider cost; không có wallet hay account nào đại
 * diện cho chi phí provider.
 */

import { llmFinancialDomainError, type LlmFinancialDomainError } from './errors';
import {
  financialFailure,
  financialOk,
  isOpaqueId,
  type BillingAccountId,
  type FencingToken,
  type FinancialResult,
  type WalletId,
} from './shared';
import { MAX_MONEY_MAGNITUDE, addMoney, createMoney, type Denomination, type Money } from './money';

/**
 * Ba balance đã validate của một wallet trong một denomination domain.
 *
 * `total` là **derived**: dựng qua `createWalletBalances`, không phải field tự do.
 */
export interface WalletBalances<D extends Denomination = Denomination> {
  readonly available: Money<D>;
  readonly held: Money<D>;
  readonly charged: Money<D>;
  readonly total: Money<D>;
}

/** Trạng thái deposit/credit. */
export const DEPOSIT_STATES = ['pending', 'credited', 'reversed'] as const;

/** Trạng thái của một lần nạp tiền. */
export type DepositState = (typeof DEPOSIT_STATES)[number];

/** Type guard cho `DepositState`. */
export function isDepositState(value: unknown): value is DepositState {
  return typeof value === 'string' && (DEPOSIT_STATES as readonly string[]).includes(value);
}

/**
 * Một lần credit vào wallet (top-up, refund credit, adjustment credit).
 *
 * `state` đi `pending → credited → reversed` theo §4.1 của architecture. Một
 * deposit `reversed` phải sinh compensating entry, giữ nguyên bất biến
 * conservation: lib không có đường nào "giảm total" mà không ghi bút toán đối
 * ứng (xem `reverseCredit` trong `operations.ts`).
 */
export interface Deposit<D extends Denomination = Denomination> {
  readonly deposit_id: string;
  readonly wallet_id: WalletId;
  readonly amount: Money<D>;
  readonly state: DepositState;
  readonly created_at: number;
  /** Tham chiếu opaque tới bằng chứng payment — `payment` sở hữu nó (ADR-0009). */
  readonly payment_reference: string;
}

/** Wallet: danh tính + denomination domain + balance hiện tại. */
export interface Wallet<D extends Denomination = Denomination> {
  readonly wallet_id: WalletId;
  readonly billing_account_id: BillingAccountId;
  readonly denomination: D;
  readonly balances: WalletBalances<D>;
  /**
   * Fencing token đang hiệu lực của wallet.
   *
   * Mọi operation di chuyển tiền phải trình đúng token này và bút toán được
   * đóng dấu bằng nó. Khi financial admission chuyển sang epoch mới, token được
   * rotate; operation của epoch cũ vì thế bị từ chối (`stale_fencing_token`) thay
   * vì được tin theo thứ tự thời gian — đây là cơ chế fencing mà invariant 6 đòi
   * hỏi trước khi reallocate escrow.
   */
  readonly fencing_token: FencingToken;
}

/** Billing account: danh tính tài chính, trỏ tới owner opaque. */
export interface BillingAccount {
  readonly billing_account_id: BillingAccountId;
  readonly owner_ref: string;
  readonly created_at: number;
  readonly wallets: readonly Wallet[];
}

/**
 * Dựng `WalletBalances` từ ba balance, kiểm bất biến conservation và
 * non-negative.
 *
 * @throws Không ném — trả domain error. `total` **không** được truyền vào: nếu
 * caller tự khai `total` thì bất biến `available + held + charged = total` trở
 * thành một assertion thay vì một định nghĩa.
 */
export function createWalletBalances<D extends Denomination>(input: {
  available: Money<D>;
  held: Money<D>;
  charged: Money<D>;
}): FinancialResult<WalletBalances<D>> {
  const { available, held, charged } = input;
  if (
    available.denomination !== held.denomination ||
    available.denomination !== charged.denomination
  ) {
    return financialFailure('denomination_mismatch');
  }
  if (isNegative(available) || isNegative(held) || isNegative(charged)) {
    return financialFailure('invalid_wallet');
  }
  const availablePlusHeld = addMoney(available, held);
  if (!availablePlusHeld.ok) {
    return financialFailure('amount_overflow');
  }
  const total = addMoney(availablePlusHeld.value, charged);
  if (!total.ok) {
    return financialFailure('amount_overflow');
  }
  return financialOk(Object.freeze({ available, held, charged, total: total.value }));
}

/** Kiểm một `Money` là số âm — dùng cho dữ liệu đọc từ ngoài, nơi `Money` chưa được validate. */
function isNegative(money: Money): boolean {
  return money.minor < 0n;
}

/** Type guard cấu trúc + bất biến conservation cho `WalletBalances`. */
export function isWalletBalances<D extends Denomination = Denomination>(
  value: unknown,
): value is WalletBalances<D> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<WalletBalances>;
  const { available, held, charged, total } = candidate;
  if (
    !isMoneyLike(available) ||
    !isMoneyLike(held) ||
    !isMoneyLike(charged) ||
    !isMoneyLike(total)
  ) {
    return false;
  }
  if (
    available.denomination !== held.denomination ||
    available.denomination !== charged.denomination ||
    available.denomination !== total.denomination
  ) {
    return false;
  }
  if (available.minor < 0n || held.minor < 0n || charged.minor < 0n || total.minor < 0n) {
    return false;
  }
  return available.minor + held.minor + charged.minor === total.minor;
}

/** Type guard tối thiểu cho một `Money` trong dữ liệu ngoài. */
function isMoneyLike(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { denomination?: unknown; minor?: unknown };
  return (
    (candidate.denomination === 'UC' || candidate.denomination === 'EC') &&
    typeof candidate.minor === 'bigint' &&
    candidate.minor >= 0n &&
    candidate.minor <= MAX_MONEY_MAGNITUDE
  );
}

/** Tạo wallet mới với balance zero — một wallet luôn bắt đầu bằng bất biến đúng. */
export function createWallet(input: {
  walletId: string;
  billingAccountId: string;
  denomination: Denomination;
  fencingToken: string;
}): FinancialResult<Wallet> {
  if (
    !isOpaqueId(input.walletId) ||
    !isOpaqueId(input.billingAccountId) ||
    !isOpaqueId(input.fencingToken)
  ) {
    return financialFailure('invalid_id');
  }
  const zero = createMoney(input.denomination, 0n);
  if (!zero.ok) {
    return financialFailure('invalid_denomination');
  }
  const balances = createWalletBalances({
    available: zero.value,
    held: zero.value,
    charged: zero.value,
  });
  if (!balances.ok) {
    return financialFailure('invalid_wallet');
  }
  return financialOk(
    Object.freeze({
      wallet_id: input.walletId as WalletId,
      billing_account_id: input.billingAccountId as BillingAccountId,
      denomination: input.denomination,
      balances: balances.value,
      fencing_token: input.fencingToken as FencingToken,
    }),
  );
}

/** Type guard cho `Wallet`. */
export function isWallet(value: unknown): value is Wallet {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const wallet = value as Partial<Wallet>;
  return (
    isOpaqueId(wallet.wallet_id) &&
    isOpaqueId(wallet.billing_account_id) &&
    (wallet.denomination === 'UC' || wallet.denomination === 'EC') &&
    isWalletBalances(wallet.balances) &&
    wallet.balances.available.denomination === wallet.denomination &&
    isOpaqueId(wallet.fencing_token)
  );
}

/** Tạo billing account rỗng (chưa có wallet). */
export function createBillingAccount(input: {
  billingAccountId: string;
  ownerRef: string;
  createdAt: number;
}): FinancialResult<BillingAccount> {
  if (!isOpaqueId(input.billingAccountId) || !isOpaqueId(input.ownerRef)) {
    return financialFailure('invalid_id');
  }
  if (!Number.isSafeInteger(input.createdAt)) {
    return financialFailure('invalid_epoch_millis');
  }
  return financialOk(
    Object.freeze({
      billing_account_id: input.billingAccountId as BillingAccountId,
      owner_ref: input.ownerRef,
      created_at: input.createdAt,
      wallets: Object.freeze([]) as readonly Wallet[],
    }),
  );
}

/** Type guard cho `BillingAccount`. */
export function isBillingAccount(value: unknown): value is BillingAccount {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const account = value as Partial<BillingAccount>;
  return (
    isOpaqueId(account.billing_account_id) &&
    isOpaqueId(account.owner_ref) &&
    Number.isSafeInteger(account.created_at) &&
    Array.isArray(account.wallets) &&
    account.wallets.every(
      (wallet) => isWallet(wallet) && wallet.billing_account_id === account.billing_account_id,
    ) &&
    new Set(account.wallets.map((wallet) => wallet.denomination)).size === account.wallets.length
  );
}

/** Tìm wallet theo id. */
export function findWallet(account: BillingAccount, walletId: WalletId): FinancialResult<Wallet> {
  const wallet = account.wallets.find((candidate) => candidate.wallet_id === walletId);
  return wallet === undefined ? financialFailure('wallet_not_found') : financialOk(wallet);
}

/** Tìm wallet theo denomination domain. */
export function findWalletByDenomination(
  account: BillingAccount,
  denomination: Denomination,
): FinancialResult<Wallet> {
  const wallet = account.wallets.find((candidate) => candidate.denomination === denomination);
  return wallet === undefined ? financialFailure('wallet_not_found') : financialOk(wallet);
}

/** Thay một wallet trong account bằng state mới (append-only ở tầng account). */
export function replaceWallet(
  account: BillingAccount,
  wallet: Wallet,
): FinancialResult<BillingAccount> {
  // Cùng hai bất biến cấu trúc mà `attachWallet` bảo vệ và `isBillingAccount`
  // hậu kiểm: wallet thuộc đúng account, và mỗi denomination chỉ có một wallet.
  // Không kiểm ở đây thì `replaceWallet` là đường vòng để tạo state mà chính
  // `isBillingAccount` sẽ từ chối.
  if (wallet.billing_account_id !== account.billing_account_id) {
    return financialFailure('invalid_wallet');
  }
  const index = account.wallets.findIndex((candidate) => candidate.wallet_id === wallet.wallet_id);
  if (index === -1) {
    return financialFailure('wallet_not_found');
  }
  if (
    account.wallets.some(
      (candidate, position) => position !== index && candidate.denomination === wallet.denomination,
    )
  ) {
    return financialFailure('invalid_wallet');
  }
  const wallets = [...account.wallets];
  wallets[index] = wallet;
  return financialOk(Object.freeze({ ...account, wallets: Object.freeze(wallets) }));
}

/** Thêm wallet mới vào account; từ chối wallet trùng id hoặc trùng denomination. */
export function attachWallet(
  account: BillingAccount,
  wallet: Wallet,
): FinancialResult<BillingAccount> {
  if (wallet.billing_account_id !== account.billing_account_id) {
    return financialFailure('invalid_wallet');
  }
  if (
    account.wallets.some(
      (candidate) =>
        candidate.wallet_id === wallet.wallet_id || candidate.denomination === wallet.denomination,
    )
  ) {
    return financialFailure('invalid_wallet');
  }
  return financialOk(
    Object.freeze({ ...account, wallets: Object.freeze([...account.wallets, wallet]) }),
  );
}

/**
 * Kiểm bất biến conservation của một wallet ở runtime.
 *
 * Trả về domain error khi balance không còn khớp `available + held + charged =
 * total` hoặc khi có balance âm; trả `null` khi đúng. Đây là cổng để consumer
 * (persistence, projection) kiểm lại state đọc từ ngoài trước khi tin nó.
 */
export function checkWalletInvariant(wallet: Wallet): LlmFinancialDomainError | null {
  if (!isWallet(wallet)) {
    return llmFinancialDomainError('invalid_wallet');
  }
  const { available, held, charged, total } = wallet.balances;
  if (available.minor + held.minor + charged.minor !== total.minor) {
    return llmFinancialDomainError('wallet_invariant_violation');
  }
  return null;
}
