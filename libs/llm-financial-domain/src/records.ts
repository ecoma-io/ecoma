/**
 * Record types của các entity nghiệp vụ mà `llm-financial` sở hữu, cùng type
 * guard cho từng loại.
 *
 * Tách khỏi `book.ts` để aggregate root import được record mà không tạo vòng
 * import với các module operation. Module này chỉ phụ thuộc `money`, `ledger`
 * (type) và `shared`.
 *
 * Nguyên tắc: payload của mọi record là **dữ liệu caller cấp hoặc domain suy ra
 * tất định**. Không record nào mang provider cost — provider cost là quyết định
 * còn OPEN và không thuộc lib này.
 */

import type { LedgerReference } from './ledger';
import { isMoney, type Denomination, type Money } from './money';
import {
  isEpochMillis,
  isOpaqueId,
  type ActorRef,
  type BillingAccountId,
  type ChargeId,
  type ConversionId,
  type FencingToken,
  type LedgerEntryId,
  type LedgerTransactionId,
  type PayableId,
  type PayoutEvidenceRef,
  type RefundId,
  type ReservationId,
  type SettlementId,
  type TenantRef,
  type WalletId,
} from './shared';

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

/** Trạng thái reservation — §4.2 của architecture. */
export const RESERVATION_STATES = ['reserved', 'captured', 'released', 'expired'] as const;

/** Trạng thái reservation. */
export type ReservationState = (typeof RESERVATION_STATES)[number];

/** Type guard cho `ReservationState`. */
export function isReservationState(value: unknown): value is ReservationState {
  return typeof value === 'string' && (RESERVATION_STATES as readonly string[]).includes(value);
}

/** Reservation giữ tiền trong wallet: `available → held`. */
export interface Reservation {
  readonly reservation_id: ReservationId;
  readonly wallet_id: WalletId;
  readonly billing_account_id: BillingAccountId;
  readonly denomination: Denomination;
  /** Số tiền đã giữ khi reserve. */
  readonly reserved: Money;
  /** Số tiền đã capture (chuyển sang `charged`). */
  readonly captured: Money;
  /** Số tiền đã release (trả về `available`). */
  readonly released: Money;
  readonly state: ReservationState;
  readonly created_at: number;
  readonly finalized_at: number | null;
  readonly fencing_token: FencingToken;
}

/** Type guard cho `Reservation`. */
export function isReservation(value: unknown): value is Reservation {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<Reservation>;
  return (
    isOpaqueId(record.reservation_id) &&
    isOpaqueId(record.wallet_id) &&
    isOpaqueId(record.billing_account_id) &&
    (record.denomination === 'UC' || record.denomination === 'EC') &&
    isMoney(record.reserved) &&
    isMoney(record.captured) &&
    isMoney(record.released) &&
    isReservationState(record.state) &&
    isEpochMillis(record.created_at) &&
    (record.finalized_at === null || isEpochMillis(record.finalized_at)) &&
    isOpaqueId(record.fencing_token) &&
    record.reserved.denomination === record.denomination
  );
}

// ---------------------------------------------------------------------------
// Customer charge
// ---------------------------------------------------------------------------

/** Trạng thái customer charge — §4.5 của architecture. */
export const CHARGE_STATES = ['pending', 'posted', 'refunded', 'adjusted'] as const;

/** Trạng thái customer charge. */
export type ChargeState = (typeof CHARGE_STATES)[number];

/** Type guard cho `ChargeState`. */
export function isChargeState(value: unknown): value is ChargeState {
  return typeof value === 'string' && (CHARGE_STATES as readonly string[]).includes(value);
}

/**
 * Customer charge — khoản thu từ customer sau settlement.
 *
 * `amount` là **giá bán** (customer price), không phải provider cost. Charge là
 * append-only ở nghĩa không có operation nào sửa `amount`; refund và adjustment
 * là record mới, và charge giữ tổng đã hoàn/đã điều chỉnh để tính phần còn lại.
 */
export interface CustomerCharge {
  readonly charge_id: ChargeId;
  readonly wallet_id: WalletId;
  readonly billing_account_id: BillingAccountId;
  readonly denomination: Denomination;
  readonly amount: Money;
  readonly refunded: Money;
  readonly increase: Money;
  readonly decrease: Money;
  readonly state: ChargeState;
  readonly reservation_id: ReservationId | null;
  readonly settlement_id: SettlementId | null;
  readonly created_at: number;
  readonly posted_at: number | null;
}

