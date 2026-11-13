/**
 * Double-entry ledger của `llm-financial` — append-only, cân bằng theo từng
 * transaction.
 *
 * Ba bất biến được mã hoá ở đây:
 *
 * 1. **Double-entry**: mỗi transaction có tổng debit = tổng credit. Một
 *    transaction lệch bị từ chối trước khi vào ledger.
 * 2. **Append-only**: public surface chỉ có `createLedger` và `postTransaction`.
 *    Không có update/delete; sửa sai bằng transaction mới (refund/adjustment).
 * 3. **Idempotency**: post lại cùng `idempotency_key` với cùng nội dung trả về
 *    đúng transaction gốc; cùng key nhưng nội dung khác là domain error
 *    `idempotency_conflict`.
 *
 * Một transaction thuộc đúng một wallet và một denomination domain: entry của
 * UC và EC không bao giờ nằm chung một transaction, nên phép "cân" không thể vô
 * tình cộng hai miền giá trị khác nhau. Conversion EC→UC vì vậy sinh hai
 * transaction riêng, mỗi bên cân bằng trong ledger của account tương ứng
 * (ADR-0005).
 *
 * Mọi ledger entry mang `fencing_token` của operation đã sinh ra nó; token này
 * cho phép consumer từ chối một operation cũ (stale epoch) thay vì tin vào thứ
 * tự thời gian.
 */

import type { LlmFinancialDomainErrorCode } from './errors';
import { isMoney, zeroMoney, type Denomination, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type BillingAccountId,
  type FencingToken,
  type FinancialResult,
  type IdempotencyKey,
  type LedgerEntryId,
  type LedgerTransactionId,
  type WalletId,
} from './shared';
import type { WalletBalances } from './wallet';

/**
 * Account vocabulary của ledger.
 *
 * Đây là vocabulary **đóng**: một account lạ nghĩa là một phép di chuyển tiền
 * chưa được domain định nghĩa, nên bị từ chối thay vì được ghi vào sổ.
 *
 * - `wallet_available`, `wallet_held`, `wallet_charged`: ba balance của wallet.
 * - `funding_clearing`: đối ứng khi tiền vào/ra ledger từ nguồn ngoài (deposit).
 * - `earnings_clearing`: đối ứng khi EC earnings được credit vào ví seller.
 * - `conversion_clearing`: đối ứng của một leg conversion EC→UC.
 * - `sponsor_funding_clearing`: đối ứng của grant tài trợ nội bộ (ADR-0028 §4)
 *   — nguồn riêng, không tái dùng `funding_clearing` của deposit `payment`.
 */
export const LEDGER_ACCOUNTS = [
  'wallet_available',
  'wallet_held',
  'wallet_charged',
  'funding_clearing',
  'earnings_clearing',
  'conversion_clearing',
  'sponsor_funding_clearing',
] as const;

/** Một ledger account. */
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

/** Type guard cho `LedgerAccount`. */
export function isLedgerAccount(value: unknown): value is LedgerAccount {
  return typeof value === 'string' && (LEDGER_ACCOUNTS as readonly string[]).includes(value);
}

/** Chiều của một ledger leg. */
export const LEDGER_DIRECTIONS = ['debit', 'credit'] as const;

/** Chiều debit/credit. */
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

