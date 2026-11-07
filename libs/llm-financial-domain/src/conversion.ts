/**
 * EC → UC conversion — chuyển earnings của seller thành usage credit của Console.
 *
 * ADR-0005 chốt ba điều và để hai điều OPEN:
 *
 * - **Irreversible**: không có operation chuyển ngược. Một conversion đã ghi là
 *   vĩnh viễn; sửa sai phải là adjustment riêng, không phải đảo conversion.
 * - **Exactly-once theo `conversion_id`**: replay cùng payload trả record gốc;
 *   cùng id nhưng khác payload là `idempotency_conflict`.
 * - **Dual authorization**: `same_identity AND seller.payout_authorized AND
 *   console.payment_authorized`. Lib **không** sở hữu authorization model: nó
 *   nhận verdict đã tính như một opaque value, kiểm hình dạng, và fail closed
 *   khi thiếu hoặc lệch. Evidence không khớp actor/tenant → từ chối.
 * - **Conversion ratio và fee: OPEN** (ADR-0005, ADR-0006). Lib không có default
 *   1:1, không áp fee, không đọc FX. Nó nhận ratio do caller cấp, đòi kết quả
 *   nguyên chính xác, và ghi ratio bất biến vào conversion record.
 *
 * Hai ledger transaction riêng — một EC, một UC — vì UC và EC là hai
 * denomination domain không bao giờ nằm chung một transaction (ADR-0004). Mỗi
 * transaction tự cân bằng trong ledger của nó.
 */

import {
  commitTransaction,
  derivedIdempotencyKey,
  derivedTransactionId,
  locateWallet,
  type FinancialBook,
} from './book';
import {
  isConversionAuthorizationEvidence,
  isConversionRatio,
  referenceOf,
  type Conversion,
  type ConversionAuthorizationEvidence,
  type ConversionRatio,
} from './records';
import { MAX_MONEY_MAGNITUDE, isMoney, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type ActorRef,
  type ConversionId,
  type FencingToken,
  type FinancialResult,
  type LedgerTransactionId,
  type TenantRef,
} from './shared';

/** Input của `convertEcToUc`. */
export interface ConvertEcToUcInput {
  readonly conversionId: string;
  readonly actorRef: string;
  readonly sourceSellerTenant: string;
  readonly destinationConsoleTenant: string;
  readonly sourceWalletId: string;
  readonly destinationWalletId: string;
  readonly sourceAmount: Money<'EC'>;
  readonly ratio: ConversionRatio;
  readonly authorization: ConversionAuthorizationEvidence;
  readonly convertedAt: number;
  /** Fencing token của wallet EC nguồn. */
  readonly fencingToken: string;
  /** Fencing token của wallet UC đích — hai wallet thuộc hai account khác nhau. */
  readonly destinationFencingToken: string;
}

/** Kết quả của một conversion. */
export interface ConversionOutcome {
  readonly book: FinancialBook;
  readonly conversion: Conversion;
  readonly replayed: boolean;
}

/** Tính số UC đích từ EC nguồn và ratio; từ chối nếu không chia hết hoặc vượt biên độ. */
function convertAmount(source: Money<'EC'>, ratio: ConversionRatio): FinancialResult<Money<'UC'>> {
  if (!isConversionRatio(ratio)) {
    return financialFailure('invalid_conversion_ratio');
  }
  const scaled = source.minor * ratio.numerator;
  if (scaled % ratio.denominator !== 0n) {
    return financialFailure('conversion_not_exact');
  }
  const target = scaled / ratio.denominator;
  if (target <= 0n) {
    return financialFailure('conversion_not_exact');
  }
  if (target > MAX_MONEY_MAGNITUDE) {
    return financialFailure('amount_overflow');
  }
  return financialOk(Object.freeze({ denomination: 'UC' as const, minor: target }));
}

/** Copy và freeze một evidence đã validate — record giữ bản bất biến, không giữ tham chiếu caller. */
/**
 * Đóng băng evidence đã validate.
 *
 * Gán lại từ `evidence` thay vì hardcode `true`: guard đã chứng minh ba cờ là
 * `true`, nên hardcode chỉ che mất một guard bị nới lỏng về sau — khi đó record
 * vẫn mang `true` dù evidence nói khác.
 */
