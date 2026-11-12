/**
 * Sponsor funding — cấp UC từ nguồn tài trợ nội bộ (ADR-0028 §3–§6).
 *
 * Ba aggregate mới trên `FinancialBook`:
 *
 * - `Sponsor` — bản nhận trách nhiệm tài chính nội bộ: ủy quyền và chịu trần
 *   cấp funding cho billing account. Không phải tenant, không phải `sub`,
 *   không phải Seller tenant, không phải legal principal (ADR-0028 §3.1).
 * - `SponsorFundingAuthorization` — ủy quyền durable của sponsor vào đúng một
 *   billing account, kèm trần per-account (nullable) và `evidence_ref` trỏ ra
 *   quyết định ngân sách có thật ngoài database sản phẩm (ADR-0028 §3.2).
 * - `SponsorGrant` — bút toán cấp UC từ nguồn tài trợ; lifecycle đối xứng
 *   deposit: `pending → credited → reversed` (ADR-0028 §4).
 *
 * Đối ứng kế toán là account `sponsor_funding_clearing` — **không** tái dùng
 * `funding_clearing` của deposit (nguồn `payment`); `creditGrant` cùng
 * `creditDeposit` là hai operation duy nhất đưa giá trị mới vào hệ thống.
 *
 * Kiểm soát chi tiêu (ADR-0028 §5): **cả hai trần** — sponsor ceiling (tổng net
 * credited của sponsor) và authorization ceiling per billing account (khi
 * authorization mang trần) — được kiểm **trong `creditGrant`**, ngay trước khi
 * post bút toán, trong cùng một phép gọi. Không có API kiểm trần riêng: một
 * phép kiểm duy nhất tại thời điểm credit là nguồn sự thật, bootstrap không
 * validate hộ ngoài operation.
 *
 * Idempotency suy ra tất định từ entity id (pattern `book.ts`): transaction id
 * `sponsor_grant:<grant_id>:credit|reverse`, idempotency key
 * `idem:sponsor_grant:<grant_id>:credit|reverse`. Replay cùng payload trả kết
 * quả gốc; khác payload là `idempotency_conflict` và ledger không đổi.
 *
 * `reverseGrant` full-only, một lần, chỉ từ `available` (ADR-0028 §4): đảo đúng
 * toàn bộ amount gốc, `credited → reversed` là terminal, không đụng `held` hay
 * `charged`; `available` không đủ ⇒ `insufficient_available_balance`, grant giữ
 * nguyên `credited`. Replay trên grant đã `reversed` trả kết quả gốc — không
 * double-reverse.
 *
 * MVP **không có** operation revoke authorization hay suspend sponsor: hai giá
 * trị trạng thái là reserved cho bề mặt tương lai (ADR-0028 §3.2, §13.6); các
 * audit action `sponsor_funding_authorization_revoked`,
 * `sponsor_ceiling_updated`, `sponsor_funding_authorization_ceiling_updated`
 * là vocabulary canonical sẵn sàng cho surface đó, không có operation nào ở
 * đây phát sinh chúng.
 */

import {
  commitTransaction,
  derivedIdempotencyKey,
  derivedTransactionId,
  findBillingAccount,
  type FinancialBook,
} from './book';
import { referenceOf } from './records';
import { isMoney, type Denomination, type Money } from './money';
import {
  financialFailure,
  financialOk,
  freezeArray,
  isEpochMillis,
  isOpaqueId,
  type BillingAccountId,
  type FinancialResult,
} from './shared';
import { findWalletByDenomination } from './wallet';

// ---------------------------------------------------------------------------
// Vocabulary trạng thái — các tập đóng
// ---------------------------------------------------------------------------

/** Trạng thái sponsor (ADR-0028 §3.1). `suspended` chặn grant mới, không đổi số dư đã cấp. */
export const SPONSOR_STATUSES = ['active', 'suspended'] as const;

/** Trạng thái của một sponsor. */
export type SponsorStatus = (typeof SPONSOR_STATUSES)[number];