/** Type guard cho `LedgerDirection`. */
export function isLedgerDirection(value: unknown): value is LedgerDirection {
  return typeof value === 'string' && (LEDGER_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * Loại nguồn tham chiếu của một transaction/entry.
 *
 * `reference.id` trỏ tới entity đã sinh ra bút toán (reservation, settlement,
 * refund, conversion...). Reference là **immutable**: không có operation nào sửa
 * lại reference của một entry đã post.
 */
export const LEDGER_REFERENCE_TYPES = [
  'credit',
  'credit_reversal',
  'reservation',
  'reservation_capture',
  'reservation_release',
  'settlement',
  'refund',
  'charge_adjustment',
  'conversion',
  'escrow',
  'escrow_release',
  'earning',
  'sponsor_grant',
  'sponsor_grant_reversal',
] as const;

/** Loại nguồn tham chiếu. */
export type LedgerReferenceType = (typeof LEDGER_REFERENCE_TYPES)[number];

/** Type guard cho `LedgerReferenceType`. */
export function isLedgerReferenceType(value: unknown): value is LedgerReferenceType {
  return typeof value === 'string' && (LEDGER_REFERENCE_TYPES as readonly string[]).includes(value);
}

/** Tham chiếu nguồn của một bút toán. */
export interface LedgerReference {
  readonly type: LedgerReferenceType;
  readonly id: string;
}

/** Type guard cho `LedgerReference`. */
export function isLedgerReference(value: unknown): value is LedgerReference {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { type?: unknown; id?: unknown };
  return isLedgerReferenceType(candidate.type) && isOpaqueId(candidate.id);
}

/** Một leg của transaction — chưa gắn `transaction_id` (transaction tự gắn). */
export interface LedgerLeg {
  readonly entry_id: LedgerEntryId;
  readonly account: LedgerAccount;
  readonly direction: LedgerDirection;
  readonly amount: Money;
}

/** Một entry đã post trong ledger. */
export interface LedgerEntry extends LedgerLeg {
  readonly transaction_id: LedgerTransactionId;
  readonly wallet_id: WalletId;
  readonly billing_account_id: BillingAccountId;
  readonly denomination: Denomination;
  readonly fencing_token: FencingToken;
  readonly created_at: number;
  readonly reference: LedgerReference;
}

/** Một transaction đã post. */
export interface LedgerTransaction {
  readonly transaction_id: LedgerTransactionId;
  readonly idempotency_key: IdempotencyKey;
  readonly wallet_id: WalletId;
  readonly billing_account_id: BillingAccountId;
  readonly denomination: Denomination;
  readonly entries: readonly LedgerEntry[];
  readonly reference: LedgerReference;
  readonly fencing_token: FencingToken;
  readonly created_at: number;
  /** Vân tay nội dung — dùng để phân biệt replay với conflicting replay. */
  readonly fingerprint: string;
}

/** Ledger append-only: chỉ là danh sách transaction đã post. */
export interface Ledger {
  readonly transactions: readonly LedgerTransaction[];
}

/** Tạo ledger rỗng. */
export function createLedger(): Ledger {
  return Object.freeze({ transactions: freezeArray<LedgerTransaction>([]) });
}

/** Type guard cấu trúc cho `LedgerEntry`. */
export function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<LedgerEntry>;
  return (
    isOpaqueId(entry.entry_id) &&
    isOpaqueId(entry.transaction_id) &&
    isOpaqueId(entry.wallet_id) &&
    isOpaqueId(entry.billing_account_id) &&
    isLedgerAccount(entry.account) &&
    isLedgerDirection(entry.direction) &&
    isMoney(entry.amount) &&
    isOpaqueId(entry.fencing_token) &&
    isEpochMillis(entry.created_at) &&
    isLedgerReference(entry.reference) &&
    entry.amount.denomination === entry.denomination
  );
}

/** Type guard cấu trúc cho `LedgerTransaction`, kể cả bất biến cân bằng. */
export function isLedgerTransaction(value: unknown): value is LedgerTransaction {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const tx = value as Partial<LedgerTransaction>;
  if (
    !isOpaqueId(tx.transaction_id) ||
    !isOpaqueId(tx.idempotency_key) ||
    !isOpaqueId(tx.wallet_id) ||
    !isOpaqueId(tx.billing_account_id) ||
    !isOpaqueId(tx.fencing_token) ||
    !isEpochMillis(tx.created_at) ||
    !isLedgerReference(tx.reference) ||
    typeof tx.fingerprint !== 'string' ||
    !Array.isArray(tx.entries) ||
    tx.entries.length < 2
  ) {
    return false;
  }
  const entries = tx.entries as readonly LedgerEntry[];
  if (!entries.every((entry) => isLedgerEntry(entry))) {
    return false;
  }
  if (
    !entries.every(
      (entry) =>
        entry.transaction_id === tx.transaction_id &&
        entry.wallet_id === tx.wallet_id &&
        entry.billing_account_id === tx.billing_account_id &&
        entry.fencing_token === tx.fencing_token &&
        entry.created_at === tx.created_at &&
        entry.reference.type === tx.reference?.type &&
        entry.reference.id === tx.reference?.id,
    )
  ) {
    return false;
  }
  if (!entries.every((entry) => entry.denomination === tx.denomination)) {
    return false;
  }
  const entryIds = new Set(entries.map((entry) => entry.entry_id));
  if (entryIds.size !== entries.length) {
    return false;
  }
  return balanceOf(entries) !== null;
}

/** Tổng debit/credit của các entry; `null` khi lệch hoặc sai denomination. */
function balanceOf(entries: readonly LedgerEntry[]): { debit: bigint; credit: bigint } | null {
  let debit = 0n;
  let credit = 0n;
  const denomination = entries[0]?.denomination;
  for (const entry of entries) {
    if (entry.denomination !== denomination) {
      return null;
    }
    if (entry.direction === 'debit') {
      debit += entry.amount.minor;
    } else {
      credit += entry.amount.minor;
    }
  }
  return debit === credit ? { debit, credit } : null;
}

/**
 * Vân tay nội dung của một transaction.
 *
 * Chỉ gồm phần **ngữ nghĩa** — wallet, denomination, reference, và danh sách leg
 * (account, direction, amount) theo đúng thứ tự operation khai báo — nên cùng
 * một payload dựng lại với entry id khác vẫn là replay, còn đổi
 * amount/direction/wallet/thứ tự là conflict. Không sort: thứ tự leg là một phần
 * của payload, và lib giữ nguyên nó thay vì tự chuẩn hoá ngầm.
 */
function fingerprintOf(input: {
  walletId: string;
  billingAccountId: string;
  denomination: string;
  reference: LedgerReference;
  legs: readonly LedgerLeg[];
}): string {
  const legs = input.legs
    .map((leg) => `${leg.account}:${leg.direction}:${leg.amount.minor.toString()}`)
    .join(',');
  return [
    input.walletId,
    input.billingAccountId,
    input.denomination,
    `${input.reference.type}:${input.reference.id}`,
    legs,
  ].join('|');
}

/** Input của `createLedgerTransaction`. */
export interface CreateLedgerTransactionInput {
  readonly transactionId: string;
  readonly idempotencyKey: string;
  readonly walletId: string;
  readonly billingAccountId: string;
  readonly denomination: Denomination;
  readonly legs: readonly LedgerLeg[];
  readonly reference: LedgerReference;
  readonly fencingToken: string;
  readonly createdAt: number;
}

/**
 * Dựng và validate một transaction trước khi post.
 *
 * Leg phải dương (một leg 0 không di chuyển gì và chỉ làm nhiễu sổ), cùng
 * denomination với transaction, và cân bằng. Trả domain error thay vì ném.
 */
export function createLedgerTransaction(
  input: CreateLedgerTransactionInput,
): FinancialResult<LedgerTransaction> {
  const failure = validateTransactionInput(input);
  if (failure !== null) {
    return financialFailure(failure);
  }
  const fingerprint = fingerprintOf({
    walletId: input.walletId,
    billingAccountId: input.billingAccountId,
    denomination: input.denomination,
    reference: { type: input.reference.type, id: input.reference.id },
    legs: input.legs,
  });
  const entries: LedgerEntry[] = input.legs.map((leg) =>
    Object.freeze({
      entry_id: leg.entry_id,
      transaction_id: input.transactionId,
      wallet_id: input.walletId,
      billing_account_id: input.billingAccountId,
      denomination: input.denomination,
      account: leg.account,
      direction: leg.direction,
      amount: leg.amount,
      fencing_token: input.fencingToken,
      created_at: input.createdAt,
      reference: Object.freeze({ type: input.reference.type, id: input.reference.id }),
    }),
  );
  return financialOk(
    Object.freeze({
      transaction_id: input.transactionId,
      idempotency_key: input.idempotencyKey,
      wallet_id: input.walletId,
      billing_account_id: input.billingAccountId,
      denomination: input.denomination,
      entries: freezeArray(entries),
      reference: Object.freeze({ type: input.reference.type, id: input.reference.id }),
      fencing_token: input.fencingToken,
      created_at: input.createdAt,
      fingerprint,
    }),
  );
}

/** Kiểm cấu trúc input; trả mã lỗi hoặc `null` khi hợp lệ. */
function validateTransactionInput(
  input: CreateLedgerTransactionInput,
): LlmFinancialDomainErrorCode | null {
  if (
    !isOpaqueId(input.transactionId) ||
    !isOpaqueId(input.idempotencyKey) ||
    !isOpaqueId(input.walletId) ||
    !isOpaqueId(input.billingAccountId) ||
    !isOpaqueId(input.fencingToken) ||
    !isEpochMillis(input.createdAt) ||
    !isLedgerReference(input.reference)
  ) {
    return 'invalid_ledger_transaction';
  }
  if (!Array.isArray(input.legs) || input.legs.length < 2) {
    return 'invalid_ledger_transaction';
  }
  const entryIds = new Set<string>();
  for (const leg of input.legs) {
    if (
      !isOpaqueId(leg.entry_id) ||
      entryIds.has(leg.entry_id) ||
      !isLedgerAccount(leg.account) ||
      !isLedgerDirection(leg.direction) ||
      !isMoney(leg.amount) ||
      leg.amount.minor <= 0n
    ) {
      return 'invalid_ledger_transaction';
    }
    if (leg.amount.denomination !== input.denomination) {
      return 'denomination_mismatch';
    }
    entryIds.add(leg.entry_id);
  }
  let debit = 0n;
  let credit = 0n;
  for (const leg of input.legs) {
    if (leg.direction === 'debit') {
      debit += leg.amount.minor;
    } else {
      credit += leg.amount.minor;
    }
  }
  return debit === credit ? null : 'unbalanced_transaction';
}

/** Kết quả của `postTransaction`. */
export interface PostTransactionOutcome {
  readonly ledger: Ledger;
  readonly transaction: LedgerTransaction;
  /** `true` khi transaction đã tồn tại và lần post này là replay. */
  readonly replayed: boolean;
}

/**
 * Post một transaction đã validate vào ledger.
 *
 * Idempotent theo `idempotency_key`: replay cùng nội dung trả transaction gốc;
 * cùng key nhưng khác vân tay tay là `idempotency_conflict` và ledger không đổi.
 * Không có đường nào sửa/xoá transaction đã post.
 */
export function postTransaction(
  ledger: Ledger,
  transaction: LedgerTransaction,
): FinancialResult<PostTransactionOutcome> {
  if (!isLedger(ledger)) {
    return financialFailure('invalid_ledger_transaction');
  }
  if (!isLedgerTransaction(transaction)) {
    return financialFailure('invalid_ledger_transaction');
  }
  const existing = ledger.transactions.find(
    (candidate) => candidate.idempotency_key === transaction.idempotency_key,
  );
  if (existing !== undefined) {
    if (existing.fingerprint !== transaction.fingerprint) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ ledger, transaction: existing, replayed: true }));
  }
  const next = Object.freeze({
    transactions: freezeArray([...ledger.transactions, transaction]),
  });
  return financialOk(Object.freeze({ ledger: next, transaction, replayed: false }));
}

