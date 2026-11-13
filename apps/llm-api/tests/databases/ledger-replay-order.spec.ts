/**
 * Regression test cho bất biến replay-order của ledger (Issue #171): hai bút
 * toán cùng mốc `created_at` (resolution mili-giây) phải được hydrate lại đúng
 * thứ tự append — theo `posting_seq` do database cấp (`GENERATED ALWAYS AS
 * IDENTITY`, migration `0005_chat_completions_serving.sql`) — chứ không theo
 * tie-break lexicographic `transaction_id`.
 *
 * Ý nghĩa của `posting_seq` đúng như comment của cột trong migration 0005:
 * thứ tự CẤP PHÁT của sequence tại thời điểm INSERT, toàn bảng, KHÔNG phải
 * thứ tự commit toàn cục; transaction rollback chỉ đốt giá trị sequence
 * (khoảng cách vô hại với thứ tự). Test này chạy mọi persist tuần tự trên một
 * connection nên thứ tự cấp phát trùng thứ tự gọi — đúng điều bất biến cần.
 *
 * Cả ba transaction được tạo qua đường production thật: domain op
 * (`creditGrant`, `reserve` từ `@ecoma-io/llm-financial-domain`) →
 * `persistLedgerTransaction`/`persistReservation`/`ensureWalletRow` từ
 * `src/financial-state.ts` → `loadFinancialState` hydrate lại → suy balance.
 * Không có INSERT SQL trực tiếp nào vào `ledger_transactions`/`ledger_entries`.
 * Chỉ các row tham chiếu tiền điều kiện (billing account, sponsor,
 * authorization, grant) được seed bằng SQL — đúng convention của
 * `chat-completions.spec.ts` và đúng hình dạng INSERT của bootstrap runner.
 *
 * Fixture cố tình dùng BA transaction cùng `created_at` với id xen kẽ thứ tự
 * lexicographic so với thứ tự post: `reservation:tie-hold-30:hold` <
 * `reservation:tie-hold-50:hold` < `sponsor_grant:tie-grant-100:credit` trong
 * khi thứ tự post là credit trước, rồi hold 30, rồi hold 50. Nhờ đó MỌI
 * mutation tổng-thứ-tự TẤT ĐỊNH của hydration đều fail: `ORDER BY
 * transaction_id` (ASC lẫn DESC), `ORDER BY created_at, transaction_id`,
 * `ORDER BY posting_seq DESC` — mọi hoán vị này đều khác thứ tự post, và
 * assert thứ tự tường minh bắt được. Hai mutation còn lại không thể bắt từ
 * black-box trên PostgreSQL: `ORDER BY created_at` thuần (không tie-break) và
 * XOÁ HẲN mệnh đề ORDER BY — với key sắp bằng nhau, thứ tự trả về phụ thuộc
 * heap/sort nội bộ của PostgreSQL (sau TRUNCATE + insert tuần tự, heap order
 * trùng thứ tự insert), không phải hợp đồng SQL; xem PR của Issue #171 cho
 * mutation verification và residual limitation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addBillingAccount,
  attachWallet,
  authorizeFunding,
  createBillingAccount,
  createMoney,
  createWallet,
  creditGrant,
  deriveWalletBalances,
  openFinancialBook,
  registerGrant,
  registerSponsor,
  reserve,
  type FinancialBook,
  type FinancialResult,
  type LedgerTransaction,
  type Money,
} from '@ecoma-io/llm-financial-domain';
import {
  deriveWalletId,
  ensureWalletRow,
  loadFinancialState,
  persistLedgerTransaction,
  persistReservation,
  WALLET_FENCING_TOKEN,
} from '../../src/financial-state.ts';
import { startLlmApiDatabase, type LlmApiDatabase } from '../integrations/harness.ts';
import { resetFinancial } from './bootstrap-database-reset.ts';

/** Mốc thời gian đóng băng cho cả ba transaction — tạo tie `created_at` thật. */
const TIE_TIMESTAMP = 1_760_000_000_000;

const TENANT_REF = 'tenant-ledger-tie';
const BILLING_ACCOUNT_ID = 'billing-account-ledger-tie';
const SPONSOR_ID = 'sponsor-ledger-tie';
const AUTHORIZATION_ID = 'funding-auth-ledger-tie';
const GRANT_ID = 'tie-grant-100';
const RESERVATION_ID_SMALL = 'tie-hold-30';
const RESERVATION_ID_LARGE = 'tie-hold-50';
const OWNER_REF = 'owner-ledger-tie';
const ACTOR = 'llm-api-integration';