/** Type guard cho `CustomerCharge`. */
export function isCustomerCharge(value: unknown): value is CustomerCharge {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<CustomerCharge>;
  return (
    isOpaqueId(record.charge_id) &&
    isOpaqueId(record.wallet_id) &&
    isOpaqueId(record.billing_account_id) &&
    (record.denomination === 'UC' || record.denomination === 'EC') &&
    isMoney(record.amount) &&
    isMoney(record.refunded) &&
    isMoney(record.increase) &&
    isMoney(record.decrease) &&
    isChargeState(record.state) &&
    (record.reservation_id === null || isOpaqueId(record.reservation_id)) &&
    (record.settlement_id === null || isOpaqueId(record.settlement_id)) &&
    isEpochMillis(record.created_at) &&
    (record.posted_at === null || isEpochMillis(record.posted_at)) &&
    record.amount.denomination === record.denomination
  );
}

/** Số tiền còn có thể hoàn của một charge: `amount + increase - decrease - refunded`. */
export function refundableAmount(charge: CustomerCharge): Money {
  const net = charge.amount.minor + charge.increase.minor;
  const used = charge.decrease.minor + charge.refunded.minor;
  const minor = net > used ? net - used : 0n;
  return Object.freeze({ denomination: charge.denomination, minor });
}

/** Refund — bút toán đảo của một phần customer charge. */
export interface Refund {
  readonly refund_id: RefundId;
  readonly charge_id: ChargeId;
  readonly wallet_id: WalletId;
  readonly amount: Money;
  readonly reason_ref: string | null;
  readonly created_at: number;
  readonly fencing_token: FencingToken;
}

/** Type guard cho `Refund`. */
export function isRefund(value: unknown): value is Refund {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<Refund>;
  return (
    isOpaqueId(record.refund_id) &&
    isOpaqueId(record.charge_id) &&
    isOpaqueId(record.wallet_id) &&
    isMoney(record.amount) &&
    (record.reason_ref === null || isOpaqueId(record.reason_ref)) &&
    isEpochMillis(record.created_at) &&
    isOpaqueId(record.fencing_token)
  );
}

/** Chiều điều chỉnh một charge. */
export type AdjustmentDirection = 'increase' | 'decrease';

/** Type guard cho `AdjustmentDirection`. */
export function isAdjustmentDirection(value: unknown): value is AdjustmentDirection {
  return value === 'increase' || value === 'decrease';
}

/** Adjustment — sửa sai một charge bằng bút toán mới, không sửa charge cũ. */
export interface ChargeAdjustment {
  readonly adjustment_id: string;
  readonly charge_id: ChargeId;
  readonly wallet_id: WalletId;
  readonly direction: AdjustmentDirection;
  readonly amount: Money;
  readonly reason_ref: string | null;
  readonly created_at: number;
  readonly fencing_token: FencingToken;
}

/** Type guard cho `ChargeAdjustment`. */
export function isChargeAdjustment(value: unknown): value is ChargeAdjustment {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<ChargeAdjustment>;
  return (
    isOpaqueId(record.adjustment_id) &&
    isOpaqueId(record.charge_id) &&
    isOpaqueId(record.wallet_id) &&
    isAdjustmentDirection(record.direction) &&
    isMoney(record.amount) &&
    (record.reason_ref === null || isOpaqueId(record.reason_ref)) &&
    isEpochMillis(record.created_at) &&
    isOpaqueId(record.fencing_token)
  );
}

// ---------------------------------------------------------------------------
// Seller payable
// ---------------------------------------------------------------------------

/** Trạng thái seller payable — §4.4 của architecture. */
export const PAYABLE_STATES = ['accrued', 'settled', 'paid', 'adjusted'] as const;

/** Trạng thái seller payable. */
export type PayableState = (typeof PAYABLE_STATES)[number];

/** Type guard cho `PayableState`. */
export function isPayableState(value: unknown): value is PayableState {
  return typeof value === 'string' && (PAYABLE_STATES as readonly string[]).includes(value);
}

/**
 * Seller payable — **projection** nghĩa vụ phải trả cho seller.
 *
 * Không phải payout: không có beneficiary, không có fiat disbursement, và
 * `paid` chỉ là state sau khi caller cấp bằng chứng payout (opaque reference do
 * `payout`/`payment` sở hữu). Cũng không phải provider cost.
 *
 * Append-only theo version: mỗi transition thêm một record cùng `payable_id` với
 * `version + 1`; `latestPayable` trả version cao nhất. Vì vậy adjustment là một
 * transition mới, không phải sửa record cũ.
 */
