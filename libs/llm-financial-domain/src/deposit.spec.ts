/**
 * Ghim deposit/credit: bất biến 5 (conservation) và 7 (append-only), cùng quy
 * tắc "chỉ deposit mới làm tăng total".
 */

import { describe, expect, it } from 'vitest';

import { locateWallet } from './book';
import { creditDeposit, findDeposit, registerDeposit, reverseDeposit } from './deposit';
import { reserve } from './reservation';
import { createTestBook, failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';

/** Balance hiện tại của một wallet trong book. */
function balances(book: ReturnType<typeof createTestBook>['book'], walletId: string) {
  return unwrap(locateWallet(book, walletId as never)).wallet.balances;
}

describe('registerDeposit', () => {
  it('records a pending deposit without posting any ledger entry', () => {
    const { book } = createTestBook({ ucAmount: 0n });
    const outcome = unwrap(
      registerDeposit(book, {
        depositId: 'dep-new',
        walletId: IDS.ucWallet,
        amount: uc(500n),
        paymentReference: 'pay-ref-1',
        createdAt: NOW,
      }),
    );
    expect(outcome.deposit.state).toBe('pending');
    expect(outcome.book.ledger.transactions).toHaveLength(book.ledger.transactions.length);
    expect(balances(outcome.book, IDS.ucWallet).total.minor).toBe(0n);
  });

  it('is idempotent and rejects a conflicting replay', () => {
    const { book } = createTestBook({ ucAmount: 0n });
    const first = unwrap(
      registerDeposit(book, {
        depositId: 'dep-new',
        walletId: IDS.ucWallet,
        amount: uc(500n),
        paymentReference: 'pay-ref-1',
        createdAt: NOW,
      }),
    );
    const replay = unwrap(
      registerDeposit(first.book, {
        depositId: 'dep-new',
        walletId: IDS.ucWallet,
        amount: uc(500n),
        paymentReference: 'pay-ref-1',
        createdAt: NOW,
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(
      failureCode(
        registerDeposit(first.book, {
          depositId: 'dep-new',
          walletId: IDS.ucWallet,
          amount: uc(501n),
          paymentReference: 'pay-ref-1',
          createdAt: NOW,
        }),
      ),
    ).toBe('idempotency_conflict');
  });

  it('rejects a grant that does not match the wallet denomination', () => {
    const { book } = createTestBook({ ucAmount: 0n });
    expect(
      failureCode(
        registerDeposit(book, {
          depositId: 'dep-ec-into-uc',
          walletId: IDS.ucWallet,
          amount: { denomination: 'EC', minor: 1n },
          paymentReference: 'pay-ref-2',
          createdAt: NOW,
        }),
      ),
    ).toBe('denomination_mismatch');
  });
});

describe('creditDeposit', () => {
  it('is the only operation that raises total', () => {
    const { book } = createTestBook({ ucAmount: 0n });
    const registered = unwrap(
      registerDeposit(book, {
        depositId: 'dep-new',
        walletId: IDS.ucWallet,
        amount: uc(500n),
        paymentReference: 'pay-ref-1',
        createdAt: NOW,
      }),
    );
    const credited = unwrap(
      creditDeposit(registered.book, {
        depositId: 'dep-new',
        creditedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(credited.deposit.state).toBe('credited');
    expect(balances(credited.book, IDS.ucWallet).total.minor).toBe(500n);
    expect(balances(credited.book, IDS.ucWallet).available.minor).toBe(500n);
  });

  it('replays a credited deposit without a second posting', () => {
    const { book } = createTestBook();
    const credited = unwrap(
      creditDeposit(book, { depositId: 'dep-uc', creditedAt: NOW + 1, fencingToken: IDS.ucFence }),
    );
    expect(credited.replayed).toBe(true);
    expect(credited.book.ledger.transactions).toHaveLength(book.ledger.transactions.length);
  });

  it('rejects crediting an unknown deposit', () => {
    const { book } = createTestBook();
    expect(
      failureCode(
        creditDeposit(book, { depositId: 'missing', creditedAt: NOW, fencingToken: IDS.ucFence }),
      ),
    ).toBe('deposit_not_found');
  });

  it('rejects crediting with a stale fencing token', () => {
    const { book } = createTestBook({ ucAmount: 0n });
    const registered = unwrap(
      registerDeposit(book, {
        depositId: 'dep-new',
        walletId: IDS.ucWallet,
        amount: uc(1n),
        paymentReference: 'pay-ref-1',
        createdAt: NOW,
      }),
    );
    expect(
      failureCode(
        creditDeposit(registered.book, {
          depositId: 'dep-new',
          creditedAt: NOW + 1,
          fencingToken: 'fence-old',
        }),
      ),
    ).toBe('stale_fencing_token');
  });
});

describe('reverseDeposit', () => {
  it('posts a compensating entry and keeps total consistent with the ledger', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const reversed = unwrap(
      reverseDeposit(book, {
        depositId: 'dep-uc',
        reversedAt: NOW + 2,
        fencingToken: IDS.ucFence,
        evidenceRef: 'evidence-1',
      }),
    );
    expect(reversed.deposit.state).toBe('reversed');
    const next = balances(reversed.book, IDS.ucWallet);
    expect(next.available.minor).toBe(0n);
    expect(next.total.minor).toBe(0n);
  });

  it('rejects reversing a deposit whose money is already held or charged', () => {
    const { book } = createTestBook({ ucAmount: 100n });
    // Giữ toàn bộ available để reverse không còn đủ tiền đối ứng.
    const reserved = unwrap(
      reserve(book, {
        reservationId: 'rsv-1',
        walletId: IDS.ucWallet,
        billingAccountId: IDS.consoleAccount,
        amount: uc(100n),
        createdAt: NOW,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(
      failureCode(
        reverseDeposit(reserved.book, {
          depositId: 'dep-uc',
          reversedAt: NOW + 2,
          fencingToken: IDS.ucFence,
          evidenceRef: 'evidence-1',
        }),
      ),
    ).toBe('insufficient_available_balance');
  });

  it('rejects reversing a pending deposit', () => {
    const { book } = createTestBook({ ucAmount: 0n });
    const registered = unwrap(
      registerDeposit(book, {
        depositId: 'dep-new',
        walletId: IDS.ucWallet,
        amount: uc(10n),
        paymentReference: 'pay-ref-1',
        createdAt: NOW,
      }),
    );
    expect(
      failureCode(
        reverseDeposit(registered.book, {
          depositId: 'dep-new',
          reversedAt: NOW + 1,
          fencingToken: IDS.ucFence,
          evidenceRef: 'evidence-1',
        }),
      ),
    ).toBe('invalid_deposit_transition');
  });

  it('replays a reversed deposit without a second posting', () => {
    const { book } = createTestBook({ ucAmount: 100n });
    const first = unwrap(
      reverseDeposit(book, {
        depositId: 'dep-uc',
        reversedAt: NOW + 2,
        fencingToken: IDS.ucFence,
        evidenceRef: 'evidence-1',
      }),
    );
    const replay = unwrap(
      reverseDeposit(first.book, {
        depositId: 'dep-uc',
        reversedAt: NOW + 2,
        fencingToken: IDS.ucFence,
        evidenceRef: 'evidence-1',
      }),
    );
    expect(replay.replayed).toBe(true);
  });

  it('keeps the deposit record addressable after reversal', () => {
    const { book } = createTestBook({ ucAmount: 100n });
    const reversed = unwrap(
      reverseDeposit(book, {
        depositId: 'dep-uc',
        reversedAt: NOW + 2,
        fencingToken: IDS.ucFence,
        evidenceRef: 'evidence-1',
      }),
    );
    expect(unwrap(findDeposit(reversed.book, 'dep-uc')).state).toBe('reversed');
  });
});