/** Type guard cho `SponsorStatus`. */
export function isSponsorStatus(value: unknown): value is SponsorStatus {
  return typeof value === 'string' && (SPONSOR_STATUSES as readonly string[]).includes(value);
}

/** Trạng thái authorization (ADR-0028 §3.2). `revoked` chặn grant mới, không đụng số dư đã cấp. */
export const FUNDING_AUTHORIZATION_STATUSES = ['active', 'revoked'] as const;

/** Trạng thái của một sponsor funding authorization. */
export type FundingAuthorizationStatus = (typeof FUNDING_AUTHORIZATION_STATUSES)[number];

/** Type guard cho `FundingAuthorizationStatus`. */
export function isFundingAuthorizationStatus(value: unknown): value is FundingAuthorizationStatus {
  return (
    typeof value === 'string' &&
    (FUNDING_AUTHORIZATION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Trạng thái grant — đối xứng deposit (ADR-0028 §4): `pending` chưa phải tiền
 * trong ví; `credited` đã vào wallet; `reversed` đã bị clawback (terminal).
 */
export const SPONSOR_GRANT_STATES = ['pending', 'credited', 'reversed'] as const;

/** Trạng thái của một sponsor grant. */
export type SponsorGrantState = (typeof SPONSOR_GRANT_STATES)[number];

/** Type guard cho `SponsorGrantState`. */
export function isSponsorGrantState(value: unknown): value is SponsorGrantState {
  return typeof value === 'string' && (SPONSOR_GRANT_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Sponsor — chủ thể chịu trách nhiệm funding và trần tổng (ADR-0028 §3.1). */
export interface Sponsor {
  readonly sponsor_id: string;
  /** Tham chiếu `sub` provenance/audit — không suy ra quyền hay sở hữu nào khác. */
  readonly owner_ref: string;
  /** Trần cấp funding lũy kế (net credited), cùng denomination domain với grant. */
  readonly ceiling: Money;
  readonly status: SponsorStatus;
  readonly created_at: number;
  readonly created_by: string;
}

/** Sponsor funding authorization — điều kiện tiên quyết của mọi grant (ADR-0028 §3.2). */
export interface SponsorFundingAuthorization {
  readonly authorization_id: string;
  readonly sponsor_id: string;
  readonly billing_account_id: BillingAccountId;
  /** Trần per-account; `null` = không trần per-account (explicit, ADR-0028 §6 B3). */
  readonly ceiling: Money | null;
  readonly status: FundingAuthorizationStatus;
  /** Tham chiếu opaque tới quyết định ngân sách authoritative ngoài sản phẩm. */
  readonly evidence_ref: string;
  readonly created_at: number;
  readonly created_by: string;
}

/** Sponsor grant — bút toán cấp UC từ nguồn tài trợ (ADR-0028 §4). */
export interface SponsorGrant {
  readonly grant_id: string;
  readonly authorization_id: string;
  /** Suy từ authorization tại register — provenance bất biến của bút toán. */
  readonly sponsor_id: string;
  readonly billing_account_id: BillingAccountId;
  readonly amount: Money;
  readonly state: SponsorGrantState;
  readonly actor_ref: string;
  readonly created_at: number;
}

/** Type guard cấu trúc cho `Sponsor` — dữ liệu đọc từ ngoài. */
export function isSponsor(value: unknown): value is Sponsor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Sponsor>;
  return (
    isOpaqueId(candidate.sponsor_id) &&
    isOpaqueId(candidate.owner_ref) &&
    isMoney(candidate.ceiling) &&
    isSponsorStatus(candidate.status) &&
    isEpochMillis(candidate.created_at) &&
    isOpaqueId(candidate.created_by)
  );
}

/** Type guard cấu trúc cho `SponsorFundingAuthorization`. */
export function isSponsorFundingAuthorization(
  value: unknown,
): value is SponsorFundingAuthorization {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SponsorFundingAuthorization>;
  return (
    isOpaqueId(candidate.authorization_id) &&
    isOpaqueId(candidate.sponsor_id) &&
    isOpaqueId(candidate.billing_account_id) &&
    (candidate.ceiling === null || isMoney(candidate.ceiling)) &&
    isFundingAuthorizationStatus(candidate.status) &&
    isOpaqueId(candidate.evidence_ref) &&
    isEpochMillis(candidate.created_at) &&
    isOpaqueId(candidate.created_by)
  );
}

/** Type guard cấu trúc cho `SponsorGrant`. */
export function isSponsorGrant(value: unknown): value is SponsorGrant {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SponsorGrant>;
  return (
    isOpaqueId(candidate.grant_id) &&
    isOpaqueId(candidate.authorization_id) &&
    isOpaqueId(candidate.sponsor_id) &&
    isOpaqueId(candidate.billing_account_id) &&
    isMoney(candidate.amount) &&
    isSponsorGrantState(candidate.state) &&
    isOpaqueId(candidate.actor_ref) &&
    isEpochMillis(candidate.created_at)
  );
}

// ---------------------------------------------------------------------------
// Helpers dùng chung
// ---------------------------------------------------------------------------

/** Tìm sponsor theo id. */
export function findSponsor(book: FinancialBook, sponsorId: string): FinancialResult<Sponsor> {
  const sponsor = book.sponsors.find((candidate) => candidate.sponsor_id === sponsorId);
  return sponsor === undefined ? financialFailure('sponsor_not_found') : financialOk(sponsor);
}

/** Tìm authorization theo id. */
export function findFundingAuthorization(
  book: FinancialBook,
  authorizationId: string,
): FinancialResult<SponsorFundingAuthorization> {
  const authorization = book.fundingAuthorizations.find(
    (candidate) => candidate.authorization_id === authorizationId,
  );
  return authorization === undefined
    ? financialFailure('funding_authorization_not_found')
    : financialOk(authorization);
}

/** Tìm grant theo id. */
export function findGrant(book: FinancialBook, grantId: string): FinancialResult<SponsorGrant> {
  const grant = book.grants.find((candidate) => candidate.grant_id === grantId);
  return grant === undefined ? financialFailure('grant_not_found') : financialOk(grant);
}

/** Thay một grant trong book. */
function replaceGrant(book: FinancialBook, grant: SponsorGrant): FinancialBook {
  return Object.freeze({
    ...book,
    grants: freezeArray(
      book.grants.map((candidate) => (candidate.grant_id === grant.grant_id ? grant : candidate)),
    ),
  });
}

/**
 * Net credited của một sponsor theo công thức ADR-0028 §5.1:
 * Σ(amount các grant `credited`) − Σ(amount các grant `reversed`). Mỗi grant
 * `reversed` đã từng được credit (reverse chỉ áp cho `credited`), nên cặp
 * credit − reverse của nó triệt về 0 — net đúng bằng tổng amount đang đứng ở
 * trạng thái `credited`, khớp với số dư `sponsor_funding_clearing` trên ledger.
 * Grant lệch denomination với trần không thể bao giờ được credit (phép kiểm
 * denomination nằm trước phép kiểm trần), nên nó không đóng góp vào tổng này.
 */
export function sponsorNetCredited(book: FinancialBook, sponsorId: string): bigint {
  const sponsor = book.sponsors.find((candidate) => candidate.sponsor_id === sponsorId);
  if (sponsor === undefined) {
    return 0n;
  }
  let net = 0n;
  for (const grant of book.grants) {
    if (
      grant.sponsor_id !== sponsorId ||
      grant.amount.denomination !== sponsor.ceiling.denomination
    ) {
      continue;
    }
    net += grant.state === 'credited' ? grant.amount.minor : 0n;
  }
  return net;
}

/**
 * Net credited theo một authorization trong một denomination (tức theo cặp
 * authorization + billing account — mỗi authorization bind đúng một account,
 * ADR-0028 §3.2): cùng công thức ADR-0028 §5.2 với `sponsorNetCredited`.
 */
export function authorizationNetCredited(
  book: FinancialBook,
  authorizationId: string,
  denomination: Denomination,
): bigint {
  let net = 0n;
  for (const grant of book.grants) {
    if (grant.authorization_id !== authorizationId || grant.amount.denomination !== denomination) {
      continue;
    }
    net += grant.state === 'credited' ? grant.amount.minor : 0n;
  }
  return net;
}

// ---------------------------------------------------------------------------
// B1 — registerSponsor
// ---------------------------------------------------------------------------

/** Input của `registerSponsor` — surface provisioning B1 (ADR-0028 §6). */
export interface RegisterSponsorInput {
  readonly sponsorId: string;
  readonly ownerRef: string;
  readonly ceiling: Money;
  readonly createdAt: number;
  readonly createdBy: string;
}

/** Kết quả của một operation seed sponsor/authorization. */
export interface SponsorSeedOutcome {
  readonly book: FinancialBook;
  readonly sponsor: Sponsor;
  readonly replayed: boolean;
}

/**
 * Đưa một sponsor vào book ở trạng thái `active`.
 *
 * Surface provisioning duy nhất của MVP là bootstrap (ADR-0028 §3.1); MVP
 * không có operation suspend hay đổi trần tại đây. Idempotent theo
 * `sponsor_id`: replay cùng payload trả record gốc; khác payload (owner,
 * ceiling) là `idempotency_conflict` — bootstrap đọc mã đó làm drift fail-closed.
 */
export function registerSponsor(
  book: FinancialBook,
  input: RegisterSponsorInput,
): FinancialResult<SponsorSeedOutcome> {
  if (
    !isOpaqueId(input.sponsorId) ||
    !isOpaqueId(input.ownerRef) ||
    !isEpochMillis(input.createdAt) ||
    !isOpaqueId(input.createdBy) ||
    !isMoney(input.ceiling)
  ) {
    return financialFailure('invalid_amount');
  }
  const existing = book.sponsors.find((candidate) => candidate.sponsor_id === input.sponsorId);
  if (existing !== undefined) {
    if (
      existing.owner_ref !== input.ownerRef ||
      existing.ceiling.denomination !== input.ceiling.denomination ||
      existing.ceiling.minor !== input.ceiling.minor
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ book, sponsor: existing, replayed: true }));
  }
  const sponsor: Sponsor = Object.freeze({
    sponsor_id: input.sponsorId,
    owner_ref: input.ownerRef,
    ceiling: input.ceiling,
    status: 'active',
    created_at: input.createdAt,
    created_by: input.createdBy,
  });
  return financialOk(
    Object.freeze({
      book: Object.freeze({ ...book, sponsors: freezeArray([...book.sponsors, sponsor]) }),
      sponsor,
      replayed: false,
    }),
  );
}

// ---------------------------------------------------------------------------
// B3 — authorizeFunding
// ---------------------------------------------------------------------------

/** Input của `authorizeFunding` — surface provisioning B3 (ADR-0028 §6). */
export interface AuthorizeFundingInput {
  readonly authorizationId: string;
  readonly sponsorId: string;
  readonly billingAccountId: string;
  /** Trần per-account; `null` = explicit không trần per-account. */
  readonly ceiling: Money | null;
  readonly evidenceRef: string;
  readonly createdAt: number;
  readonly createdBy: string;
}

/** Kết quả của `authorizeFunding`. */
export interface FundingAuthorizationOutcome {
  readonly book: FinancialBook;
  readonly authorization: SponsorFundingAuthorization;
  readonly replayed: boolean;
}

/**
 * Đưa một funding authorization vào book ở trạng thái `active`.
 *
 * Sponsor phải tồn tại và `active`; billing account phải tồn tại. Natural key
 * là `(sponsor_id, billing_account_id)` (ADR-0028 §6 B3): replay cùng payload
 * trả record gốc; một authorization khác id hay khác ceiling/evidence cho cùng
 * cặp là `idempotency_conflict`.
 */
export function authorizeFunding(
  book: FinancialBook,
  input: AuthorizeFundingInput,
): FinancialResult<FundingAuthorizationOutcome> {
  if (
    !isOpaqueId(input.authorizationId) ||
    !isOpaqueId(input.sponsorId) ||
    !isOpaqueId(input.billingAccountId) ||
    !isOpaqueId(input.evidenceRef) ||
    !isEpochMillis(input.createdAt) ||
    !isOpaqueId(input.createdBy) ||
    (input.ceiling !== null && !isMoney(input.ceiling))
  ) {
    return financialFailure('invalid_amount');
  }
  const sponsor = findSponsor(book, input.sponsorId);
  if (!sponsor.ok) {
    return financialFailure('funding_authorization_required');
  }
  if (sponsor.value.status !== 'active') {
    return financialFailure('funding_authorization_required');
  }
  const account = findBillingAccount(book, input.billingAccountId as BillingAccountId);
  if (!account.ok) {
    return account;
  }
  const existing = book.fundingAuthorizations.find(
    (candidate) =>
      candidate.sponsor_id === input.sponsorId &&
      candidate.billing_account_id === input.billingAccountId,
  );
  if (existing !== undefined) {
    if (
      existing.authorization_id !== input.authorizationId ||
      existing.evidence_ref !== input.evidenceRef ||
      (input.ceiling === null
        ? existing.ceiling !== null
        : existing.ceiling === null ||
          existing.ceiling.denomination !== input.ceiling.denomination ||
          existing.ceiling.minor !== input.ceiling.minor)
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ book, authorization: existing, replayed: true }));
  }
  const authorization: SponsorFundingAuthorization = Object.freeze({
    authorization_id: input.authorizationId,
    sponsor_id: input.sponsorId,
    billing_account_id: input.billingAccountId as BillingAccountId,
    ceiling: input.ceiling,
    status: 'active',
    evidence_ref: input.evidenceRef,
    created_at: input.createdAt,
    created_by: input.createdBy,
  });
  return financialOk(
    Object.freeze({
      book: Object.freeze({
        ...book,
        fundingAuthorizations: freezeArray([...book.fundingAuthorizations, authorization]),
      }),
      authorization,
      replayed: false,
    }),
  );
}