export interface SellerPayable {
  readonly payable_id: PayableId;
  readonly version: number;
  readonly seller_tenant: TenantRef;
  readonly denomination: 'EC';
  readonly amount: Money<'EC'>;
  readonly state: PayableState;
  /** Kỳ earnings do caller cấp (ví dụ `2026-10`); calendar policy thuộc ADR-0007. */
  readonly period: string;
  /** Thời điểm earnings trở nên available — caller suy ra từ policy, domain không tính lịch. */
  readonly available_at: number;
  readonly accrued_at: number;
  readonly settled_at: number | null;
  readonly paid_at: number | null;
  /** Bằng chứng payout — opaque, không phải payout record của lib này. */
  readonly payout_evidence_ref: PayoutEvidenceRef | null;
  readonly settlement_id: SettlementId | null;
  readonly charge_id: ChargeId | null;
  readonly fencing_token: FencingToken;
}

/** Type guard cho `SellerPayable`. */
export function isSellerPayable(value: unknown): value is SellerPayable {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<SellerPayable>;
  return (
    isOpaqueId(record.payable_id) &&
    typeof record.version === 'number' &&
    Number.isSafeInteger(record.version) &&
    record.version >= 1 &&
    isOpaqueId(record.seller_tenant) &&
    record.denomination === 'EC' &&
    isMoney(record.amount) &&
    record.amount.denomination === 'EC' &&
    isPayableState(record.state) &&
    isOpaqueId(record.period) &&
    isEpochMillis(record.available_at) &&
    isEpochMillis(record.accrued_at) &&
    (record.settled_at === null || isEpochMillis(record.settled_at)) &&
    (record.paid_at === null || isEpochMillis(record.paid_at)) &&
    (record.payout_evidence_ref === null || isOpaqueId(record.payout_evidence_ref)) &&
    (record.settlement_id === null || isOpaqueId(record.settlement_id)) &&
    (record.charge_id === null || isOpaqueId(record.charge_id)) &&
    isOpaqueId(record.fencing_token)
  );
}