const WALLET_ID = deriveWalletId(BILLING_ACCOUNT_ID);

/** Transaction id đầy đủ mà domain lib sẽ sinh — dùng lại trong assert. */
const CREDIT_TRANSACTION_ID = `sponsor_grant:${GRANT_ID}:credit`;
const HOLD_SMALL_TRANSACTION_ID = `reservation:${RESERVATION_ID_SMALL}:hold`;
const HOLD_LARGE_TRANSACTION_ID = `reservation:${RESERVATION_ID_LARGE}:hold`;

/** Thứ tự post mong muốn: credit 100 → hold 30 → hold 50. */
const POSTING_ORDER = [
  CREDIT_TRANSACTION_ID,
  HOLD_SMALL_TRANSACTION_ID,
  HOLD_LARGE_TRANSACTION_ID,
] as const;

/**
 * Thứ tự sắp theo `created_at, transaction_id` — KHÁC thứ tự post (xoay vòng,
 * không phải đảo ngược): đủ để mọi mutation tổng-thứ-tự tất định trả về một
 * hoán vị khác thứ tự post.
 */
const LEXICOGRAPHIC_ORDER = [
  HOLD_SMALL_TRANSACTION_ID,
  HOLD_LARGE_TRANSACTION_ID,
  CREDIT_TRANSACTION_ID,
] as const;

/** Container PostgreSQL dùng chung cho cả describe (mỗi spec file một container). */
let db: LlmApiDatabase;

function unwrap<T>(result: FinancialResult<T>, what: string): T {
  if (!result.ok) {
    throw new Error(`${what} rejected by the domain: ${result.error.code}`);
  }
  return result.value;
}

function uc(minor: bigint): Money<'UC'> {
  return unwrap(createMoney('UC', minor), 'createMoney');
}

/** Extract các transaction mới phát sinh giữa hai trạng thái book. */
function postedTransactions(before: FinancialBook, after: FinancialBook): LedgerTransaction[] {
  const seen = new Set(before.ledger.transactions.map((tx) => tx.transaction_id));
  return after.ledger.transactions.filter((tx) => !seen.has(tx.transaction_id));
}

/**
 * Dựng book in-memory qua đúng các domain op production (sponsor active,
 * authorization active vô trần, grant pending 100 UC) rồi seed các row tham
 * chiếu tương ứng vào PostgreSQL qua một connection migrator — hình dạng INSERT
 * trùng với bootstrap runner. Ledger không bị đụng tới ở đây.
 */
