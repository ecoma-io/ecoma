/**
 * Spec sponsor funding (ADR-0028 §4–§6) — ghim các bất biến của slice funding:
 *
 * - Bút toán credit là `sponsor_funding_clearing → wallet_available`; reverse là
 *   đường đối xứng; conservation không đổi qua cả hai phép.
 * - Cả hai trần (sponsor + authorization) được kiểm **trong `creditGrant`**, và
 *   một phép kiểm trần vượt phải không để lại posting riêng phần nào.
 * - Trần đo bằng **net credited** (Σ credited − Σ reversed), nên reverse hoàn
 *   trả ngân sách.
 * - Idempotency tất định theo entity id: replay cùng payload trả kết quả gốc,
 *   khác payload là `idempotency_conflict`.
 * - Không authorization active + sponsor active ⇒ không grant và không credit.
 * - Reverse full-only, một lần, chỉ từ `available`.
 */

import { describe, expect, it } from 'vitest';

import { addBillingAccount, locateWallet } from './book';
import type { FinancialBook } from './book';
import { capture, reserve } from './reservation';
import {
  authorizationNetCredited,
  authorizeFunding,
  creditGrant,
  findGrant,
  isSponsor,
  isSponsorFundingAuthorization,
  isSponsorGrant,
  registerGrant,
  registerSponsor,
  reverseGrant,
  sponsorNetCredited,
} from './sponsor';
import { createTestBook, failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';
import { createBillingAccount, createWallet } from './wallet';
import type { Money } from './money';

// ---------------------------------------------------------------------------
// Fixture: sponsor + authorization trỏ vào account console (UC wallet rỗng).
// ---------------------------------------------------------------------------

const SPONSOR_ID = 'sponsor-hq';
const AUTH_ID = 'auth-hq-consumer';
const EVIDENCE_REF = 'budget-decision:2026-Q4:1';
const OWNER_REF = 'owner-sponsor-hq';

/** Book đã seed sponsor (trần 1.000.000 UC) + authorization (trần 500.000 UC). */
function seededBook(options?: {
  readonly sponsorCeiling?: Money<'UC'>;
  readonly authorizationCeiling?: Money<'UC'> | null;
}): FinancialBook {
  const { book } = createTestBook({ ucAmount: 0n });
  const withSponsor = unwrap(
    registerSponsor(book, {
      sponsorId: SPONSOR_ID,
      ownerRef: OWNER_REF,
      ceiling: options?.sponsorCeiling ?? uc(1_000_000n),
      createdAt: NOW,
      createdBy: 'bootstrap',
    }),
  ).book;
  return unwrap(
    authorizeFunding(withSponsor, {
      authorizationId: AUTH_ID,
      sponsorId: SPONSOR_ID,
      billingAccountId: IDS.consoleAccount,
      ceiling:
        options?.authorizationCeiling === undefined ? uc(500_000n) : options.authorizationCeiling,
      evidenceRef: EVIDENCE_REF,
      createdAt: NOW,
      createdBy: 'bootstrap',
    }),
  ).book;
}

/** Đăng ký một grant pending trên authorization fixture. */
function pendingGrant(
  book: FinancialBook,
  grantId: string,
  amount: Money<'UC'> = uc(100n),
): FinancialBook {
  return unwrap(
    registerGrant(book, {
      grantId,
      authorizationId: AUTH_ID,
      amount,
      actorRef: 'bootstrap',
      createdAt: NOW,
    }),
  ).book;
}

/** Credit một grant pending — đường happy rút gọn. */
function creditedBook(book: FinancialBook, grantId: string): FinancialBook {
  return unwrap(creditGrant(book, { grantId, creditedAt: NOW + 1, fencingToken: IDS.ucFence }))
    .book;
}

/** Reverse một grant đã credit — đường happy rút gọn. */
function reversedBook(book: FinancialBook, grantId: string): FinancialBook {
  return unwrap(
    reverseGrant(book, {
      grantId,
      reversedAt: NOW + 2,
      fencingToken: IDS.ucFence,
      evidenceRef: 'clawback:dec-2026',
    }),
  ).book;
}

/** Balance hiện tại của wallet UC console. */
function ucBalances(book: FinancialBook) {
  return unwrap(locateWallet(book, IDS.ucWallet as never)).wallet.balances;
}

/** Book với authorization bị đổi trạng thái — dựng trực tiếp cho kịch bản revoke. */
function withAuthorizationStatus(book: FinancialBook, status: 'revoked'): FinancialBook {
  return Object.freeze({
    ...book,
    fundingAuthorizations: Object.freeze(
      book.fundingAuthorizations.map((candidate) =>
        candidate.authorization_id === AUTH_ID ? { ...candidate, status } : candidate,
      ),
    ),
  });
}

/** Book với sponsor bị đổi trạng thái — dựng trực tiếp cho kịch bản suspend. */
function withSponsorStatus(book: FinancialBook, status: 'suspended'): FinancialBook {
  return Object.freeze({
    ...book,
    sponsors: Object.freeze(
      book.sponsors.map((candidate) =>
        candidate.sponsor_id === SPONSOR_ID ? { ...candidate, status } : candidate,
      ),
    ),
  });
}

describe('registerSponsor', () => {
  it('seeds an active sponsor without posting any ledger entry', () => {
    const { book } = createTestBook({ ucAmount: 0n });
    const transactionsBefore = book.ledger.transactions.length;
    const outcome = unwrap(
      registerSponsor(book, {
        sponsorId: SPONSOR_ID,
        ownerRef: OWNER_REF,
        ceiling: uc(1_000_000n),
        createdAt: NOW,
        createdBy: 'bootstrap',
      }),
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.sponsor.status).toBe('active');
    expect(isSponsor(outcome.sponsor)).toBe(true);
    expect(outcome.book.ledger.transactions).toHaveLength(transactionsBefore);
  });

  it('replays the same payload and rejects a divergent ceiling for the same id', () => {
    const { book } = createTestBook({ ucAmount: 0n });
    const input = {
      sponsorId: SPONSOR_ID,
      ownerRef: OWNER_REF,
      ceiling: uc(1_000_000n),
      createdAt: NOW,
      createdBy: 'bootstrap',
    };
    const first = unwrap(registerSponsor(book, input));
    const replay = unwrap(registerSponsor(first.book, input));
    expect(replay.replayed).toBe(true);
    expect(replay.sponsor).toBe(first.sponsor);
    expect(failureCode(registerSponsor(first.book, { ...input, ceiling: uc(2_000_000n) }))).toBe(
      'idempotency_conflict',
    );
  });
});

describe('authorizeFunding', () => {
  it('refuses an authorization for a sponsor that is not an active registered sponsor', () => {
    const { book } = createTestBook({ ucAmount: 0n });
    expect(
      failureCode(
        authorizeFunding(book, {
          authorizationId: AUTH_ID,
          sponsorId: 'sponsor-someone-else',
          billingAccountId: IDS.consoleAccount,
          ceiling: uc(500_000n),
          evidenceRef: EVIDENCE_REF,
          createdAt: NOW,
          createdBy: 'bootstrap',
        }),
      ),
    ).toBe('funding_authorization_required');
    expect(
      failureCode(
        authorizeFunding(withSponsorStatus(seededBook(), 'suspended'), {
          authorizationId: 'auth-other',
          sponsorId: SPONSOR_ID,
          billingAccountId: IDS.consoleAccount,
          ceiling: uc(500_000n),
          evidenceRef: EVIDENCE_REF,
          createdAt: NOW,
          createdBy: 'bootstrap',
        }),
      ),
    ).toBe('funding_authorization_required');
  });

  it('is idempotent on the natural key and rejects a divergent replay', () => {
    const book = seededBook();
    const input = {
      authorizationId: AUTH_ID,
      sponsorId: SPONSOR_ID,
      billingAccountId: IDS.consoleAccount,
      ceiling: uc(500_000n),
      evidenceRef: EVIDENCE_REF,
      createdAt: NOW,
      createdBy: 'bootstrap',
    };
    const replay = unwrap(authorizeFunding(book, input));
    expect(replay.replayed).toBe(true);
    expect(isSponsorFundingAuthorization(replay.authorization)).toBe(true);
    // Natural key (sponsor, account) đã bị chiếm: authorization khác id cho cùng
    // cặp, hoặc cùng id với ceiling/evidence khác, đều là conflict.
    expect(failureCode(authorizeFunding(book, { ...input, authorizationId: 'auth-second' }))).toBe(
      'idempotency_conflict',
    );
    expect(failureCode(authorizeFunding(book, { ...input, ceiling: uc(900_000n) }))).toBe(
      'idempotency_conflict',
    );
    expect(failureCode(authorizeFunding(book, { ...input, evidenceRef: 'other-decision' }))).toBe(
      'idempotency_conflict',
    );
  });
});

describe('registerGrant', () => {
  it('records a pending grant carrying authorization provenance without posting', () => {
    const book = seededBook();
    const transactionsBefore = book.ledger.transactions.length;
    const outcome = unwrap(
      registerGrant(book, {
        grantId: 'grant-1',
        authorizationId: AUTH_ID,
        amount: uc(100n),
        actorRef: 'bootstrap',
        createdAt: NOW,
      }),
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.grant.state).toBe('pending');
    expect(isSponsorGrant(outcome.grant)).toBe(true);
    // Provenance suy từ authorization, bất biến trong record grant.
    expect(outcome.grant.sponsor_id).toBe(SPONSOR_ID);
    expect(outcome.grant.billing_account_id).toBe(IDS.consoleAccount);
    expect(outcome.book.ledger.transactions).toHaveLength(transactionsBefore);
    expect(ucBalances(outcome.book).total.minor).toBe(0n);
  });

  it('refuses a grant when the funding authorization is missing or revoked', () => {
    const book = seededBook();
    expect(
      failureCode(
        registerGrant(book, {
          grantId: 'grant-unknown-auth',
          authorizationId: 'auth-does-not-exist',
          amount: uc(100n),
          actorRef: 'bootstrap',
          createdAt: NOW,
        }),
      ),
    ).toBe('funding_authorization_required');
    expect(
      failureCode(
        registerGrant(withAuthorizationStatus(book, 'revoked'), {
          grantId: 'grant-revoked-auth',
          authorizationId: AUTH_ID,
          amount: uc(100n),
          actorRef: 'bootstrap',
          createdAt: NOW,
        }),
      ),
    ).toBe('funding_authorization_required');
  });

  it('refuses a grant when the sponsor is suspended', () => {
    expect(
      failureCode(
        registerGrant(withSponsorStatus(seededBook(), 'suspended'), {
          grantId: 'grant-suspended-sponsor',
          authorizationId: AUTH_ID,
          amount: uc(100n),
          actorRef: 'bootstrap',
          createdAt: NOW,
        }),
      ),
    ).toBe('funding_authorization_required');
  });

  it('replays the same grant and rejects a different amount under the same id', () => {
    const book = seededBook();
    const input = {
      grantId: 'grant-1',
      authorizationId: AUTH_ID,
      amount: uc(100n),
      actorRef: 'bootstrap',
      createdAt: NOW,
    };
    const first = unwrap(registerGrant(book, input));
    const replay = unwrap(registerGrant(first.book, input));
    expect(replay.replayed).toBe(true);
    expect(failureCode(registerGrant(first.book, { ...input, amount: uc(101n) }))).toBe(
      'idempotency_conflict',
    );
  });
});

describe('creditGrant', () => {
  it('credits the wallet from sponsor_funding_clearing and conserves the escrow', () => {
    const book = creditedBook(pendingGrant(seededBook(), 'grant-1'), 'grant-1');
    const grant = unwrap(findGrant(book, 'grant-1'));
    expect(grant.state).toBe('credited');

    // Wallet UC tăng đúng amount trên cả available lẫn total.
    const balances = ucBalances(book);
    expect(balances.available.minor).toBe(100n);
    expect(balances.total.minor).toBe(100n);

    // Transaction tất định: id và reference trỏ đúng grant.
    const transaction = book.ledger.transactions.find(
      (candidate) => candidate.transaction_id === 'sponsor_grant:grant-1:credit',
    );
    expect(transaction).toBeDefined();
    expect(transaction?.reference).toEqual({ type: 'sponsor_grant', id: 'grant-1' });
    // Hai leg: credit vào sponsor_funding_clearing, debit vào wallet_available.
    expect(transaction?.entries.map((entry) => entry.account)).toEqual([
      'sponsor_funding_clearing',
      'wallet_available',
    ]);

    // Conservation: tổng debit − credit trên toàn ledger vẫn cân bằng (double
    // entry), và net credited của sponsor + authorization nhìn thấy amount.
    const ledgerSum = book.ledger.transactions.flatMap((candidate) => candidate.entries);
    expect(
      ledgerSum.reduce(
        (total, entry) =>
          total + (entry.direction === 'debit' ? entry.amount.minor : -entry.amount.minor),
        0n,
      ),
    ).toBe(0n);
    expect(sponsorNetCredited(book, SPONSOR_ID)).toBe(100n);
    expect(authorizationNetCredited(book, AUTH_ID, 'UC')).toBe(100n);
  });

  it('rejects a sponsor ceiling breach without any partial posting', () => {
    const book = pendingGrant(
      seededBook({ sponsorCeiling: uc(150n), authorizationCeiling: uc(500_000n) }),
      'grant-1',
      uc(200n),
    );
    const transactionsBefore = book.ledger.transactions.length;
    const result = creditGrant(book, {
      grantId: 'grant-1',
      creditedAt: NOW + 1,
      fencingToken: IDS.ucFence,
    });
    expect(failureCode(result)).toBe('sponsor_ceiling_exceeded');
    // Không posting riêng phần nào: ledger, grant, wallet giữ nguyên.
    const untouched = unwrap(findGrant(book, 'grant-1'));
    expect(untouched.state).toBe('pending');
    expect(book.ledger.transactions).toHaveLength(transactionsBefore);
    expect(ucBalances(book).total.minor).toBe(0n);
  });

  it('rejects an authorization ceiling breach without any partial posting', () => {
    const book = pendingGrant(
      seededBook({ sponsorCeiling: uc(500_000n), authorizationCeiling: uc(150n) }),
      'grant-1',
      uc(200n),
    );
    const transactionsBefore = book.ledger.transactions.length;
    const result = creditGrant(book, {
      grantId: 'grant-1',
      creditedAt: NOW + 1,
      fencingToken: IDS.ucFence,
    });
    expect(failureCode(result)).toBe('authorization_ceiling_exceeded');
    const untouched = unwrap(findGrant(book, 'grant-1'));
    expect(untouched.state).toBe('pending');
    expect(book.ledger.transactions).toHaveLength(transactionsBefore);
    expect(ucBalances(book).total.minor).toBe(0n);
  });

  it('allows a credit when the authorization carries no per-account ceiling', () => {
    const book = creditedBook(
      pendingGrant(seededBook({ authorizationCeiling: null }), 'grant-1'),
      'grant-1',
    );
    expect(unwrap(findGrant(book, 'grant-1')).state).toBe('credited');
    expect(ucBalances(book).available.minor).toBe(100n);
  });

  it('measures the sponsor ceiling against cumulative net credited', () => {
    // Hai grant liên tiếp vượt trần sponsor 150 dù từng grant lẻ đều dưới trần.
    const narrow = seededBook({ sponsorCeiling: uc(150n), authorizationCeiling: uc(500_000n) });
    const first = creditedBook(pendingGrant(narrow, 'grant-a', uc(100n)), 'grant-a');
    expect(
      failureCode(
        creditGrant(pendingGrant(first, 'grant-b', uc(60n)), {
          grantId: 'grant-b',
          creditedAt: NOW + 1,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('sponsor_ceiling_exceeded');
    // Reverse giải phóng ngân sách: net về 0, grant mới 150 vừa khít trần.
    const freed = reversedBook(first, 'grant-a');
    expect(sponsorNetCredited(freed, SPONSOR_ID)).toBe(0n);
    const second = creditedBook(pendingGrant(freed, 'grant-c', uc(150n)), 'grant-c');
    expect(unwrap(findGrant(second, 'grant-c')).state).toBe('credited');
    expect(sponsorNetCredited(second, SPONSOR_ID)).toBe(150n);
  });

  it('measures the authorization ceiling against cumulative net credited', () => {
    const narrow = seededBook({ sponsorCeiling: uc(500_000n), authorizationCeiling: uc(150n) });
    const first = creditedBook(pendingGrant(narrow, 'grant-a', uc(100n)), 'grant-a');
    expect(
      failureCode(
        creditGrant(pendingGrant(first, 'grant-b', uc(60n)), {
          grantId: 'grant-b',
          creditedAt: NOW + 1,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('authorization_ceiling_exceeded');
    // Reverse trên cùng authorization giải phóng trần per-account.
    const freed = reversedBook(first, 'grant-a');
    const second = creditedBook(pendingGrant(freed, 'grant-c', uc(150n)), 'grant-c');
    expect(unwrap(findGrant(second, 'grant-c')).state).toBe('credited');
    expect(authorizationNetCredited(second, AUTH_ID, 'UC')).toBe(150n);
    expect(
      failureCode(
        creditGrant(pendingGrant(second, 'grant-d', uc(1n)), {
          grantId: 'grant-d',
          creditedAt: NOW + 1,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('authorization_ceiling_exceeded');
  });

  it('replays a credited grant without a second posting', () => {
    const book = creditedBook(pendingGrant(seededBook(), 'grant-1'), 'grant-1');
    const transactionsBefore = book.ledger.transactions.length;
    const replay = unwrap(
      creditGrant(book, { grantId: 'grant-1', creditedAt: NOW + 5, fencingToken: IDS.ucFence }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.grant.state).toBe('credited');
    expect(replay.book.ledger.transactions).toHaveLength(transactionsBefore);
    expect(ucBalances(replay.book).available.minor).toBe(100n);
  });

  it('refuses a credit whose denomination differs from the sponsor ceiling', () => {
    // Grant EC trên authorization có trần UC: lệch miền bị chặn trước khi tìm
    // wallet, nên lỗi phản đúng nguyên nhân thay vì wallet_not_found.
    const book = seededBook();
    const ecGrant = unwrap(
      registerGrant(book, {
        grantId: 'grant-ec',
        authorizationId: AUTH_ID,
        amount: { denomination: 'EC', minor: 50n },
        actorRef: 'bootstrap',
        createdAt: NOW,
      }),
    ).book;
    expect(
      failureCode(
        creditGrant(ecGrant, {
          grantId: 'grant-ec',
          creditedAt: NOW + 1,
          fencingToken: IDS.ecFence,
        }),
      ),
    ).toBe('denomination_mismatch');
  });

  it('refuses a credit on a revoked authorization', () => {
    const book = withAuthorizationStatus(pendingGrant(seededBook(), 'grant-1'), 'revoked');
    expect(
      failureCode(
        creditGrant(book, { grantId: 'grant-1', creditedAt: NOW + 1, fencingToken: IDS.ucFence }),
      ),
    ).toBe('funding_authorization_required');
  });

  it('refuses a credit on a reversed grant', () => {
    const book = reversedBook(
      creditedBook(pendingGrant(seededBook(), 'grant-1'), 'grant-1'),
      'grant-1',
    );
    expect(
      failureCode(
        creditGrant(book, { grantId: 'grant-1', creditedAt: NOW + 3, fencingToken: IDS.ucFence }),
      ),
    ).toBe('invalid_grant_transition');
  });
});

describe('reverseGrant', () => {
  it('reverses the full granted amount from available exactly once', () => {
    const credited = creditedBook(pendingGrant(seededBook(), 'grant-1'), 'grant-1');
    const reversed = reversedBook(credited, 'grant-1');
    const grant = unwrap(findGrant(reversed, 'grant-1'));
    expect(grant.state).toBe('reversed');
    expect(ucBalances(reversed).available.minor).toBe(0n);
    expect(ucBalances(reversed).total.minor).toBe(0n);
    expect(sponsorNetCredited(reversed, SPONSOR_ID)).toBe(0n);

    // Transaction reverse tất định, reference riêng cho clawback.
    const transaction = reversed.ledger.transactions.find(
      (candidate) => candidate.transaction_id === 'sponsor_grant:grant-1:reverse',
    );
    expect(transaction).toBeDefined();
    expect(transaction?.reference).toEqual({ type: 'sponsor_grant_reversal', id: 'grant-1' });

    // Replay trả kết quả gốc — không double-reverse.
    const transactionsBefore = reversed.ledger.transactions.length;
    const replay = unwrap(
      reverseGrant(reversed, {
        grantId: 'grant-1',
        reversedAt: NOW + 9,
        fencingToken: IDS.ucFence,
        evidenceRef: 'clawback:dec-2026',
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.grant.state).toBe('reversed');
    expect(replay.book.ledger.transactions).toHaveLength(transactionsBefore);
  });

  it('refuses to claw back past available when part of the grant was already spent', () => {
    const book = creditedBook(pendingGrant(seededBook(), 'grant-1', uc(100n)), 'grant-1');
    // Tiêu 40 UC qua đúng đường reservation → capture một phần kèm release
    // remainder; available còn 60 < 100 nên reverse bị từ chối.
    const reserved = unwrap(
      reserve(book, {
        reservationId: 'rsv-1',
        walletId: IDS.ucWallet,
        billingAccountId: IDS.consoleAccount,
        amount: uc(40n),
        createdAt: NOW + 3,
        fencingToken: IDS.ucFence,
      }),
    ).book;
    const spent = unwrap(
      capture(reserved, {
        reservationId: 'rsv-1',
        amount: uc(40n),
        releaseRemainder: true,
        capturedAt: NOW + 4,
        fencingToken: IDS.ucFence,
      }),
    ).book;
    expect(ucBalances(spent).available.minor).toBe(60n);
    expect(ucBalances(spent).charged.minor).toBe(40n);

    const transactionsBefore = spent.ledger.transactions.length;
    const result = reverseGrant(spent, {
      grantId: 'grant-1',
      reversedAt: NOW + 5,
      fencingToken: IDS.ucFence,
      evidenceRef: 'clawback:dec-2026',
    });
    expect(failureCode(result)).toBe('insufficient_available_balance');
    // Từ chối phải để nguyên state: grant vẫn credited, ledger không thêm dòng,
    // không ép số dư âm.
    expect(unwrap(findGrant(spent, 'grant-1')).state).toBe('credited');
    expect(spent.ledger.transactions).toHaveLength(transactionsBefore);
    expect(ucBalances(spent).available.minor).toBe(60n);
  });

  it('refuses to reverse a grant that was never credited', () => {
    const book = pendingGrant(seededBook(), 'grant-1');
    expect(
      failureCode(
        reverseGrant(book, {
          grantId: 'grant-1',
          reversedAt: NOW + 1,
          fencingToken: IDS.ucFence,
          evidenceRef: 'clawback:dec-2026',
        }),
      ),
    ).toBe('invalid_grant_transition');
  });
});

describe('sponsor funding vocabulary', () => {
  it('rejects an unknown account when crediting a grant', () => {
    // Grant trỏ tới account không tồn tại: fail-closed, không wallet fallback.
    const book = seededBook();
    const registered = unwrap(
      registerGrant(book, {
        grantId: 'grant-ghost-account',
        authorizationId: AUTH_ID,
        amount: uc(100n),
        actorRef: 'bootstrap',
        createdAt: NOW,
      }),
    ).book;
    const ghost = Object.freeze({
      ...registered,
      grants: Object.freeze(
        registered.grants.map((candidate) =>
          candidate.grant_id === 'grant-ghost-account'
            ? { ...candidate, billing_account_id: 'acct-ghost' }
            : candidate,
        ),
      ),
    });
    expect(
      failureCode(
        creditGrant(ghost, {
          grantId: 'grant-ghost-account',
          creditedAt: NOW + 1,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('invalid_wallet');
  });

  it('keeps sponsor records valid under the structural type guards', () => {
    const book = creditedBook(pendingGrant(seededBook(), 'grant-1'), 'grant-1');
    expect(book.sponsors.every(isSponsor)).toBe(true);
    expect(book.fundingAuthorizations.every(isSponsorFundingAuthorization)).toBe(true);
    expect(book.grants.every(isSponsorGrant)).toBe(true);
  });

  it('seeds a sponsor onto a fresh billing account end to end', () => {
    // Đường B1→B4 hoàn chỉnh trên account mới tạo — không phụ thuộc fixture
    // account console: đúng kịch bản bootstrap đọc trong integration test.
    const { book } = createTestBook({ ucAmount: 0n });
    const account = Object.freeze({
      ...unwrap(
        createBillingAccount({
          billingAccountId: 'acct-consumer-ecoma',
          ownerRef: 'owner-consumer-ecoma',
          createdAt: NOW,
        }),
      ),
      wallets: Object.freeze([
        unwrap(
          createWallet({
            walletId: 'wallet-consumer-uc',
            billingAccountId: 'acct-consumer-ecoma',
            denomination: 'UC',
            fencingToken: 'fence-consumer-uc-1',
          }),
        ),
      ]),
    });
    const withAccount = unwrap(addBillingAccount(book, account));
    const withSponsor = unwrap(
      registerSponsor(withAccount, {
        sponsorId: SPONSOR_ID,
        ownerRef: OWNER_REF,
        ceiling: uc(10_000n),
        createdAt: NOW,
        createdBy: 'bootstrap',
      }),
    ).book;
    const withAuth = unwrap(
      authorizeFunding(withSponsor, {
        authorizationId: AUTH_ID,
        sponsorId: SPONSOR_ID,
        billingAccountId: 'acct-consumer-ecoma',
        ceiling: uc(5_000n),
        evidenceRef: EVIDENCE_REF,
        createdAt: NOW,
        createdBy: 'bootstrap',
      }),
    ).book;
    const registered = unwrap(
      registerGrant(withAuth, {
        grantId: 'grant-first',
        authorizationId: AUTH_ID,
        amount: uc(2_500n),
        actorRef: 'bootstrap',
        createdAt: NOW,
      }),
    ).book;
    const funded = unwrap(
      creditGrant(registered, {
        grantId: 'grant-first',
        creditedAt: NOW + 1,
        fencingToken: 'fence-consumer-uc-1',
      }),
    ).book;
    const balances = unwrap(locateWallet(funded, 'wallet-consumer-uc' as never)).wallet.balances;
    expect(balances.available.minor).toBe(2_500n);
    expect(balances.total.minor).toBe(2_500n);
    expect(sponsorNetCredited(funded, SPONSOR_ID)).toBe(2_500n);
  });
});
