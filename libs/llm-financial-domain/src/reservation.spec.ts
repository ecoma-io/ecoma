/**
 * Ghim reservation: bất biến 3 (idempotency), 5 (conservation), 6 (không release
 * chỉ vì timeout) và 10 (reservation ≠ charge).
 */

import { describe, expect, it } from 'vitest';

import { locateWallet } from './book';
import { capture, findReservation, release, reserve } from './reservation';
import { createTestBook, failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';
import { deriveWalletBalances } from './ledger';

/** Reserve một khoản trên UC wallet của fixture. */
function reserveOn(book: ReturnType<typeof createTestBook>['book'], amount: bigint) {
  return unwrap(
    reserve(book, {
      reservationId: 'rsv-1',
      walletId: IDS.ucWallet,
      billingAccountId: IDS.consoleAccount,
      amount: uc(amount),
      createdAt: NOW,
      fencingToken: IDS.ucFence,
    }),
  );
}

/** Balance hiện tại của một wallet trong book. */
function balances(book: ReturnType<typeof createTestBook>['book'], walletId: string) {
  const wallet = unwrap(locateWallet(book, walletId as never)).wallet;
  return wallet.balances;
}

describe('reserve', () => {
  it('moves money from available to held and leaves total untouched', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const outcome = reserveOn(book, 400n);
    const next = balances(outcome.book, IDS.ucWallet);
    expect(next.available.minor).toBe(600n);
    expect(next.held.minor).toBe(400n);
    expect(next.charged.minor).toBe(0n);
    expect(next.total.minor).toBe(1_000n);
    expect(outcome.reservation.state).toBe('reserved');
  });

  it('is idempotent by reservation id and posts no second transaction', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const first = reserveOn(book, 400n);
    const second = unwrap(
      reserve(first.book, {
        reservationId: 'rsv-1',
        walletId: IDS.ucWallet,
        billingAccountId: IDS.consoleAccount,
        amount: uc(400n),
        createdAt: NOW,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(second.replayed).toBe(true);
    expect(second.book.ledger.transactions).toHaveLength(first.book.ledger.transactions.length);
  });

  it('rejects a replayed reservation id with a different amount', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const first = reserveOn(book, 400n);
    expect(
      failureCode(
        reserve(first.book, {
          reservationId: 'rsv-1',
          walletId: IDS.ucWallet,
          billingAccountId: IDS.consoleAccount,
          amount: uc(401n),
          createdAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('idempotency_conflict');
  });

  it('rejects over-reservation instead of allowing a negative available balance', () => {
    const { book } = createTestBook({ ucAmount: 100n });
    expect(
      failureCode(
        reserve(book, {
          reservationId: 'rsv-1',
          walletId: IDS.ucWallet,
          billingAccountId: IDS.consoleAccount,
          amount: uc(101n),
          createdAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('insufficient_available_balance');
  });

  it('accepts reserving the exact available balance', () => {
    const { book } = createTestBook({ ucAmount: 100n });
    const outcome = reserveOn(book, 100n);
    expect(balances(outcome.book, IDS.ucWallet).available.minor).toBe(0n);
  });

  it('rejects zero, mismatched denomination and unknown wallet', () => {
    const { book } = createTestBook();
    expect(
      failureCode(
        reserve(book, {
          reservationId: 'rsv-0',
          walletId: IDS.ucWallet,
          billingAccountId: IDS.consoleAccount,
          amount: uc(0),
          createdAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('invalid_amount');
    expect(
      failureCode(
        reserve(book, {
          reservationId: 'rsv-2',
          walletId: IDS.ucWallet,
          billingAccountId: IDS.consoleAccount,
          amount: { denomination: 'EC', minor: 1n },
          createdAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('denomination_mismatch');
    expect(
      failureCode(
        reserve(book, {
          reservationId: 'rsv-3',
          walletId: 'missing',
          billingAccountId: IDS.consoleAccount,
          amount: uc(1),
          createdAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('wallet_not_found');
  });

  it('rejects a wallet that belongs to another billing account', () => {
    const { book } = createTestBook();
    expect(
      failureCode(
        reserve(book, {
          reservationId: 'rsv-x',
          walletId: IDS.ucWallet,
          billingAccountId: IDS.sellerAccount,
          amount: uc(1),
          createdAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('invalid_wallet');
  });

  it('rejects a stale fencing token', () => {
    const { book } = createTestBook();
    expect(
      failureCode(
        reserve(book, {
          reservationId: 'rsv-stale',
          walletId: IDS.ucWallet,
          billingAccountId: IDS.consoleAccount,
          amount: uc(1),
          createdAt: NOW,
          fencingToken: 'fence-old',
        }),
      ),
    ).toBe('stale_fencing_token');
  });
});

describe('capture', () => {
  it('captures the whole reservation: held becomes charged', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const captured = unwrap(
      capture(held.book, {
        reservationId: 'rsv-1',
        amount: uc(400n),
        releaseRemainder: false,
        capturedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    const next = balances(captured.book, IDS.ucWallet);
    expect(next.available.minor).toBe(600n);
    expect(next.held.minor).toBe(0n);
    expect(next.charged.minor).toBe(400n);
    expect(next.total.minor).toBe(1_000n);
    expect(captured.reservation.state).toBe('captured');
  });

  it('requires an explicit remainder release for a partial capture', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    expect(
      failureCode(
        capture(held.book, {
          reservationId: 'rsv-1',
          amount: uc(250n),
          releaseRemainder: false,
          capturedAt: NOW + 1,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('remainder_release_required');
    expect(findReservation(held.book, 'rsv-1' as never).ok).toBe(true);
  });

  it('captures a partial amount and releases the remainder to available', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const captured = unwrap(
      capture(held.book, {
        reservationId: 'rsv-1',
        amount: uc(250n),
        releaseRemainder: true,
        capturedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    const next = balances(captured.book, IDS.ucWallet);
    expect(next.available.minor).toBe(750n);
    expect(next.held.minor).toBe(0n);
    expect(next.charged.minor).toBe(250n);
    expect(next.total.minor).toBe(1_000n);
  });

  it('captures exactly at the reservation limit', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const captured = unwrap(
      capture(held.book, {
        reservationId: 'rsv-1',
        amount: uc(400n),
        releaseRemainder: true,
        capturedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(balances(captured.book, IDS.ucWallet).charged.minor).toBe(400n);
  });

  it('rejects capturing more than was reserved', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    expect(
      failureCode(
        capture(held.book, {
          reservationId: 'rsv-1',
          amount: uc(401n),
          releaseRemainder: true,
          capturedAt: NOW + 1,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('insufficient_held_balance');
  });

  it('rejects a second capture on a finalized reservation', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const captured = unwrap(
      capture(held.book, {
        reservationId: 'rsv-1',
        amount: uc(400n),
        releaseRemainder: false,
        capturedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(
      failureCode(
        capture(captured.book, {
          reservationId: 'rsv-1',
          amount: uc(300n),
          releaseRemainder: true,
          capturedAt: NOW + 2,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('reservation_already_finalized');
  });

  it('replays an identical capture without a second posting', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const first = unwrap(
      capture(held.book, {
        reservationId: 'rsv-1',
        amount: uc(400n),
        releaseRemainder: false,
        capturedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    const replay = unwrap(
      capture(first.book, {
        reservationId: 'rsv-1',
        amount: uc(400n),
        releaseRemainder: false,
        capturedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.book.ledger.transactions).toHaveLength(first.book.ledger.transactions.length);
  });

  it('rejects a capture replay whose token or timestamp is malformed', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const first = unwrap(
      capture(held.book, {
        reservationId: 'rsv-1',
        amount: uc(400n),
        releaseRemainder: false,
        capturedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    // Nhánh replay không được bỏ qua validation: payload hỏng vẫn là payload hỏng.
    expect(
      failureCode(
        capture(first.book, {
          reservationId: 'rsv-1',
          amount: uc(400n),
          releaseRemainder: false,
          capturedAt: NOW + 1,
          fencingToken: ' ',
        }),
      ),
    ).toBe('invalid_fencing_token');
    expect(
      failureCode(
        capture(first.book, {
          reservationId: 'rsv-1',
          amount: uc(400n),
          releaseRemainder: false,
          capturedAt: 1.5,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('invalid_reservation');
  });

  it('capture is a charge of money, not a quota reservation — it posts a charged balance', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const captured = unwrap(
      capture(held.book, {
        reservationId: 'rsv-1',
        amount: uc(400n),
        releaseRemainder: false,
        capturedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    const derived = unwrap(deriveWalletBalances(captured.book.ledger, IDS.ucWallet as never, 'UC'));
    expect(derived.charged.minor).toBe(400n);
  });
});

describe('release', () => {
  it('returns held money to available and conserves total', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const released = unwrap(
      release(held.book, {
        reservationId: 'rsv-1',
        releasedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    const next = balances(released.book, IDS.ucWallet);
    expect(next.available.minor).toBe(1_000n);
    expect(next.held.minor).toBe(0n);
    expect(released.reservation.state).toBe('released');
  });

  it('is idempotent on replay', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const first = unwrap(
      release(held.book, {
        reservationId: 'rsv-1',
        releasedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    const replay = unwrap(
      release(first.book, {
        reservationId: 'rsv-1',
        releasedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(replay.replayed).toBe(true);
  });

  it('rejects a release replay whose token or timestamp is malformed', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const first = unwrap(
      release(held.book, {
        reservationId: 'rsv-1',
        releasedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(
      failureCode(
        release(first.book, {
          reservationId: 'rsv-1',
          releasedAt: NOW + 1,
          fencingToken: '',
        }),
      ),
    ).toBe('invalid_fencing_token');
    expect(
      failureCode(
        release(first.book, {
          reservationId: 'rsv-1',
          releasedAt: 1.5,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('invalid_reservation');
  });

  it('rejects releasing a reservation that was already captured', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    const captured = unwrap(
      capture(held.book, {
        reservationId: 'rsv-1',
        amount: uc(400n),
        releaseRemainder: false,
        capturedAt: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(
      failureCode(
        release(captured.book, {
          reservationId: 'rsv-1',
          releasedAt: NOW + 2,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('reservation_already_finalized');
  });

  it('does not release on a timeout — release needs an explicit caller decision', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const held = reserveOn(book, 400n);
    // Thời gian trôi qua rất lâu nhưng không ai gọi release: held vẫn giữ nguyên.
    const stillHeld = balances(held.book, IDS.ucWallet);
    expect(stillHeld.held.minor).toBe(400n);
    expect(
      failureCode(
        release(held.book, {
          reservationId: 'rsv-missing',
          releasedAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('reservation_not_found');
  });
});