// ---------------------------------------------------------------------------
// B4 — registerGrant / creditGrant / reverseGrant
// ---------------------------------------------------------------------------

/** Input của `registerGrant` — surface provisioning B4 (ADR-0028 §6). */
export interface RegisterGrantInput {
  readonly grantId: string;
  readonly authorizationId: string;
  readonly amount: Money;
  readonly actorRef: string;
  readonly createdAt: number;
}

/** Kết quả của một operation grant. */
export interface SponsorGrantOutcome {
  readonly book: FinancialBook;
  readonly grant: SponsorGrant;
  readonly replayed: boolean;
}

/**
 * Đăng ký một grant `pending` với provenance bất biến.
 *
 * Không post bút toán, không đổi balance: pending không phải tiền trong ví.
 * Authorization phải còn `active` và sponsor phải `active` — không authorization
 * hiệu lực ⇒ không grant (ADR-0028 §3.2). `sponsor_id` và billing account suy
 * từ authorization và được ghi vào record làm provenance; replay cùng payload
 * trả record gốc, khác payload là `idempotency_conflict`.
 */
export function registerGrant(
  book: FinancialBook,
  input: RegisterGrantInput,
): FinancialResult<SponsorGrantOutcome> {
  if (
    !isOpaqueId(input.grantId) ||
    !isOpaqueId(input.authorizationId) ||
    !isOpaqueId(input.actorRef) ||
    !isEpochMillis(input.createdAt) ||
    !isMoney(input.amount) ||
    input.amount.minor <= 0n
  ) {
    return financialFailure('invalid_amount');
  }
  const authorization = findFundingAuthorization(book, input.authorizationId);
  if (!authorization.ok) {
    return financialFailure('funding_authorization_required');
  }
  if (authorization.value.status !== 'active') {
    return financialFailure('funding_authorization_required');
  }
  const sponsor = findSponsor(book, authorization.value.sponsor_id);
  if (!sponsor.ok || sponsor.value.status !== 'active') {
    return financialFailure('funding_authorization_required');
  }
  const existing = book.grants.find((candidate) => candidate.grant_id === input.grantId);
  if (existing !== undefined) {
    if (
      existing.authorization_id !== input.authorizationId ||
      existing.amount.denomination !== input.amount.denomination ||
      existing.amount.minor !== input.amount.minor ||
      existing.actor_ref !== input.actorRef
    ) {
      return financialFailure('idempotency_conflict');
    }
    return financialOk(Object.freeze({ book, grant: existing, replayed: true }));
  }
  const grant: SponsorGrant = Object.freeze({
    grant_id: input.grantId,
    authorization_id: authorization.value.authorization_id,
    sponsor_id: authorization.value.sponsor_id,
    billing_account_id: authorization.value.billing_account_id,
    amount: input.amount,
    state: 'pending',
    actor_ref: input.actorRef,
    created_at: input.createdAt,
  });
  return financialOk(
    Object.freeze({
      book: Object.freeze({ ...book, grants: freezeArray([...book.grants, grant]) }),
      grant,
      replayed: false,
    }),
  );
}

