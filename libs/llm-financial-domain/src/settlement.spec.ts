/**
 * Ghim settlement: bất biến 4 (settlement idempotency), 5 (conservation),
 * settlement ≠ reservation và settlement ≠ provider cost.
 */

import { describe, expect, it } from 'vitest';

import { locateWallet } from './book';
import { reserve } from './reservation';
import { settle } from './settlement';
import { currentPayable } from './payable';
import { createTestBook, ec, failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';

/** Reserve một khoản trên UC wallet. */
function reserved(book: ReturnType<typeof createTestBook>['book'], amount: bigint) {
  return unwrap(
    reserve(book, {
      reservationId: 'rsv-1',
      walletId: IDS.ucWallet,
      billingAccountId: IDS.consoleAccount,
      amount: uc(amount),
      createdAt: NOW,
      fencingToken: IDS.ucFence,
    }),
  ).book;
}

/** Settle reservation `rsv-1` thành charge `chg-1`. */
function settleOnce(
  book: ReturnType<typeof createTestBook>['book'],
  chargeAmount: bigint,
  options?: {
    settlementId?: string;
    chargeId?: string;
    seller?: Parameters<typeof settle>[1]['seller'];
  },
) {
  return settle(book, {
    settlementId: options?.settlementId ?? 'stl-1',
    reservationId: 'rsv-1',
    chargeId: options?.chargeId ?? 'chg-1',
    chargeAmount: uc(chargeAmount),
    settledAt: NOW + 10,
    fencingToken: IDS.ucFence,
    seller: options?.seller ?? null,
  });
}

/** Balance hiện tại của một wallet trong book. */
function balances(book: ReturnType<typeof createTestBook>['book'], walletId: string) {
  return unwrap(locateWallet(book, walletId as never)).wallet.balances;
}

describe('settle', () => {
  it('turns a reservation into a posted charge and conserves total', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const outcome = unwrap(settleOnce(reserved(book, 400n), 400n));
    const next = balances(outcome.book, IDS.ucWallet);
    expect(next.available.minor).toBe(600n);
    expect(next.held.minor).toBe(0n);
    expect(next.charged.minor).toBe(400n);
    expect(next.total.minor).toBe(1_000n);
    expect(outcome.charge.state).toBe('posted');
    expect(outcome.charge.settlement_id).toBe('stl-1');
    expect(outcome.charge.reservation_id).toBe('rsv-1');
  });

  it('charges less than reserved and releases the difference explicitly', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const outcome = unwrap(settleOnce(reserved(book, 400n), 250n));
    const next = balances(outcome.book, IDS.ucWallet);
    expect(next.available.minor).toBe(750n);
    expect(next.charged.minor).toBe(250n);
    expect(next.held.minor).toBe(0n);
  });

  it('is idempotent by settlement id and returns the original charge', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const first = unwrap(settleOnce(reserved(book, 400n), 400n));
    const replay = unwrap(settleOnce(first.book, 400n));
    expect(replay.replayed).toBe(true);
    expect(replay.charge.charge_id).toBe(first.charge.charge_id);
    expect(replay.book.ledger.transactions).toHaveLength(first.book.ledger.transactions.length);
  });

  it('rejects a replay whose seller share differs from the recorded accrual', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const seller = {
      sellerTenant: 'tenant-seller',
      payableId: 'pay-1',
      period: '2026-11',
      availableAt: NOW + 100,
      amount: ec(40n),
    } as const;
    const first = unwrap(settleOnce(reserved(book, 400n), 400n, { seller }));
    expect(unwrap(settleOnce(first.book, 400n, { seller })).replayed).toBe(true);
    // Cùng settlement id nhưng split khác: không phải lần gọi lặp của cùng quyết định.
    expect(
      failureCode(settleOnce(first.book, 400n, { seller: { ...seller, amount: ec(39n) } })),
    ).toBe('idempotency_conflict');
    expect(failureCode(settleOnce(first.book, 400n))).toBe('idempotency_conflict');
  });

  it('rejects a replayed settlement id with a different charge amount', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const first = unwrap(settleOnce(reserved(book, 400n), 400n));
    expect(failureCode(settleOnce(first.book, 399n))).toBe('idempotency_conflict');
  });

  it('rejects a second distinct settlement of the same reservation — no duplicate charge', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const first = unwrap(settleOnce(reserved(book, 400n), 400n));
    expect(
      failureCode(
        settle(first.book, {
          settlementId: 'stl-2',
          reservationId: 'rsv-1',
          chargeId: 'chg-2',
          chargeAmount: uc(400n),
          settledAt: NOW + 11,
          fencingToken: IDS.ucFence,
          seller: null,
        }),
      ),
    ).toBe('reservation_already_finalized');
  });

  it('rejects an unknown reservation, a zero amount and a mismatched denomination', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    expect(failureCode(settleOnce(book, 400n))).toBe('reservation_not_found');
    const held = reserved(book, 400n);
    expect(failureCode(settleOnce(held, 0n))).toBe('invalid_settlement');
    expect(
      failureCode(
        settle(held, {
          settlementId: 'stl-x',
          reservationId: 'rsv-1',
          chargeId: 'chg-x',
          chargeAmount: { denomination: 'EC', minor: 1n },
          settledAt: NOW + 10,
          fencingToken: IDS.ucFence,
          seller: null,
        }),
      ),
    ).toBe('denomination_mismatch');
  });

  it('rejects a charge amount larger than the reserved amount', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    expect(failureCode(settleOnce(reserved(book, 100n), 101n))).toBe('insufficient_held_balance');
  });

  it('accrues a seller payable when the caller supplies a seller share', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const outcome = unwrap(
      settleOnce(reserved(book, 400n), 400n, {
        seller: {
          sellerTenant: 'tenant-seller',
          payableId: 'pay-1',
          period: '2026-10',
          availableAt: NOW + 30 * 86_400_000,
          amount: ec(280n),
        },
      }),
    );
    const payable = unwrap(currentPayable(outcome.book, 'pay-1' as never));
    expect(payable.state).toBe('accrued');
    expect(payable.amount.minor).toBe(280n);
    expect(payable.seller_tenant).toBe('tenant-seller');
    // Payable là projection EC, không phải balance của wallet UC.
    expect(outcome.book.payables).toHaveLength(1);
  });

  it('does not move the customer charge out of the wallet total', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const outcome = unwrap(settleOnce(reserved(book, 400n), 400n));
    const next = balances(outcome.book, IDS.ucWallet);
    expect(next.available.minor + next.held.minor + next.charged.minor).toBe(next.total.minor);
  });
});
