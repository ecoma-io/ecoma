/**
 * Adapter bền của `FinancialBook` cho serving path: hydrate state tài chính
 * từ `llm_financial` (billing account, wallet, ledger, reservations, charges,
 * sponsor funding) vào aggregate thuần của `llm-financial-domain`, chạy
 * operation qua domain, rồi persist kết quả lại — KHÔNG BAO GIỜ tự tính balance
 * hay tự dựng bút toán ngoài lib.
 *
 * Điểm phục hồi then chốt của MVP (0004 đã ghi trong header): step-10 bootstrap
 * chạy `creditGrant` IN-MEMORY — bút toán `sponsor_grant:<grant_id>:credit`
 * chưa từng được persist. Serving slice sở hữu projection wallet/ledger, nên
 * lần hydrate đầu của mỗi wallet REPLAY credit grant qua chính lib
 * (`creditGrant` với grant hydrate ở state `pending` khi transaction credit
 * chưa có trong ledger): ceiling kiểm lại đúng trên state bền
 * (`sponsor_grants.state`), transaction id/idempotency key tất định nên
 * replay nhiều lần vô hại. Sau đó mọi operation mới (reserve/capture/release/
 * settle) post qua lib và được persist trong CÙNG transaction gateway của
 * phase gọi.
 *
 * Fail-closed: row hỏng hình (shape guard của lib từ chối), thiếu billing
 * account/wallet, hay ledger không nhất quán (conservation vỡ khi derive
 * balances) đều ném {@link FinancialStateError} — caller trả 503, không bao
 * giờ serving trên state không đọc được.
 */
import {
  addBillingAccount,
  creditGrant,
  createMoney,
  deriveWalletBalances,
  isChargeState,
  isFundingAuthorizationStatus,
  isLedgerAccount,
  isLedgerDirection,
  isLedgerReferenceType,
  isReservationState,
  isSponsorGrantState,
  isSponsorStatus,
  openFinancialBook,
  zeroMoney,
  type ChargeState,
  type CustomerCharge,
  type Denomination,
  type FinancialBook,
  type FundingAuthorizationStatus,
  type Ledger,
  type LedgerAccount,
  type LedgerDirection,
  type LedgerReference,
  type LedgerTransaction,
  type Money,
  type Reservation,
  type ReservationState,
  type Sponsor,
  type SponsorFundingAuthorization,
  type SponsorGrant,
  type SponsorGrantState,
  type SponsorStatus,
} from '@ecoma-io/llm-financial-domain';
import type { Client } from 'pg';

/** Lỗi hydrate/persist state tài chính — chi tiết không bao giờ vào log. */
export class FinancialStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinancialStateError';
  }
}

/** Denomination serving của MVP: UC (denomination duy nhất bootstrap cấp). */
export const SERVING_DENOMINATION: Denomination = 'UC';

/** Fencing token ghi lúc tạo wallet row — operation sau này phải trình đúng token này. */
export const WALLET_FENCING_TOKEN = 'fence:llm-api:serving:v1';

/** Wallet id tất định của một billing account ở denomination serving. */
export function deriveWalletId(billingAccountId: string): string {
  return `wallet:${billingAccountId}:${SERVING_DENOMINATION}`;
}

/** Wallet id tất định cho một tenant (billing account resolution là việc caller). */
export function walletIdForTenant(billingAccountId: string): string {
  return deriveWalletId(billingAccountId);
}

/**
 * Đảm bảo wallet row tồn tại cho billing account (guard-create idempotent) và
 * trả fencing token hiệu lực. Chạy TRONG transaction gateway của phase gọi —
 * row mới chỉ thấy được sau commit như mọi writer khác.
 */