/** Input của `creditGrant`. */
export interface CreditGrantInput {
  readonly grantId: string;
  readonly creditedAt: number;
  readonly fencingToken: string;
}

/**
 * Cấp UC vào wallet của billing account — `sponsor_funding_clearing → available`.
 *
 * Đây là operation duy nhất kiểm chi tiêu (ADR-0028 §5/§6): authorization
 * `active`, sponsor `active`, CẢ HAI trần — tất cả trong phép gọi này, ngay
 * trước khi post; vượt trần trả đúng mã canonical và **không** có posting riêng
 * phần nào. Replay một grant đã `credited` trả record gốc, không post lại.
 */
export function creditGrant(
  book: FinancialBook,
  input: CreditGrantInput,
): FinancialResult<SponsorGrantOutcome> {
  const found = findGrant(book, input.grantId);
  if (!found.ok) {
    return found;
  }
  const grant = found.value;
  if (grant.state === 'credited') {
    return financialOk(Object.freeze({ book, grant, replayed: true }));
  }
  if (grant.state !== 'pending') {
    return financialFailure('invalid_grant_transition');
  }
  if (!isEpochMillis(input.creditedAt) || !isOpaqueId(input.fencingToken)) {
    return financialFailure('invalid_epoch_millis');
  }
  const authorization = findFundingAuthorization(book, grant.authorization_id);
  if (!authorization.ok || authorization.value.status !== 'active') {
    return financialFailure('funding_authorization_required');
  }
  const sponsor = findSponsor(book, grant.sponsor_id);
  if (!sponsor.ok || sponsor.value.status !== 'active') {
    return financialFailure('funding_authorization_required');
  }
  // Trần sponsor — ADR-0028 §5.1. Denomination của trần phải khớp miền giá trị
  // của grant; lệch miền là dữ liệu cấu hình hỏng, không phải "vô trần" — kiểm
  // trước khi tìm wallet để lỗi phản đúng nguyên nhân.
  const ceiling = sponsor.value.ceiling;
  if (ceiling.denomination !== grant.amount.denomination) {
    return financialFailure('denomination_mismatch');
  }
  // Trần authorization per billing account — ADR-0028 §5.2. `null` là explicit
  // không trần per-account (ADR-0028 §6 B3), không phải thiếu cấu hình.
  const authorizationCeiling = authorization.value.ceiling;
  if (
    authorizationCeiling !== null &&
    authorizationCeiling.denomination !== grant.amount.denomination
  ) {
    return financialFailure('denomination_mismatch');
  }
  const account = findBillingAccount(book, grant.billing_account_id);
  if (!account.ok) {
    return account;
  }
  const wallet = findWalletByDenomination(account.value, grant.amount.denomination);
  if (!wallet.ok) {
    return wallet;
  }
  const sponsorNet = sponsorNetCredited(book, grant.sponsor_id);
  if (sponsorNet + grant.amount.minor > ceiling.minor) {
    return financialFailure('sponsor_ceiling_exceeded');
  }
  // Trần authorization per billing account — ADR-0028 §5.2. `null` là explicit
  // không trần per-account (ADR-0028 §6 B3), không phải thiếu cấu hình.
  if (authorizationCeiling !== null) {
    const authorizationNet = authorizationNetCredited(
      book,
      grant.authorization_id,
      grant.amount.denomination,
    );
    if (authorizationNet + grant.amount.minor > authorizationCeiling.minor) {
      return financialFailure('authorization_ceiling_exceeded');
    }
  }
  const commit = commitTransaction(book, {
    accountId: account.value.billing_account_id,
    walletId: wallet.value.wallet_id,
    denomination: grant.amount.denomination,
    transactionId: derivedTransactionId('sponsor_grant', grant.grant_id, 'credit'),
    idempotencyKey: derivedIdempotencyKey('sponsor_grant', grant.grant_id, 'credit'),
    reference: referenceOf('sponsor_grant', grant.grant_id),
    fencingToken: input.fencingToken,
    createdAt: input.creditedAt,
    legs: [
      { account: 'sponsor_funding_clearing', direction: 'credit', amount: grant.amount },
      { account: 'wallet_available', direction: 'debit', amount: grant.amount },
    ],
  });
  if (!commit.ok) {
    return commit;
  }
  const next: SponsorGrant = Object.freeze({ ...grant, state: 'credited' });
  return financialOk(
    Object.freeze({
      book: replaceGrant(commit.value.book, next),
      grant: next,
      replayed: false,
    }),
  );
}

