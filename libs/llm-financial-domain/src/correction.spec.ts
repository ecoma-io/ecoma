/**
 * Ghim refund/adjustment: bất biến 7 (append-only), refund không sửa entry cũ,
 * adjustment là transition chứ không phải mutation, và conservation 5.
 */

import { describe, expect, it } from 'vitest';

import { locateWallet } from './book';
import { reserve } from './reservation';
import { findCharge, settle } from './settlement';
import { adjustCharge, refundCharge } from './correction';
import { createTestBook, failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';

/** Dựng một book có charge `chg-1` trị giá 400. */
function withCharge(options?: { charged?: bigint; funded?: bigint }) {
  const { book } = createTestBook({ ucAmount: options?.funded ?? 1_000n });
  const held = unwrap(
    reserve(book, {
      reservationId: 'rsv-1',
      walletId: IDS.ucWallet,
      billingAccountId: IDS.consoleAccount,
      amount: uc(options?.charged ?? 400n),
      createdAt: NOW,
      fencingToken: IDS.ucFence,
    }),
  );
  const settled = unwrap(
    settle(held.book, {
      settlementId: 'stl-1',
      reservationId: 'rsv-1',
      chargeId: 'chg-1',
      chargeAmount: uc(options?.charged ?? 400n),
      settledAt: NOW + 10,
      fencingToken: IDS.ucFence,
      seller: null,
    }),
  );
  return settled;
}

/** Balance hiện tại của một wallet trong book. */
function balances(book: ReturnType<typeof createTestBook>['book'], walletId: string) {
  return unwrap(locateWallet(book, walletId as never)).wallet.balances;
}

describe('refundCharge', () => {
  it('returns charged money to available and conserves total', () => {
    const settled = withCharge();
    const refunded = unwrap(
      refundCharge(settled.book, {
        refundId: 'rfd-1',
        chargeId: 'chg-1',
        amount: uc(150n),
        reasonRef: 'reason-1',
        refundedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    const next = balances(refunded.book, IDS.ucWallet);
    expect(next.available.minor).toBe(750n);
    expect(next.charged.minor).toBe(250n);
    expect(next.total.minor).toBe(1_000n);
    expect(refunded.charge.refunded.minor).toBe(150n);
    // Charge gốc không bị sửa amount.
    expect(refunded.charge.amount.minor).toBe(400n);
  });

  it('never edits the prior ledger entry — it appends a new transaction', () => {
    const settled = withCharge();
    const before = settled.book.ledger.transactions.length;
    const refunded = unwrap(
      refundCharge(settled.book, {
        refundId: 'rfd-1',
        chargeId: 'chg-1',
        amount: uc(100n),
        reasonRef: null,
        refundedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(refunded.book.ledger.transactions).toHaveLength(before + 1);
    expect(refunded.book.ledger.transactions[0]).toEqual(settled.book.ledger.transactions[0]);
    expect(refunded.book.refunds).toHaveLength(1);
  });

  it('marks the charge fully refunded when the whole amount is returned', () => {
    const settled = withCharge();
    const refunded = unwrap(
      refundCharge(settled.book, {
        refundId: 'rfd-1',
        chargeId: 'chg-1',
        amount: uc(400n),
        reasonRef: null,
        refundedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(refunded.charge.state).toBe('refunded');
  });

  it('rejects a refund above the refundable amount', () => {
    const settled = withCharge();
    expect(
      failureCode(
        refundCharge(settled.book, {
          refundId: 'rfd-1',
          chargeId: 'chg-1',
          amount: uc(401n),
          reasonRef: null,
          refundedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('refund_exceeds_charge');
  });

  it('rejects accumulating refunds beyond the charge amount', () => {
    const settled = withCharge();
    const first = unwrap(
      refundCharge(settled.book, {
        refundId: 'rfd-1',
        chargeId: 'chg-1',
        amount: uc(300n),
        reasonRef: null,
        refundedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(
      failureCode(
        refundCharge(first.book, {
          refundId: 'rfd-2',
          chargeId: 'chg-1',
          amount: uc(101n),
          reasonRef: null,
          refundedAt: NOW + 21,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('refund_exceeds_charge');
  });

  it('is idempotent by refund id and rejects a conflicting replay', () => {
    const settled = withCharge();
    const first = unwrap(
      refundCharge(settled.book, {
        refundId: 'rfd-1',
        chargeId: 'chg-1',
        amount: uc(100n),
        reasonRef: null,
        refundedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    const replay = unwrap(
      refundCharge(first.book, {
        refundId: 'rfd-1',
        chargeId: 'chg-1',
        amount: uc(100n),
        reasonRef: null,
        refundedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(
      failureCode(
        refundCharge(first.book, {
          refundId: 'rfd-1',
          chargeId: 'chg-1',
          amount: uc(101n),
          reasonRef: null,
          refundedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('idempotency_conflict');
    // `reason_ref` là bằng chứng của lần hoàn tiền: cùng id nhưng lý do khác là
    // một quyết định khác, không phải replay.
    expect(
      failureCode(
        refundCharge(first.book, {
          refundId: 'rfd-1',
          chargeId: 'chg-1',
          amount: uc(100n),
          reasonRef: 'other-reason',
          refundedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('idempotency_conflict');
  });

  it('rejects an unknown charge, a zero amount and a denomination mismatch', () => {
    const settled = withCharge();
    expect(
      failureCode(
        refundCharge(settled.book, {
          refundId: 'rfd-1',
          chargeId: 'missing',
          amount: uc(1n),
          reasonRef: null,
          refundedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('charge_not_found');
    expect(
      failureCode(
        refundCharge(settled.book, {
          refundId: 'rfd-1',
          chargeId: 'chg-1',
          amount: uc(0n),
          reasonRef: null,
          refundedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('invalid_refund');
    expect(
      failureCode(
        refundCharge(settled.book, {
          refundId: 'rfd-1',
          chargeId: 'chg-1',
          amount: { denomination: 'EC', minor: 1n },
          reasonRef: null,
          refundedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('denomination_mismatch');
  });

  it('keeps the charge discoverable with its original settlement reference', () => {
    const settled = withCharge();
    const refunded = unwrap(
      refundCharge(settled.book, {
        refundId: 'rfd-1',
        chargeId: 'chg-1',
        amount: uc(100n),
        reasonRef: null,
        refundedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(unwrap(findCharge(refunded.book, 'chg-1' as never)).settlement_id).toBe('stl-1');
  });
});

describe('adjustCharge', () => {
  it('increases a charge by moving available into charged', () => {
    const settled = withCharge();
    const adjusted = unwrap(
      adjustCharge(settled.book, {
        adjustmentId: 'adj-1',
        chargeId: 'chg-1',
        direction: 'increase',
        amount: uc(50n),
        reasonRef: 'undercharge-1',
        adjustedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    const next = balances(adjusted.book, IDS.ucWallet);
    expect(next.available.minor).toBe(550n);
    expect(next.charged.minor).toBe(450n);
    expect(adjusted.charge.state).toBe('adjusted');
    expect(adjusted.charge.increase.minor).toBe(50n);
  });

  it('decreases a charge by moving charged back into available', () => {
    const settled = withCharge();
    const adjusted = unwrap(
      adjustCharge(settled.book, {
        adjustmentId: 'adj-1',
        chargeId: 'chg-1',
        direction: 'decrease',
        amount: uc(50n),
        reasonRef: 'overcharge-1',
        adjustedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    const next = balances(adjusted.book, IDS.ucWallet);
    expect(next.available.minor).toBe(650n);
    expect(next.charged.minor).toBe(350n);
  });

  it('rejects a decrease beyond the remaining charge', () => {
    const settled = withCharge();
    expect(
      failureCode(
        adjustCharge(settled.book, {
          adjustmentId: 'adj-1',
          chargeId: 'chg-1',
          direction: 'decrease',
          amount: uc(401n),
          reasonRef: 'overcharge-1',
          adjustedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('insufficient_charged_balance');
  });

  it('rejects an increase beyond available balance', () => {
    const settled = withCharge({ charged: 1_000n, funded: 1_000n });
    expect(
      failureCode(
        adjustCharge(settled.book, {
          adjustmentId: 'adj-1',
          chargeId: 'chg-1',
          direction: 'increase',
          amount: uc(1n),
          reasonRef: 'undercharge-1',
          adjustedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('insufficient_available_balance');
  });

  it('requires a reason reference', () => {
    const settled = withCharge();
    expect(
      failureCode(
        adjustCharge(settled.book, {
          adjustmentId: 'adj-1',
          chargeId: 'chg-1',
          direction: 'decrease',
          amount: uc(10n),
          reasonRef: '',
          adjustedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('invalid_adjustment');
  });

  it('is idempotent by adjustment id and rejects a conflicting replay', () => {
    const settled = withCharge();
    const first = unwrap(
      adjustCharge(settled.book, {
        adjustmentId: 'adj-1',
        chargeId: 'chg-1',
        direction: 'decrease',
        amount: uc(10n),
        reasonRef: 'overcharge-1',
        adjustedAt: NOW + 20,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(
      unwrap(
        adjustCharge(first.book, {
          adjustmentId: 'adj-1',
          chargeId: 'chg-1',
          direction: 'decrease',
          amount: uc(10n),
          reasonRef: 'overcharge-1',
          adjustedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ).replayed,
    ).toBe(true);
    expect(
      failureCode(
        adjustCharge(first.book, {
          adjustmentId: 'adj-1',
          chargeId: 'chg-1',
          direction: 'increase',
          amount: uc(10n),
          reasonRef: 'overcharge-1',
          adjustedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('idempotency_conflict');
    // `reason_ref` cũng thuộc payload: lý do khác là quyết định khác.
    expect(
      failureCode(
        adjustCharge(first.book, {
          adjustmentId: 'adj-1',
          chargeId: 'chg-1',
          direction: 'decrease',
          amount: uc(10n),
          reasonRef: 'other-reason',
          adjustedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('idempotency_conflict');
  });

  it('rejects zero amount and an unknown charge', () => {
    const settled = withCharge();
    expect(
      failureCode(
        adjustCharge(settled.book, {
          adjustmentId: 'adj-1',
          chargeId: 'chg-1',
          direction: 'decrease',
          amount: uc(0n),
          reasonRef: 'reason-1',
          adjustedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('invalid_adjustment');
    expect(
      failureCode(
        adjustCharge(settled.book, {
          adjustmentId: 'adj-1',
          chargeId: 'missing',
          direction: 'decrease',
          amount: uc(1n),
          reasonRef: 'reason-1',
          adjustedAt: NOW + 20,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('charge_not_found');
  });
});