export async function ensureWalletRow(
  client: Client,
  input: { billingAccountId: string; walletId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO llm_financial.wallets
       (wallet_id, billing_account_id, denomination, fencing_token, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (wallet_id) DO NOTHING`,
    [
      input.walletId,
      input.billingAccountId,
      SERVING_DENOMINATION,
      WALLET_FENCING_TOKEN,
      Date.now(),
      'llm-api-serving',
    ],
  );
}

// ---------------------------------------------------------------------------
// Row shapes đọc từ llm_financial
// ---------------------------------------------------------------------------

interface BillingAccountRow {
  billing_account_id: string;
  owner_ref: string;
  created_at: string;
}

interface WalletRow {
  wallet_id: string;
  denomination: string;
  fencing_token: string;
}

interface LedgerTransactionRow {
  transaction_id: string;
  idempotency_key: string;
  denomination: string;
  reference: string;
  fingerprint: string;
  fencing_token: string;
  created_at: string;
}

interface LedgerEntryRow {
  entry_id: string;
  transaction_id: string;
  account: string;
  direction: string;
  amount_minor: string;
}

interface ReservationRow {
  reservation_id: string;
  denomination: string;
  reserved_minor: string;
  captured_minor: string;
  released_minor: string;
  state: string;
  fencing_token: string;
  created_at: string;
  finalized_at: string | null;
}

interface ChargeRow {
  charge_id: string;
  settlement_id: string | null;
  reservation_id: string | null;
  denomination: string;
  amount_minor: string;
  refunded_minor: string;
  increase_minor: string;
  decrease_minor: string;
  state: string;
  created_at: string;
  posted_at: string | null;
}

interface SponsorRow {
  sponsor_id: string;
  owner_ref: string;
  ceiling_minor: string;
  ceiling_denomination: string;
  status: string;
  created_at: string;
  created_by: string;
}

interface AuthorizationRow {
  authorization_id: string;
  sponsor_id: string;
  ceiling_minor: string | null;
  ceiling_denomination: string | null;
  status: string;
  evidence_ref: string;
  created_at: string;
  created_by: string;
}

interface GrantRow {
  grant_id: string;
  authorization_id: string;
  sponsor_id: string;
  amount_minor: string;
  amount_denomination: string;
  state: string;
  actor_ref: string;
  created_at: string;
}

/** Đọc BIGINT (`pg` trả string) thành number an toàn — sai là lỗi state. */
function rowEpochMillis(value: string | number, where: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new FinancialStateError(`invalid epoch millis in ${where}`);
  }
  return parsed;
}

/** Đọc minor units BIGINT thành bigint — sai là lỗi state. */
function rowMinor(value: string | number, where: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) {
      throw new Error('negative');
    }
    return parsed;
  } catch {
    throw new FinancialStateError(`invalid minor amount in ${where}`);
  }
}

/** Money từ hai cột (minor, denomination) — denomination lệch là lỗi state. */
function rowMoney(minor: string | number, denomination: string, where: string): Money {
  if (denomination !== SERVING_DENOMINATION) {
    throw new FinancialStateError(`unexpected denomination in ${where}`);
  }
  const money = createMoney(SERVING_DENOMINATION, rowMinor(minor, where));
  if (!money.ok) {
    throw new FinancialStateError(`invalid money in ${where}: ${money.error.code}`);
  }
  return money.value;
}

/**
 * Narrow một cột string thành enum của domain lib qua shape guard của lib —
 * giá trị lạ là state hỏng, fail-closed ngay tại hydrate (không serving trên
 * dữ liệu không đọc được shape).
 */
function rowEnum<N extends string>(
  value: string,
  guard: (candidate: unknown) => candidate is N,
  where: string,
): N {
  if (!guard(value)) {
    throw new FinancialStateError(`invalid enum value in ${where}`);
  }
  return value;
}

/** Serialize LedgerReference thành một chuỗi `type:id` cho cột `reference`. */
export function serializeReference(reference: LedgerReference): string {
  return `${reference.type}:${reference.id}`;
}

/** Parse `type:id` trở lại LedgerReference — sai hình là lỗi state. */
function parseReference(value: string): LedgerReference {
  const separator = value.indexOf(':');
  if (separator <= 0) {
    throw new FinancialStateError('invalid ledger reference');
  }
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!isLedgerReferenceType(type) || id.length === 0) {
    throw new FinancialStateError('invalid ledger reference type');
  }
  return { type, id };
}

// ---------------------------------------------------------------------------
// Hydrate
// ---------------------------------------------------------------------------

/** Kết quả hydrate: book hoàn chỉnh + token fencing của wallet. */
export interface LoadedFinancialState {
  readonly book: FinancialBook;
  readonly walletFencingToken: string;
  /** Grant id có state `credited` bền nhưng transaction credit chưa nằm trong ledger. */
  readonly grantsAwaitingCredit: readonly string[];
}

async function queryRows<T>(client: Client, sql: string, params: readonly unknown[]): Promise<T[]> {
  const result = await client.query(sql, params as unknown[]);
  return result.rows as T[];
}

/** Hydrate toàn bộ state tài chính phục vụ một wallet trong transaction hiện tại. */
export async function loadFinancialState(
  client: Client,
  input: { billingAccountId: string; walletId: string },
): Promise<LoadedFinancialState> {
  const accountRows = await queryRows<BillingAccountRow>(
    client,
    'SELECT billing_account_id, owner_ref, created_at FROM llm_financial.billing_accounts WHERE billing_account_id = $1',
    [input.billingAccountId],
  );
  const accountRow = accountRows[0];
  if (accountRow === undefined) {
    throw new FinancialStateError('billing account row missing');
  }
  const walletRows = await queryRows<WalletRow>(
    client,
    'SELECT wallet_id, denomination, fencing_token FROM llm_financial.wallets WHERE wallet_id = $1',
    [input.walletId],
  );
  const walletRow = walletRows[0];
  if (walletRow === undefined) {
    throw new FinancialStateError('wallet row missing');
  }

  // --- ledger (wallet-scoped) --------------------------------------------
  // Thứ tự replay là THỨ TỰ APPEND (`posting_seq`, do database cấp): created_at
  // chỉ có resolution mili-giây nên hai posting cùng mili-giây tạo tie, và tie
  // lexicographic theo transaction_id dựng lại ledger SAI thứ tự post — số dư
  // per-account chạy transient âm trên ledger lành (conservation vỡ giả).
  const txRows = await queryRows<LedgerTransactionRow>(
    client,
    `SELECT transaction_id, idempotency_key, denomination, reference, fingerprint, fencing_token, created_at
       FROM llm_financial.ledger_transactions WHERE wallet_id = $1 ORDER BY posting_seq`,
    [input.walletId],
  );
  const entryRows = await queryRows<LedgerEntryRow>(
    client,
    `SELECT entry_id, transaction_id, account, direction, amount_minor
       FROM llm_financial.ledger_entries WHERE wallet_id = $1 ORDER BY entry_id`,
    [input.walletId],
  );
  const entriesByTransaction = new Map<string, LedgerEntryRow[]>();
  for (const entryRow of entryRows) {
    const existing = entriesByTransaction.get(entryRow.transaction_id);
    if (existing === undefined) {
      entriesByTransaction.set(entryRow.transaction_id, [entryRow]);
    } else {
      existing.push(entryRow);
    }
  }
  const transactions: LedgerTransaction[] = txRows.map((txRow) => {
    const reference = parseReference(txRow.reference);
    const created = rowEpochMillis(txRow.created_at, 'ledger transaction');
    const legs = entriesByTransaction.get(txRow.transaction_id) ?? [];
    return Object.freeze({
      transaction_id: txRow.transaction_id,
      idempotency_key: txRow.idempotency_key,
      wallet_id: input.walletId,
      billing_account_id: input.billingAccountId,
      denomination: SERVING_DENOMINATION,
      entries: Object.freeze(
        legs.map((leg) =>
          Object.freeze({
            entry_id: leg.entry_id,
            transaction_id: leg.transaction_id,
            wallet_id: input.walletId,
            billing_account_id: input.billingAccountId,
            denomination: SERVING_DENOMINATION,
            // Enum narrow qua shape guard của lib NGAY TẠI HYDRATE — giá trị lạ
            // là state hỏng, ném FinancialStateError trước khi dựng book.
            account: rowEnum<LedgerAccount>(leg.account, isLedgerAccount, 'ledger entry account'),
            direction: rowEnum<LedgerDirection>(
              leg.direction,
              isLedgerDirection,
              'ledger entry direction',
            ),
            amount: rowMoney(leg.amount_minor, SERVING_DENOMINATION, 'ledger entry'),
            fencing_token: txRow.fencing_token,
            created_at: created,
            reference,
          }),
        ),
      ),
      reference,
      fencing_token: txRow.fencing_token,
      created_at: created,
      fingerprint: txRow.fingerprint,
    });
  });
  const ledger: Ledger = Object.freeze({ transactions: Object.freeze(transactions) });

  // --- reservations + charges (chỉ row phục vụ attempt hiện tại) ----------
  const reservationRows = await queryRows<ReservationRow>(
    client,
    `SELECT reservation_id, denomination, reserved_minor, captured_minor, released_minor, state, fencing_token, created_at, finalized_at
       FROM llm_financial.financial_reservations WHERE wallet_id = $1`,
    [input.walletId],
  );
  const reservations: Reservation[] = reservationRows.map((row) =>
    Object.freeze({
      reservation_id: row.reservation_id,
      wallet_id: input.walletId,
      billing_account_id: input.billingAccountId,
      denomination: SERVING_DENOMINATION,
      reserved: rowMoney(row.reserved_minor, row.denomination, 'reservation reserved'),
      captured:
        row.captured_minor === '0'
          ? zeroMoney(SERVING_DENOMINATION)
          : rowMoney(row.captured_minor, row.denomination, 'reservation captured'),
      released:
        row.released_minor === '0'
          ? zeroMoney(SERVING_DENOMINATION)
          : rowMoney(row.released_minor, row.denomination, 'reservation released'),
      state: rowEnum<ReservationState>(row.state, isReservationState, 'reservation state'),
      created_at: rowEpochMillis(row.created_at, 'reservation created_at'),
      finalized_at:
        row.finalized_at === null
          ? null
          : rowEpochMillis(row.finalized_at, 'reservation finalized_at'),
      fencing_token: row.fencing_token,
    }),
  );

  const chargeRows = await queryRows<ChargeRow>(
    client,
    `SELECT charge_id, settlement_id, reservation_id, denomination, amount_minor, refunded_minor, increase_minor, decrease_minor, state, created_at, posted_at
       FROM llm_financial.customer_charges WHERE wallet_id = $1`,
    [input.walletId],
  );
  const charges: CustomerCharge[] = chargeRows.map((row) =>
    Object.freeze({
      charge_id: row.charge_id,
      wallet_id: input.walletId,
      billing_account_id: input.billingAccountId,
      denomination: SERVING_DENOMINATION,
      amount: rowMoney(row.amount_minor, row.denomination, 'charge amount'),
      refunded: rowMoney(row.refunded_minor, row.denomination, 'charge refunded'),
      increase: rowMoney(row.increase_minor, row.denomination, 'charge increase'),
      decrease: rowMoney(row.decrease_minor, row.denomination, 'charge decrease'),
      state: rowEnum<ChargeState>(row.state, isChargeState, 'charge state'),
      reservation_id: row.reservation_id,
      settlement_id: row.settlement_id,
      created_at: rowEpochMillis(row.created_at, 'charge created_at'),
      posted_at: row.posted_at === null ? null : rowEpochMillis(row.posted_at, 'charge posted_at'),
    }),
  );

  // --- sponsor funding (ceiling re-check cho replay credit) ---------------
  const sponsorRows = await queryRows<SponsorRow>(
    client,
    `SELECT s.sponsor_id, s.owner_ref, s.ceiling_minor, s.ceiling_denomination, s.status, s.created_at, s.created_by
       FROM llm_financial.sponsors s
       JOIN llm_financial.sponsor_funding_authorizations a ON a.sponsor_id = s.sponsor_id
      WHERE a.billing_account_id = $1`,
    [input.billingAccountId],
  );
  const authorizationRows = await queryRows<AuthorizationRow>(
    client,
    `SELECT authorization_id, sponsor_id, ceiling_minor, ceiling_denomination, status, evidence_ref, created_at, created_by
       FROM llm_financial.sponsor_funding_authorizations WHERE billing_account_id = $1`,
    [input.billingAccountId],
  );
  const grantRows = await queryRows<GrantRow>(
    client,
    `SELECT grant_id, authorization_id, sponsor_id, amount_minor, amount_denomination, state, actor_ref, created_at
       FROM llm_financial.sponsor_grants WHERE billing_account_id = $1`,
    [input.billingAccountId],
  );
  const sponsors: Sponsor[] = sponsorRows.map((row) =>
    Object.freeze({
      sponsor_id: row.sponsor_id,
      owner_ref: row.owner_ref,
      ceiling: rowMoney(row.ceiling_minor, row.ceiling_denomination, 'sponsor ceiling'),
      status: rowEnum<SponsorStatus>(row.status, isSponsorStatus, 'sponsor status'),
      created_at: rowEpochMillis(row.created_at, 'sponsor created_at'),
      created_by: row.created_by,
    }),
  );
  const authorizations: SponsorFundingAuthorization[] = authorizationRows.map((row) =>
    Object.freeze({
      authorization_id: row.authorization_id,
      sponsor_id: row.sponsor_id,
      billing_account_id: input.billingAccountId,
      ceiling:
        row.ceiling_minor === null || row.ceiling_denomination === null
          ? null
          : rowMoney(row.ceiling_minor, row.ceiling_denomination, 'authorization ceiling'),
      status: rowEnum<FundingAuthorizationStatus>(
        row.status,
        isFundingAuthorizationStatus,
        'authorization status',
      ),
      evidence_ref: row.evidence_ref,
      created_at: rowEpochMillis(row.created_at, 'authorization created_at'),
      created_by: row.created_by,
    }),
  );

  // Grant `credited` mà transaction credit chưa có trong ledger → hydrate ở
  // state `pending` để `creditGrant` replay bút toán qua lib (đúng ceiling
  // check); đã có transaction → hydrate đúng state `credited`.
  const existingCreditIds = new Set(
    transactions.map((tx) =>
      tx.transaction_id.startsWith('sponsor_grant:') ? tx.transaction_id : '',
    ),
  );
  const grantsAwaitingCredit: string[] = [];
  const grants: SponsorGrant[] = grantRows.map((row) => {
    const creditTransactionId = `sponsor_grant:${row.grant_id}:credit`;
    const creditPosted = existingCreditIds.has(creditTransactionId);
    if (!creditPosted && row.state === 'credited') {
      grantsAwaitingCredit.push(row.grant_id);
    }
    return Object.freeze({
      grant_id: row.grant_id,
      authorization_id: row.authorization_id,
      sponsor_id: row.sponsor_id,
      billing_account_id: input.billingAccountId,
      amount: rowMoney(row.amount_minor, row.amount_denomination, 'grant amount'),
      // Ledger là sự thật về credit: có transaction credit → `credited`; chưa
      // có mà row bảo `credited` → hydrate `pending` để `creditGrant` replay
      // bút toán; state lạ → fail-closed.
      state: creditPosted
        ? ('credited' as SponsorGrantState)
        : row.state === 'credited'
          ? ('pending' as SponsorGrantState)
          : rowEnum<SponsorGrantState>(row.state, isSponsorGrantState, 'grant state'),
      actor_ref: row.actor_ref,
      created_at: rowEpochMillis(row.created_at, 'grant created_at'),
    });
  });

  // --- dựng book ----------------------------------------------------------
  const balances = deriveWalletBalances(ledger, input.walletId, SERVING_DENOMINATION);
  if (!balances.ok) {
    throw new FinancialStateError(`ledger conservation violated: ${balances.error.code}`);
  }
  const account = Object.freeze({
    billing_account_id: input.billingAccountId,
    owner_ref: accountRow.owner_ref,
    created_at: rowEpochMillis(accountRow.created_at, 'billing account created_at'),
    wallets: Object.freeze([
      Object.freeze({
        wallet_id: input.walletId,
        billing_account_id: input.billingAccountId,
        denomination: SERVING_DENOMINATION,
        balances: balances.value,
        fencing_token: walletRow.fencing_token,
      }),
    ]),
  });
  const base = openFinancialBook();
  const withAccount = addBillingAccount(base, account);
  if (!withAccount.ok) {
    throw new FinancialStateError(`billing account rejected by domain: ${withAccount.error.code}`);
  }
  const book: FinancialBook = Object.freeze({
    ...withAccount.value,
    ledger,
    reservations: Object.freeze(reservations),
    charges: Object.freeze(charges),
    sponsors: Object.freeze(sponsors),
    fundingAuthorizations: Object.freeze(authorizations),
    grants: Object.freeze(grants),
  });

  return { book, walletFencingToken: walletRow.fencing_token, grantsAwaitingCredit };
}

/**
 * Replay credit grant còn thiếu qua lib (`creditGrant` — grant hydrate ở state
 * `pending`, ceiling kiểm lại trên state bền). Trả book mới; caller persist
 * các transaction mới post trong CÙNG gateway transaction.
 */
export function replayGrantCredits(
  state: LoadedFinancialState,
  creditedAt: number,
): { book: FinancialBook; posted: LedgerTransaction[] } {
  let book = state.book;
  // Transaction mới = chênh lệch ledger trước/sau mỗi operation (outcome của
  // lib là { book, grant, replayed } — transaction nằm trong book.ledger).
  const seen = new Set(book.ledger.transactions.map((tx) => tx.transaction_id));
  const posted: LedgerTransaction[] = [];
  for (const grantId of state.grantsAwaitingCredit) {
    const outcome = creditGrant(book, {
      grantId,
      creditedAt,
      fencingToken: state.walletFencingToken,
    });
    if (!outcome.ok) {
      throw new FinancialStateError(`grant credit replay rejected: ${outcome.error.code}`);
    }
    book = outcome.value.book;
    for (const tx of book.ledger.transactions) {
      if (!seen.has(tx.transaction_id)) {
        seen.add(tx.transaction_id);
        posted.push(tx);
      }
    }
  }
  return { book, posted };
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

/** Persist một transaction lib post (idempotent theo transaction_id). */
export async function persistLedgerTransaction(
  client: Client,
  transaction: LedgerTransaction,
): Promise<void> {
  await client.query(
    `INSERT INTO llm_financial.ledger_transactions
       (transaction_id, idempotency_key, wallet_id, billing_account_id, denomination,
        reference, fingerprint, fencing_token, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [
      transaction.transaction_id,
      transaction.idempotency_key,
      transaction.wallet_id,
      transaction.billing_account_id,
      transaction.denomination,
      serializeReference(transaction.reference),
      transaction.fingerprint,
      transaction.fencing_token,
      transaction.created_at,
    ],
  );
  for (const entry of transaction.entries) {
    await client.query(
      `INSERT INTO llm_financial.ledger_entries
         (entry_id, transaction_id, wallet_id, account, direction, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (entry_id) DO NOTHING`,
      [
        entry.entry_id,
        transaction.transaction_id,
        entry.wallet_id,
        entry.account,
        entry.direction,
        entry.amount.minor.toString(),
      ],
    );
  }
}

/** Persist state reservation sau operation (upsert — domain là writer duy nhất). */
export async function persistReservation(client: Client, reservation: Reservation): Promise<void> {
  await client.query(
    `INSERT INTO llm_financial.financial_reservations
       (reservation_id, wallet_id, billing_account_id, denomination, reserved_minor,
        captured_minor, released_minor, state, fencing_token, created_at, finalized_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (reservation_id) DO UPDATE SET
       captured_minor = EXCLUDED.captured_minor,
       released_minor = EXCLUDED.released_minor,
       state = EXCLUDED.state,
       finalized_at = EXCLUDED.finalized_at`,
    [
      reservation.reservation_id,
      reservation.wallet_id,
      reservation.billing_account_id,
      reservation.denomination,
      reservation.reserved.minor.toString(),
      reservation.captured.minor.toString(),
      reservation.released.minor.toString(),
      reservation.state,
      reservation.fencing_token,
      reservation.created_at,
      reservation.finalized_at,
    ],
  );
}

/** Persist customer charge sau settle (idempotent theo charge_id). */
export async function persistCharge(client: Client, charge: CustomerCharge): Promise<void> {
  await client.query(
    `INSERT INTO llm_financial.customer_charges
       (charge_id, settlement_id, reservation_id, wallet_id, billing_account_id, denomination,
        amount_minor, refunded_minor, increase_minor, decrease_minor, state, created_at, posted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (charge_id) DO NOTHING`,
    [
      charge.charge_id,
      charge.settlement_id,
      charge.reservation_id,
      charge.wallet_id,
      charge.billing_account_id,
      charge.denomination,
      charge.amount.minor.toString(),
      charge.refunded.minor.toString(),
      charge.increase.minor.toString(),
      charge.decrease.minor.toString(),
      charge.state,
      charge.created_at,
      charge.posted_at,
    ],
  );
}