/** Type guard cấu trúc cho `Ledger`. */
export function isLedger(value: unknown): value is Ledger {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { transactions?: unknown };
  return (
    Array.isArray(candidate.transactions) &&
    (candidate.transactions as readonly unknown[]).every((tx) => isLedgerTransaction(tx))
  );
}

/** Tổng của một ledger account trong một wallet; trả `null` nếu âm. */
function accountBalance(
  ledger: Ledger,
  walletId: WalletId,
  account: LedgerAccount,
  denomination: Denomination,
): bigint | null {
  let total = 0n;
  for (const transaction of ledger.transactions) {
    for (const entry of transaction.entries) {
      if (
        entry.wallet_id !== walletId ||
        entry.account !== account ||
        entry.denomination !== denomination
      ) {
        continue;
      }
      total += entry.direction === 'debit' ? entry.amount.minor : -entry.amount.minor;
      if (total < 0n) {
        return null;
      }
    }
  }
  return total;
}

/**
 * Suy ra ba balance của một wallet từ ledger — nguồn "expected" cho
 * reconciliation.
 *
 * Tổng `total` suy ra bằng `available + held + charged`; mọi bút toán đều giữ
 * bất biến này, nên đây là phép kiểm độc lập với state wallet đang giữ.
 * Ledger âm ở bất kỳ account nào là dấu hiệu sổ hỏng → `invalid_ledger_transaction`.
 */
export function deriveWalletBalances(
  ledger: Ledger,
  walletId: WalletId,
  denomination: Denomination,
): FinancialResult<WalletBalances> {
  const available = accountBalance(ledger, walletId, 'wallet_available', denomination);
  const held = accountBalance(ledger, walletId, 'wallet_held', denomination);
  const charged = accountBalance(ledger, walletId, 'wallet_charged', denomination);
  if (available === null || held === null || charged === null) {
    return financialFailure('invalid_ledger_transaction');
  }
  return financialOk(
    Object.freeze({
      available: Object.freeze({ denomination, minor: available }),
      held: Object.freeze({ denomination, minor: held }),
      charged: Object.freeze({ denomination, minor: charged }),
      total: Object.freeze({ denomination, minor: available + held + charged }),
    }),
  );
}

/** Số dư zero của một denomination — dùng khi wallet chưa có bút toán nào. */
export function emptyBalances(denomination: Denomination): WalletBalances {
  const zero = zeroMoney(denomination);
  return Object.freeze({ available: zero, held: zero, charged: zero, total: zero });
}