/** Version mới nhất của một payable id. */
export function latestPayable(
  payables: readonly SellerPayable[],
  payableId: PayableId,
): SellerPayable | null {
  let latest: SellerPayable | null = null;
  for (const payable of payables) {
    if (payable.payable_id !== payableId) {
      continue;
    }
    if (latest === null || payable.version > latest.version) {
      latest = payable;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------

/** Phạm vi hold — ADR-0007. */
export const HOLD_SCOPES = ['settlement', 'account'] as const;

/** Phạm vi hold. */
export type HoldScope = (typeof HOLD_SCOPES)[number];

/** Type guard cho `HoldScope`. */
export function isHoldScope(value: unknown): value is HoldScope {
  return typeof value === 'string' && (HOLD_SCOPES as readonly string[]).includes(value);
}

/**
 * Financial hold.
 *
 * - `settlement`: giữ toàn bộ settlement của một Seller tenant cho một kỳ.
 * - `account`: chặn dùng toàn bộ EC available hiện có (fraud/compliance).
 *
 * Hold không xoá/viết lại earnings; nó chỉ chặn transition và yêu cầu reason,
 * actor, scope, thời điểm bắt đầu và thời điểm release để audit.
 */
export interface FinancialHold {
  readonly hold_id: string;
  readonly scope: HoldScope;
  readonly seller_tenant: TenantRef;
  /** Kỳ bị ảnh hưởng khi `scope === 'settlement'`; `null` với account hold. */
  readonly period: string | null;
  readonly reason_ref: string;
  /** Actor đã mở hold — không bị ghi đè khi release, để audit truy được người mở. */
  readonly actor_ref: ActorRef;
  readonly started_at: number;
  readonly released_at: number | null;
  /** Actor đã release; `null` khi hold còn hiệu lực. */
  readonly released_by: ActorRef | null;
}

/** Type guard cho `FinancialHold`. */
export function isFinancialHold(value: unknown): value is FinancialHold {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<FinancialHold>;
  return (
    isOpaqueId(record.hold_id) &&
    isHoldScope(record.scope) &&
    isOpaqueId(record.seller_tenant) &&
    (record.period === null || isOpaqueId(record.period)) &&
    isOpaqueId(record.reason_ref) &&
    isOpaqueId(record.actor_ref) &&
    isEpochMillis(record.started_at) &&
    (record.released_at === null || isEpochMillis(record.released_at)) &&
    // Hai field release đi cùng nhau: chưa release thì cả hai `null`, đã release
    // thì cả hai phải có. Một hold release mà không rõ ai release là audit hỏng.
    (record.released_at === null) === (record.released_by === null) &&
    (record.released_by === null || isOpaqueId(record.released_by)) &&
    (record.scope !== 'settlement' || isOpaqueId(record.period)) &&
    // Account hold không có kỳ; một `period` thừa là dữ liệu không nhất quán mà
    // `hasBlockingHold` sẽ không bao giờ đọc tới.
    (record.scope === 'account' || record.period !== null)
  );
}

/** Hold đang hiệu lực tại một thời điểm. */
export function isHoldActive(hold: FinancialHold, at: number): boolean {
  return hold.released_at === null || hold.released_at > at;
}

/**
 * Có hold đang chặn một (seller tenant, kỳ) tại thời điểm `at` không.
 *
 * Settlement hold khớp đúng kỳ; account hold chặn mọi kỳ của tenant.
 */
export function hasBlockingHold(
  holds: readonly FinancialHold[],
  sellerTenant: TenantRef,
  period: string | null,
  at: number,
): boolean {
  return holds.some(
    (hold) =>
      hold.seller_tenant === sellerTenant &&
      isHoldActive(hold, at) &&
      (hold.scope === 'account' || (hold.scope === 'settlement' && hold.period === period)),
  );
}

// ---------------------------------------------------------------------------
// Budget escrow & lease
// ---------------------------------------------------------------------------

/** Trạng thái budget lease — §4.3 của architecture. */
export const LEASE_STATES = ['active', 'expired', 'revoked', 'exhausted'] as const;

/** Trạng thái budget lease. */
export type LeaseState = (typeof LEASE_STATES)[number];

/** Type guard cho `LeaseState`. */
export function isLeaseState(value: unknown): value is LeaseState {
  return typeof value === 'string' && (LEASE_STATES as readonly string[]).includes(value);
}

/**
 * Budget lease — quyền tiêu liên tục trong một cửa sổ cho một consumer/key.
 *
 * Khác **quota lease**: lease tài chính không cấp quota token/request. `epoch` là
 * số đơn điệu do caller cấp; fencing token của lease cũ bị từ chối khi epoch đã
 * bị vượt qua.
 */
export interface BudgetLease {
  readonly lease_id: string;
  readonly escrow_id: string;
  readonly amount: Money;
  readonly epoch: number;
  readonly fencing_token: FencingToken;
  readonly state: LeaseState;
  readonly issued_at: number;
  readonly expires_at: number;
  /** Bằng chứng reconciliation đã cho phép reallocate escrow của lease này. */
  readonly reconciliation_ref: string | null;
  readonly reallocated_at: number | null;
}

/** Type guard cho `BudgetLease`. */
export function isBudgetLease(value: unknown): value is BudgetLease {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<BudgetLease>;
  return (
    isOpaqueId(record.lease_id) &&
    isOpaqueId(record.escrow_id) &&
    isMoney(record.amount) &&
    typeof record.epoch === 'number' &&
    Number.isSafeInteger(record.epoch) &&
    record.epoch >= 0 &&
    isOpaqueId(record.fencing_token) &&
    isLeaseState(record.state) &&
    isEpochMillis(record.issued_at) &&
    isEpochMillis(record.expires_at) &&
    (record.reconciliation_ref === null || isOpaqueId(record.reconciliation_ref)) &&
    (record.reallocated_at === null || isEpochMillis(record.reallocated_at))
  );
}

/** Trạng thái suy ra của escrow: còn mở hay đã release. */
export const ESCROW_STATES = ['open', 'released'] as const;

/** Trạng thái escrow. */
export type EscrowState = (typeof ESCROW_STATES)[number];

/** Type guard cho `EscrowState`. */
export function isEscrowState(value: unknown): value is EscrowState {
  return typeof value === 'string' && (ESCROW_STATES as readonly string[]).includes(value);
}

/**
 * Budget escrow — tiền earmark cho một consumer trong một khoảng thời gian.
 *
 * Escrow thực sự giữ tiền trong wallet (`available → held`), nên unused escrow
 * là **held money**, không phải outstanding liability (invariant 12). Lease được
 * cấp từ phần escrow chưa allocate.
 */
export interface BudgetEscrow {
  readonly escrow_id: string;
  readonly wallet_id: WalletId;
  readonly billing_account_id: BillingAccountId;
  readonly denomination: Denomination;
  readonly amount: Money;
  readonly leases: readonly BudgetLease[];
  readonly created_at: number;
  readonly fencing_token: FencingToken;
  /** Thời điểm escrow được trả phần chưa dùng về available; `null` khi còn mở. */
  readonly released_at: number | null;
  /** Bằng chứng reconciliation cho phép release — bắt buộc khi `released_at` khác `null`. */
  readonly reconciliation_ref: string | null;
}

/** Type guard cho `BudgetEscrow`. */
export function isBudgetEscrow(value: unknown): value is BudgetEscrow {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<BudgetEscrow>;
  return (
    isOpaqueId(record.escrow_id) &&
    isOpaqueId(record.wallet_id) &&
    isOpaqueId(record.billing_account_id) &&
    (record.denomination === 'UC' || record.denomination === 'EC') &&
    isMoney(record.amount) &&
    record.amount.denomination === record.denomination &&
    Array.isArray(record.leases) &&
    record.leases.every((lease) => isBudgetLease(lease) && lease.escrow_id === record.escrow_id) &&
    isEpochMillis(record.created_at) &&
    isOpaqueId(record.fencing_token) &&
    (record.released_at === null || isEpochMillis(record.released_at)) &&
    (record.reconciliation_ref === null || isOpaqueId(record.reconciliation_ref)) &&
    (record.released_at === null) === (record.reconciliation_ref === null)
  );
}

// ---------------------------------------------------------------------------
// EC → UC conversion
// ---------------------------------------------------------------------------

/**
 * Tỷ lệ conversion do caller cấp.
 *
 * ADR-0005 để conversion ratio và fee là **OPEN**. Lib không có default 1:1 và
 * không áp fee; nó chỉ nhận ratio, kiểm tính hợp lệ, yêu cầu kết quả nguyên
 * chính xác, và ghi ratio bất biến vào conversion record.
 */
export interface ConversionRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Type guard cho `ConversionRatio`: cả hai dương, denominator khác 0. */
export function isConversionRatio(value: unknown): value is ConversionRatio {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const ratio = value as { numerator?: unknown; denominator?: unknown };
  return (
    typeof ratio.numerator === 'bigint' &&
    typeof ratio.denominator === 'bigint' &&
    ratio.numerator > 0n &&
    ratio.denominator > 0n
  );
}

/**
 * Kết quả authorization do caller cấp — **không** phải authorization model của
 * lib này.
 *
 * Dual authorization của ADR-0005 là `same_identity AND seller.payout AND
 * console.payment`; verdict được tính ở tầng authorization sở hữu nó và truyền
 * vào đây như một opaque value. Lib chỉ kiểm hình dạng, kiểm các cờ đều `true`,
 * và kiểm các tham chiếu khớp với conversion. Thiếu hoặc lệch → fail closed.
 */
export interface ConversionAuthorizationEvidence {
  readonly actor_ref: ActorRef;
  readonly seller_tenant: TenantRef;
  readonly console_tenant: TenantRef;
  readonly same_identity: true;
  readonly seller_payout_authorized: true;
  readonly console_payment_authorized: true;
  readonly evaluated_at: number;
}

/** Type guard nghiêm ngặt cho `ConversionAuthorizationEvidence`. */
export function isConversionAuthorizationEvidence(
  value: unknown,
): value is ConversionAuthorizationEvidence {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const evidence = value as Partial<ConversionAuthorizationEvidence>;
  const ownKeys = Object.keys(value);
  const expectedKeys = [
    'actor_ref',
    'seller_tenant',
    'console_tenant',
    'same_identity',
    'seller_payout_authorized',
    'console_payment_authorized',
    'evaluated_at',
  ];
  return (
    ownKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => ownKeys.includes(key)) &&
    isOpaqueId(evidence.actor_ref) &&
    isOpaqueId(evidence.seller_tenant) &&
    isOpaqueId(evidence.console_tenant) &&
    evidence.same_identity === true &&
    evidence.seller_payout_authorized === true &&
    evidence.console_payment_authorized === true &&
    isEpochMillis(evidence.evaluated_at)
  );
}

/** Record conversion EC→UC. Irreversible: không có operation chuyển ngược. */
export interface Conversion {
  readonly conversion_id: ConversionId;
  readonly actor_ref: ActorRef;
  readonly source_seller_tenant: TenantRef;
  readonly destination_console_tenant: TenantRef;
  readonly source_wallet_id: WalletId;
  readonly destination_wallet_id: WalletId;
  readonly source_amount: Money<'EC'>;
  readonly target_amount: Money<'UC'>;
  readonly ratio: ConversionRatio;
  readonly authorization: ConversionAuthorizationEvidence;
  /** Hai transaction ledger (EC và UC) — mỗi bên cân bằng trong ledger của nó. */
  readonly source_transaction_id: LedgerTransactionId;
  readonly target_transaction_id: LedgerTransactionId;
  readonly created_at: number;
  readonly fencing_token: FencingToken;
  readonly source_entry_ids: readonly LedgerEntryId[];
  readonly target_entry_ids: readonly LedgerEntryId[];
}

/** Type guard cho `Conversion`. */
export function isConversion(value: unknown): value is Conversion {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<Conversion>;
  return (
    isOpaqueId(record.conversion_id) &&
    isOpaqueId(record.actor_ref) &&
    isOpaqueId(record.source_seller_tenant) &&
    isOpaqueId(record.destination_console_tenant) &&
    isOpaqueId(record.source_wallet_id) &&
    isOpaqueId(record.destination_wallet_id) &&
    isMoney(record.source_amount) &&
    record.source_amount.denomination === 'EC' &&
    isMoney(record.target_amount) &&
    record.target_amount.denomination === 'UC' &&
    isConversionRatio(record.ratio) &&
    isConversionAuthorizationEvidence(record.authorization) &&
    isOpaqueId(record.source_transaction_id) &&
    isOpaqueId(record.target_transaction_id) &&
    isEpochMillis(record.created_at) &&
    isOpaqueId(record.fencing_token) &&
    Array.isArray(record.source_entry_ids) &&
    Array.isArray(record.target_entry_ids)
  );
}

// ---------------------------------------------------------------------------
// Financial audit
// ---------------------------------------------------------------------------

/**
 * Hành động được ghi audit.
 *
 * Vocabulary đóng để một hành động lạ không lọt vào log mà không ai định nghĩa
 * ngữ nghĩa của nó.
 */
export const AUDIT_ACTIONS = [
  'deposit_registered',
  'deposit_credited',
  'deposit_reversed',
  'wallet_credited',
  'reserved',
  'reservation_captured',
  'reservation_released',
  'settled',
  'charge_refunded',
  'charge_adjusted',
  'payable_accrued',
  'payable_settled',
  'payable_paid',
  'payable_adjusted',
  'hold_opened',
  'hold_released',
  'escrow_opened',
  'lease_issued',
  'lease_revoked',
  'escrow_reallocated',
  'converted',
  'fencing_token_rotated',
  // Sponsor funding vocabulary — tên exactly theo ADR-0028 §4. Các action
  // revoke/update không có operation nào phát sinh ở MVP; chúng là vocabulary
  // canonical cho bề mặt tương lai (ADR-0028 §13.6).
  'sponsor_registered',
  'sponsor_funding_authorized',
  'sponsor_funding_authorization_revoked',
  'sponsor_grant_registered',
  'sponsor_grant_credited',
  'sponsor_grant_reversed',
  'sponsor_ceiling_updated',
  'sponsor_funding_authorization_ceiling_updated',
  'financial_charge_capped',
  'financial_settle_missing_usage',
] as const;

/** Một hành động audit. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Type guard cho `AuditAction`. */
export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Một dòng financial audit.
 *
 * Append-only: không có operation sửa/xoá dòng đã ghi. `actor_ref` và
 * `correlation_id` do caller cấp — domain không biết request context. Không
 * chứa secret/token; mọi tham chiếu đều opaque.
 */
export interface FinancialAuditEntry {
  readonly action: AuditAction;
  readonly actor_ref: ActorRef;
  readonly target_ref: string;
  readonly amount: Money | null;
  readonly correlation_id: string;
  readonly at: number;
  readonly fencing_token: FencingToken;
}

/** Type guard cho `FinancialAuditEntry`. */
export function isFinancialAuditEntry(value: unknown): value is FinancialAuditEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<FinancialAuditEntry>;
  return (
    isAuditAction(entry.action) &&
    isOpaqueId(entry.actor_ref) &&
    isOpaqueId(entry.target_ref) &&
    (entry.amount === null || isMoney(entry.amount)) &&
    isOpaqueId(entry.correlation_id) &&
    isEpochMillis(entry.at) &&
    isOpaqueId(entry.fencing_token)
  );
}

/** Ledger reference của một operation trên một record — helper dùng chung. */
export function referenceOf(type: LedgerReference['type'], id: string): LedgerReference {
  return Object.freeze({ type, id });
}