/** Input của `reverseGrant`. */
export interface ReverseGrantInput {
  readonly grantId: string;
  readonly reversedAt: number;
  readonly fencingToken: string;
  /** Tham chiếu opaque tới bằng chứng clawback — caller cấp. */
  readonly evidenceRef: string;
}

/**
 * Clawback toàn bộ một grant đã credit — `available → sponsor_funding_clearing`.
 *
 * Full-only, một lần, chỉ từ `available` (ADR-0028 §4): `available` không đủ
 * phủ amount ⇒ `insufficient_available_balance`, grant giữ nguyên `credited`,
 * ledger không đổi — không clawback cưỡng bien lên tiền đã tiêu (`charged`) hay
 * đang giữ (`held`). Replay trên grant đã `reversed` trả kết quả gốc — không
 * double-reverse.
 */
export function reverseGrant(
  book: FinancialBook,
  input: ReverseGrantInput,
): FinancialResult<SponsorGrantOutcome> {
  const found = findGrant(book, input.grantId);
  if (!found.ok) {
    return found;
  }
  const grant = found.value;
  if (grant.state === 'reversed') {
    return financialOk(Object.freeze({ book, grant, replayed: true }));
  }
  if (grant.state !== 'credited') {
    return financialFailure('invalid_grant_transition');
  }
  if (
    !isEpochMillis(input.reversedAt) ||
    !isOpaqueId(input.fencingToken) ||
    !isOpaqueId(input.evidenceRef)
  ) {
    return financialFailure('invalid_epoch_millis');
  }
  const account = findBillingAccount(book, grant.billing_account_id);
  if (!account.ok) {
    return account;
  }
  const wallet = findWalletByDenomination(account.value, grant.amount.denomination);
  if (!wallet.ok) {
    return wallet;
  }
  if (wallet.value.balances.available.minor < grant.amount.minor) {
    return financialFailure('insufficient_available_balance');
  }
  const commit = commitTransaction(book, {
    accountId: account.value.billing_account_id,
    walletId: wallet.value.wallet_id,
    denomination: grant.amount.denomination,
    transactionId: derivedTransactionId('sponsor_grant', grant.grant_id, 'reverse'),
    idempotencyKey: derivedIdempotencyKey('sponsor_grant', grant.grant_id, 'reverse'),
    reference: referenceOf('sponsor_grant_reversal', grant.grant_id),
    fencingToken: input.fencingToken,
    createdAt: input.reversedAt,
    legs: [
      { account: 'wallet_available', direction: 'credit', amount: grant.amount },
      { account: 'sponsor_funding_clearing', direction: 'debit', amount: grant.amount },
    ],
  });
  if (!commit.ok) {
    return commit;
  }
  const next: SponsorGrant = Object.freeze({ ...grant, state: 'reversed' });
  return financialOk(
    Object.freeze({
      book: replaceGrant(commit.value.book, next),
      grant: next,
      replayed: false,
    }),
  );
}