async function seedReferenceRows(): Promise<FinancialBook> {
  let book = openFinancialBook();
  const sponsor = unwrap(
    registerSponsor(book, {
      sponsorId: SPONSOR_ID,
      ownerRef: OWNER_REF,
      ceiling: uc(1_000n),
      createdAt: TIE_TIMESTAMP,
      createdBy: ACTOR,
    }),
    'registerSponsor',
  );
  book = sponsor.book;

  const account = unwrap(
    createBillingAccount({
      billingAccountId: BILLING_ACCOUNT_ID,
      ownerRef: OWNER_REF,
      createdAt: TIE_TIMESTAMP,
    }),
    'createBillingAccount',
  );
  const wallet = unwrap(
    createWallet({
      walletId: WALLET_ID,
      billingAccountId: BILLING_ACCOUNT_ID,
      denomination: 'UC',
      fencingToken: WALLET_FENCING_TOKEN,
    }),
    'createWallet',
  );
  book = unwrap(
    addBillingAccount(book, unwrap(attachWallet(account, wallet), 'attachWallet')),
    'addBillingAccount',
  );

  const authorization = unwrap(
    authorizeFunding(book, {
      authorizationId: AUTHORIZATION_ID,
      sponsorId: SPONSOR_ID,
      billingAccountId: BILLING_ACCOUNT_ID,
      ceiling: null,
      evidenceRef: 'budget-decision:ledger-tie',
      createdAt: TIE_TIMESTAMP,
      createdBy: ACTOR,
    }),
    'authorizeFunding',
  );
  book = authorization.book;

  const grant = unwrap(
    registerGrant(book, {
      grantId: GRANT_ID,
      authorizationId: AUTHORIZATION_ID,
      amount: uc(100n),
      actorRef: ACTOR,
      createdAt: TIE_TIMESTAMP,
    }),
    'registerGrant',
  );
  book = grant.book;

  const client = await db.connectAsMigrator('gateway');
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO llm_financial.billing_accounts
         (billing_account_id, tenant_ref, owner_ref, created_at)
       VALUES ($1, $2, $3, $4)`,
      [account.billing_account_id, TENANT_REF, account.owner_ref, account.created_at],
    );
    await client.query(
      `INSERT INTO llm_financial.sponsors
         (sponsor_id, owner_ref, ceiling_minor, ceiling_denomination, status, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sponsor.sponsor.sponsor_id,
        sponsor.sponsor.owner_ref,
        sponsor.sponsor.ceiling.minor.toString(),
        sponsor.sponsor.ceiling.denomination,
        sponsor.sponsor.status,
        sponsor.sponsor.created_at,
        sponsor.sponsor.created_by,
      ],
    );
    await client.query(
      `INSERT INTO llm_financial.sponsor_funding_authorizations
         (authorization_id, sponsor_id, billing_account_id, ceiling_minor, ceiling_denomination, status, evidence_ref, created_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        authorization.authorization.authorization_id,
        authorization.authorization.sponsor_id,
        authorization.authorization.billing_account_id,
        null,
        null,
        authorization.authorization.status,
        authorization.authorization.evidence_ref,
        authorization.authorization.created_at,
        authorization.authorization.created_by,
      ],
    );
    // Grant đã `credited` trong book sau creditGrant ở bước post (xem
    // seedTieTransactions) — row bền phản chiếu đúng outcome domain đó, cùng
    // trạng thái cuối mà bootstrap + serving replay để lại.
    await client.query(
      `INSERT INTO llm_financial.sponsor_grants
         (grant_id, authorization_id, sponsor_id, billing_account_id, amount_minor, amount_denomination, state, actor_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        grant.grant.grant_id,
        grant.grant.authorization_id,
        grant.grant.sponsor_id,
        grant.grant.billing_account_id,
        grant.grant.amount.minor.toString(),
        grant.grant.amount.denomination,
        'credited',
        grant.grant.actor_ref,
        grant.grant.created_at,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  return book;
}

/**
 * Post ba transaction cùng `created_at` qua đúng chuỗi production:
 * domain op → persist (trong một transaction gateway của runtime role) —
 * `posting_seq` do PostgreSQL cấp theo thứ tự INSERT.
 */
async function seedTieTransactions(book: FinancialBook): Promise<void> {
  let working = book;
  const client = await db.connectAsRuntime('gateway');
  try {
    await client.query('BEGIN');
    await ensureWalletRow(client, { billingAccountId: BILLING_ACCOUNT_ID, walletId: WALLET_ID });

    // Transaction A: credit 100 UC vào wallet (qua ceiling kiểm của creditGrant).
    const credit = unwrap(
      creditGrant(working, {
        grantId: GRANT_ID,
        creditedAt: TIE_TIMESTAMP,
        fencingToken: WALLET_FENCING_TOKEN,
      }),
      'creditGrant',
    );
    working = credit.book;
    for (const transaction of postedTransactions(book, working)) {
      await persistLedgerTransaction(client, transaction);
    }

    // Transaction B: hold 30 UC — `wallet_available` −30, `wallet_held` +30.
    const holdSmall = unwrap(
      reserve(working, {
        reservationId: RESERVATION_ID_SMALL,
        walletId: WALLET_ID,
        billingAccountId: BILLING_ACCOUNT_ID,
        amount: uc(30n),
        createdAt: TIE_TIMESTAMP,
        fencingToken: WALLET_FENCING_TOKEN,
      }),
      'reserve (30)',
    );
    working = holdSmall.book;
    for (const transaction of postedTransactions(book, working)) {
      await persistLedgerTransaction(client, transaction);
    }
    await persistReservation(client, holdSmall.reservation);

    // Transaction C: hold 50 UC — cùng mốc `created_at`, append sau hold 30.
    const holdLarge = unwrap(
      reserve(working, {
        reservationId: RESERVATION_ID_LARGE,
        walletId: WALLET_ID,
        billingAccountId: BILLING_ACCOUNT_ID,
        amount: uc(50n),
        createdAt: TIE_TIMESTAMP,
        fencingToken: WALLET_FENCING_TOKEN,
      }),
      'reserve (50)',
    );
    working = holdLarge.book;
    for (const transaction of postedTransactions(book, working)) {
      await persistLedgerTransaction(client, transaction);
    }
    await persistReservation(client, holdLarge.reservation);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

interface LedgerRow {
  transaction_id: string;
  created_at: string;
  posting_seq: string;
}

/** Đọc các row ledger của wallet theo một ORDER BY chỉ định. */
async function fetchLedgerRows(orderBy: string): Promise<LedgerRow[]> {
  const client = await db.connectAsRuntime('gateway');
  try {
    const result = await client.query<LedgerRow>(
      `SELECT transaction_id, created_at, posting_seq
         FROM llm_financial.ledger_transactions
        WHERE wallet_id = $1
        ORDER BY ${orderBy}`,
      [WALLET_ID],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

describe('ledger replay order under same-millisecond created_at ties', () => {
  beforeAll(async () => {
    db = await startLlmApiDatabase();
  }, 180_000);

  beforeEach(async () => {
    await resetFinancial(db);
  });

  afterAll(async () => {
    await db?.stop();
  });

  it('hydrates the tie in posting_seq allocation order and derives the wallet balance', async () => {
    const book = await seedReferenceRows();
    await seedTieTransactions(book);

    // 1-3. Cả ba transaction tồn tại, `created_at` trùng nhau tuyệt đối,
    //      `posting_seq` khác nhau và tăng đúng thứ tự post.
    const rows = await fetchLedgerRows('posting_seq');
    expect(rows.map((row) => row.transaction_id)).toEqual([...POSTING_ORDER]);
    const seqs = rows.map((row) => BigInt(row.posting_seq));
    expect(new Set(seqs).size).toBe(3);
    // Đã khác nhau đôi một: mảng tăng nghiêm ngặt ⟺ sắp lại vẫn bằng chính nó.
    expect(seqs.toSorted((a, b) => (a < b ? -1 : 1))).toEqual(seqs);
    const createdAtValues = rows.map((row) => BigInt(row.created_at));
    expect(createdAtValues).toEqual([
      BigInt(TIE_TIMESTAMP),
      BigInt(TIE_TIMESTAMP),
      BigInt(TIE_TIMESTAMP),
    ]);

    // 4-7. Hydration trả lại đúng thứ tự post, balance suy ra 20/80/0/100 UC,
    //      conservation per-transaction giữ nguyên, grant credit không bị
    //      replay thêm lần nữa.
    const client = await db.connectAsRuntime('gateway');
    let state;
    try {
      state = await loadFinancialState(client, {
        billingAccountId: BILLING_ACCOUNT_ID,
        walletId: WALLET_ID,
      });
    } finally {
      await client.end();
    }
    expect(state.grantsAwaitingCredit).toEqual([]);
    expect(state.book.ledger.transactions.map((tx) => tx.transaction_id)).toEqual([
      ...POSTING_ORDER,
    ]);

    const balances = unwrap(
      deriveWalletBalances(state.book.ledger, WALLET_ID, 'UC'),
      'deriveWalletBalances',
    );
    expect(balances.available.minor).toBe(20n);
    expect(balances.held.minor).toBe(80n);
    expect(balances.charged.minor).toBe(0n);
    expect(balances.total.minor).toBe(100n);

    // 8. Conservation per-transaction: tổng debit = tổng credit trên mọi
    //    transaction của wallet.
    const entryClient = await db.connectAsRuntime('gateway');
    try {
      const result = await entryClient.query<{
        transaction_id: string;
        debits: string;
        credits: string;
      }>(
        `SELECT transaction_id,
                SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE 0 END) AS debits,
                SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE 0 END) AS credits
           FROM llm_financial.ledger_entries
          WHERE wallet_id = $1
          GROUP BY transaction_id`,
        [WALLET_ID],
      );
      expect(result.rows).toHaveLength(3);
      const conservationById = new Map(
        result.rows.map((row) => [row.transaction_id, BigInt(row.debits) === BigInt(row.credits)]),
      );
      for (const transactionId of POSTING_ORDER) {
        expect(conservationById.get(transactionId)).toBe(true);
      }
    } finally {
      await entryClient.end();
    }
  });

  it('orders the same tie differently when forced through created_at and transaction_id', async () => {
    const book = await seedReferenceRows();
    await seedTieTransactions(book);

    // Negative control tất định: với created_at trùng nhau, tie-break
    // `transaction_id` sinh thứ tự KHÁC thứ tự post — chứng minh fixture
    // phân biệt được hai phép sắp, và rằng hydration đang bám `posting_seq`.
    const rows = await fetchLedgerRows('created_at, transaction_id');
    expect(rows.map((row) => row.transaction_id)).toEqual([...LEXICOGRAPHIC_ORDER]);
    expect(rows.map((row) => row.transaction_id)).not.toEqual([...POSTING_ORDER]);
  });
});