function freezeEvidence(
  evidence: ConversionAuthorizationEvidence,
): ConversionAuthorizationEvidence {
  return Object.freeze({
    actor_ref: evidence.actor_ref,
    seller_tenant: evidence.seller_tenant,
    console_tenant: evidence.console_tenant,
    same_identity: evidence.same_identity,
    seller_payout_authorized: evidence.seller_payout_authorized,
    console_payment_authorized: evidence.console_payment_authorized,
    evaluated_at: evidence.evaluated_at,
  });
}

/**
 * Chuyển EC (seller) thành UC (console), một chiều.
 *
 * Tiền tệ: EC nguồn `available` giảm, UC đích `available` tăng. Chỉ EC
 * **available** được convert: EC đang `held` (escrow/payout reservation) không
 * phải tiền seller có thể tiêu, nên bị từ chối với `conversion_source_unavailable`
 * thay vì bị rút khỏi phần đã earmark.
 */
export function convertEcToUc(
  book: FinancialBook,
  input: ConvertEcToUcInput,
): FinancialResult<ConversionOutcome> {
  if (
    !isOpaqueId(input.conversionId) ||
    !isOpaqueId(input.actorRef) ||
    !isOpaqueId(input.sourceSellerTenant) ||
    !isOpaqueId(input.destinationConsoleTenant) ||
    !isOpaqueId(input.sourceWalletId) ||
    !isOpaqueId(input.destinationWalletId) ||
    !isOpaqueId(input.fencingToken) ||
    !isOpaqueId(input.destinationFencingToken) ||
    !isEpochMillis(input.convertedAt) ||
    !isMoney(input.sourceAmount) ||
    input.sourceAmount.denomination !== 'EC'
  ) {
    return financialFailure('invalid_conversion');
  }
  if (input.sourceAmount.minor <= 0n) {
    return financialFailure('invalid_amount');
  }

  // Authorization: fail closed. Thiếu evidence ≠ evidence sai — hai lý do khác
  // nhau, và caller cần phân biệt để không "thử lại" một request chưa được duyệt.
  if (input.authorization === null || input.authorization === undefined) {
    return financialFailure('conversion_authorization_missing');
  }
  if (!isConversionAuthorizationEvidence(input.authorization)) {
    return financialFailure('conversion_authorization_mismatch');
  }
  if (
    input.authorization.actor_ref !== input.actorRef ||
    input.authorization.seller_tenant !== input.sourceSellerTenant ||
    input.authorization.console_tenant !== input.destinationConsoleTenant
  ) {
    return financialFailure('conversion_authorization_mismatch');
  }

  const target = convertAmount(input.sourceAmount, input.ratio);
  if (!target.ok) {
    return target;
  }

  const existing = book.conversions.find(
    (candidate) => candidate.conversion_id === input.conversionId,
  );
  if (existing !== undefined) {
    // So cả danh tính, không chỉ tiền tệ: một caller biết `conversionId` của
    // người khác mà chỉ so ví/số tiền sẽ nhận lại **bản ghi của người khác**
    // như một replay hợp lệ — kể cả actor ref và hai tenant ref trong đó. Lệch
    // chủ thể hoặc tenant là xung đột idempotency, không phải replay.
    // `created_at` không so: retry hợp lệ mang mốc thời gian mới.
    if (
      existing.actor_ref !== input.actorRef ||
      existing.source_seller_tenant !== input.sourceSellerTenant ||
      existing.destination_console_tenant !== input.destinationConsoleTenant ||
      existing.source_wallet_id !== input.sourceWalletId ||
      existing.destination_wallet_id !== input.destinationWalletId ||
      existing.source_amount.minor !== input.sourceAmount.minor ||
      existing.target_amount.minor !== target.value.minor ||
      existing.ratio.numerator !== input.ratio.numerator ||
      existing.ratio.denominator !== input.ratio.denominator
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ book, conversion: existing, replayed: true }));
  }

  const sourceWallet = locateWallet(book, input.sourceWalletId as never);
  if (!sourceWallet.ok) {
    return sourceWallet;
  }
  if (sourceWallet.value.wallet.denomination !== 'EC') {
    return financialFailure('invalid_conversion');
  }
  const destinationWallet = locateWallet(book, input.destinationWalletId as never);
  if (!destinationWallet.ok) {
    return destinationWallet;
  }
  if (destinationWallet.value.wallet.denomination !== 'UC') {
    return financialFailure('invalid_conversion');
  }
  if (sourceWallet.value.wallet.wallet_id === destinationWallet.value.wallet.wallet_id) {
    return financialFailure('invalid_conversion');
  }
  if (sourceWallet.value.wallet.balances.available.minor < input.sourceAmount.minor) {
    return financialFailure('conversion_source_unavailable');
  }

  const ratio = Object.freeze({
    numerator: input.ratio.numerator,
    denominator: input.ratio.denominator,
  });
  const sourceTransactionId = derivedTransactionId('conversion', input.conversionId, 'source');
  const targetTransactionId = derivedTransactionId('conversion', input.conversionId, 'target');

  const sourceCommit = commitTransaction(book, {
    accountId: sourceWallet.value.account.billing_account_id,
    walletId: sourceWallet.value.wallet.wallet_id,
    denomination: 'EC',
    transactionId: sourceTransactionId,
    idempotencyKey: derivedIdempotencyKey('conversion', input.conversionId, 'source'),
    reference: referenceOf('conversion', input.conversionId),
    fencingToken: input.fencingToken,
    createdAt: input.convertedAt,
    legs: [
      { account: 'wallet_available', direction: 'credit', amount: input.sourceAmount },
      { account: 'conversion_clearing', direction: 'debit', amount: input.sourceAmount },
    ],
  });
  if (!sourceCommit.ok) {
    return sourceCommit;
  }
  const targetCommit = commitTransaction(sourceCommit.value.book, {
    accountId: destinationWallet.value.account.billing_account_id,
    walletId: destinationWallet.value.wallet.wallet_id,
    denomination: 'UC',
    transactionId: targetTransactionId,
    idempotencyKey: derivedIdempotencyKey('conversion', input.conversionId, 'target'),
    reference: referenceOf('conversion', input.conversionId),
    fencingToken: input.destinationFencingToken,
    createdAt: input.convertedAt,
    legs: [
      { account: 'conversion_clearing', direction: 'credit', amount: target.value },
      { account: 'wallet_available', direction: 'debit', amount: target.value },
    ],
  });
  if (!targetCommit.ok) {
    return targetCommit;
  }

  const conversion: Conversion = Object.freeze({
    conversion_id: input.conversionId as ConversionId,
    actor_ref: input.actorRef as ActorRef,
    source_seller_tenant: input.sourceSellerTenant as TenantRef,
    destination_console_tenant: input.destinationConsoleTenant as TenantRef,
    source_wallet_id: sourceWallet.value.wallet.wallet_id,
    destination_wallet_id: destinationWallet.value.wallet.wallet_id,
    source_amount: input.sourceAmount,
    target_amount: target.value,
    ratio,
    authorization: freezeEvidence(input.authorization),
    source_transaction_id: sourceTransactionId as LedgerTransactionId,
    target_transaction_id: targetTransactionId as LedgerTransactionId,
    created_at: input.convertedAt,
    fencing_token: input.fencingToken as FencingToken,
    source_entry_ids: freezeArray(
      sourceCommit.value.transaction.entries.map((entry) => entry.entry_id),
    ),
    target_entry_ids: freezeArray(
      targetCommit.value.transaction.entries.map((entry) => entry.entry_id),
    ),
  });

  return financialOk(
    Object.freeze({
      book: Object.freeze({
        ...targetCommit.value.book,
        conversions: freezeArray([...targetCommit.value.book.conversions, conversion]),
      }),
      conversion,
      replayed: false,
    }),
  );
}

/** Tìm conversion theo id. */
export function findConversion(
  book: FinancialBook,
  conversionId: ConversionId,
): FinancialResult<Conversion> {
  const conversion = book.conversions.find((candidate) => candidate.conversion_id === conversionId);
  return conversion === undefined
    ? financialFailure('invalid_conversion')
    : financialOk(conversion);
}
