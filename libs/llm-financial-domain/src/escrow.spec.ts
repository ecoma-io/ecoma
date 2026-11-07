/**
 * Ghim hold và escrow/lease: ADR-0007 (settlement hold vs account hold),
 * bất biến 6 (không reallocate khi chưa reconcile), 11 (lease ≠ quota lease) và
 * 12 (unused escrow ≠ outstanding liability).
 */

import { describe, expect, it } from 'vitest';

import { locateWallet } from './book';
import { activeHolds, findHold, openHold, releaseHold } from './hold';
import {
  closeEscrow,
  escrowRemaining,
  escrowState,
  findEscrow,
  issueLease,
  openEscrow,
  revokeLease,
} from './escrow';
import { createTestBook, failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';

/** Balance hiện tại của một wallet trong book. */
function balances(book: ReturnType<typeof createTestBook>['book'], walletId: string) {
  return unwrap(locateWallet(book, walletId as never)).wallet.balances;
}

describe('openHold and releaseHold', () => {
  it('opens a settlement hold scoped to one period', () => {
    const { book } = createTestBook();
    const outcome = unwrap(
      openHold(book, {
        holdId: 'hold-1',
        scope: 'settlement',
        sellerTenant: 'tenant-seller',
        period: '2026-10',
        reasonRef: 'reason-1',
        actorRef: 'actor-1',
        startedAt: NOW,
      }),
    );
    expect(outcome.hold.scope).toBe('settlement');
    expect(outcome.hold.period).toBe('2026-10');
    expect(activeHolds(outcome.book, 'tenant-seller' as never, NOW)).toHaveLength(1);
  });

  it('does not change any wallet balance — a hold is not a restriction on money', () => {
    const { book } = createTestBook({ ecAmount: 500n });
    const before = balances(book, IDS.ecWallet);
    const outcome = unwrap(
      openHold(book, {
        holdId: 'hold-1',
        scope: 'account',
        sellerTenant: 'tenant-seller',
        period: null,
        reasonRef: 'reason-1',
        actorRef: 'actor-1',
        startedAt: NOW,
      }),
    );
    expect(balances(outcome.book, IDS.ecWallet)).toEqual(before);
    expect(outcome.book.ledger.transactions).toHaveLength(book.ledger.transactions.length);
  });

  it('requires a period for a settlement hold and forbids one for an account hold', () => {
    const { book } = createTestBook();
    expect(
      failureCode(
        openHold(book, {
          holdId: 'hold-1',
          scope: 'settlement',
          sellerTenant: 'tenant-seller',
          period: null,
          reasonRef: 'reason-1',
          actorRef: 'actor-1',
          startedAt: NOW,
        }),
      ),
    ).toBe('invalid_hold');
    expect(
      failureCode(
        openHold(book, {
          holdId: 'hold-2',
          scope: 'account',
          sellerTenant: 'tenant-seller',
          period: '2026-10',
          reasonRef: 'reason-1',
          actorRef: 'actor-1',
          startedAt: NOW,
        }),
      ),
    ).toBe('invalid_hold');
  });

  it('requires a reason and an actor', () => {
    const { book } = createTestBook();
    expect(
      failureCode(
        openHold(book, {
          holdId: 'hold-1',
          scope: 'account',
          sellerTenant: 'tenant-seller',
          period: null,
          reasonRef: '',
          actorRef: 'actor-1',
          startedAt: NOW,
        }),
      ),
    ).toBe('invalid_hold');
  });

  it('is idempotent and rejects a conflicting replay', () => {
    const { book } = createTestBook();
    const first = unwrap(
      openHold(book, {
        holdId: 'hold-1',
        scope: 'account',
        sellerTenant: 'tenant-seller',
        period: null,
        reasonRef: 'reason-1',
        actorRef: 'actor-1',
        startedAt: NOW,
      }),
    );
    expect(
      unwrap(
        openHold(first.book, {
          holdId: 'hold-1',
          scope: 'account',
          sellerTenant: 'tenant-seller',
          period: null,
          reasonRef: 'reason-1',
          actorRef: 'actor-1',
          startedAt: NOW,
        }),
      ).replayed,
    ).toBe(true);
    expect(
      failureCode(
        openHold(first.book, {
          holdId: 'hold-1',
          scope: 'settlement',
          sellerTenant: 'tenant-seller',
          period: '2026-10',
          reasonRef: 'reason-1',
          actorRef: 'actor-1',
          startedAt: NOW,
        }),
      ),
    ).toBe('idempotency_conflict');
  });

  it('releases a hold and keeps the released record for audit', () => {
    const { book } = createTestBook();
    const opened = unwrap(
      openHold(book, {
        holdId: 'hold-1',
        scope: 'account',
        sellerTenant: 'tenant-seller',
        period: null,
        reasonRef: 'reason-1',
        actorRef: 'actor-1',
        startedAt: NOW,
      }),
    );
    const released = unwrap(
      releaseHold(opened.book, { holdId: 'hold-1', releasedAt: NOW + 1, actorRef: 'actor-2' }),
    );
    expect(unwrap(findHold(released.book, 'hold-1')).released_at).toBe(NOW + 1);
    expect(activeHolds(released.book, 'tenant-seller' as never, NOW + 2)).toHaveLength(0);
  });

  it('rejects releasing before the hold started and an unknown hold', () => {
    const { book } = createTestBook();
    const opened = unwrap(
      openHold(book, {
        holdId: 'hold-1',
        scope: 'account',
        sellerTenant: 'tenant-seller',
        period: null,
        reasonRef: 'reason-1',
        actorRef: 'actor-1',
        startedAt: NOW,
      }),
    );
    expect(
      failureCode(
        releaseHold(opened.book, { holdId: 'hold-1', releasedAt: NOW - 1, actorRef: 'actor-2' }),
      ),
    ).toBe('invalid_hold');
    expect(
      failureCode(
        releaseHold(opened.book, { holdId: 'missing', releasedAt: NOW + 1, actorRef: 'actor-2' }),
      ),
    ).toBe('hold_not_found');
  });
});

describe('openEscrow and issueLease', () => {
  it('moves money from available to held when the escrow opens', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const opened = unwrap(
      openEscrow(book, {
        escrowId: 'esc-1',
        walletId: IDS.ucWallet,
        amount: uc(400n),
        createdAt: NOW,
        fencingToken: IDS.ucFence,
      }),
    );
    const next = balances(opened.book, IDS.ucWallet);
    expect(next.available.minor).toBe(600n);
    expect(next.held.minor).toBe(400n);
    expect(next.total.minor).toBe(1_000n);
    expect(escrowState(opened.escrow)).toBe('open');
    expect(escrowRemaining(opened.escrow)).toBe(400n);
  });

  it('rejects an escrow larger than available', () => {
    const { book } = createTestBook({ ucAmount: 100n });
    expect(
      failureCode(
        openEscrow(book, {
          escrowId: 'esc-1',
          walletId: IDS.ucWallet,
          amount: uc(101n),
          createdAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('insufficient_available_balance');
  });

  it('opens an escrow idempotently and rejects a conflicting replay', () => {
    const { book } = createTestBook({ ucAmount: 1_000n });
    const first = unwrap(
      openEscrow(book, {
        escrowId: 'esc-1',
        walletId: IDS.ucWallet,
        amount: uc(400n),
        createdAt: NOW,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(
      unwrap(
        openEscrow(first.book, {
          escrowId: 'esc-1',
          walletId: IDS.ucWallet,
          amount: uc(400n),
          createdAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ).replayed,
    ).toBe(true);
    expect(
      failureCode(
        openEscrow(first.book, {
          escrowId: 'esc-1',
          walletId: IDS.ucWallet,
          amount: uc(401n),
          createdAt: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('idempotency_conflict');
  });

  it('issues a lease from escrow without changing any balance', () => {
    const opened = openTestEscrow();
    const leased = unwrap(
      issueLease(opened.book, {
        leaseId: 'lease-1',
        escrowId: 'esc-1',
        amount: uc(150n),
        epoch: 1,
        fencingToken: 'fence-lease-1',
        issuedAt: NOW,
        expiresAt: NOW + 60_000,
      }),
    );
    expect(leased.lease.state).toBe('active');
    expect(balances(leased.book, IDS.ucWallet)).toEqual(balances(opened.book, IDS.ucWallet));
    expect(escrowRemaining(unwrap(findEscrow(leased.book, 'esc-1')))).toBe(250n);
  });

  it('rejects a lease that would exceed the escrow', () => {
    const opened = openTestEscrow();
    expect(
      failureCode(
        issueLease(opened.book, {
          leaseId: 'lease-1',
          escrowId: 'esc-1',
          amount: uc(401n),
          epoch: 1,
          fencingToken: 'fence-lease-1',
          issuedAt: NOW,
          expiresAt: NOW + 60_000,
        }),
      ),
    ).toBe('invalid_budget_lease');
  });

  it('rejects a lease with a non-increasing epoch or a non-positive window', () => {
    const opened = openTestEscrow();
    const first = unwrap(
      issueLease(opened.book, {
        leaseId: 'lease-1',
        escrowId: 'esc-1',
        amount: uc(100n),
        epoch: 5,
        fencingToken: 'fence-lease-1',
        issuedAt: NOW,
        expiresAt: NOW + 60_000,
      }),
    );
    expect(
      failureCode(
        issueLease(first.book, {
          leaseId: 'lease-2',
          escrowId: 'esc-1',
          amount: uc(100n),
          epoch: 5,
          fencingToken: 'fence-lease-2',
          issuedAt: NOW,
          expiresAt: NOW + 60_000,
        }),
      ),
    ).toBe('invalid_budget_lease');
    expect(
      failureCode(
        issueLease(first.book, {
          leaseId: 'lease-3',
          escrowId: 'esc-1',
          amount: uc(100n),
          epoch: 6,
          fencingToken: 'fence-lease-3',
          issuedAt: NOW,
          expiresAt: NOW - 1,
        }),
      ),
    ).toBe('invalid_budget_lease');
  });

  it('is idempotent by lease id and rejects a conflicting replay', () => {
    const opened = openTestEscrow();
    const first = unwrap(
      issueLease(opened.book, {
        leaseId: 'lease-1',
        escrowId: 'esc-1',
        amount: uc(100n),
        epoch: 1,
        fencingToken: 'fence-lease-1',
        issuedAt: NOW,
        expiresAt: NOW + 60_000,
      }),
    );
    expect(
      unwrap(
        issueLease(first.book, {
          leaseId: 'lease-1',
          escrowId: 'esc-1',
          amount: uc(100n),
          epoch: 1,
          fencingToken: 'fence-lease-1',
          issuedAt: NOW,
          expiresAt: NOW + 60_000,
        }),
      ).replayed,
    ).toBe(true);
    expect(
      failureCode(
        issueLease(first.book, {
          leaseId: 'lease-1',
          escrowId: 'esc-1',
          amount: uc(101n),
          epoch: 1,
          fencingToken: 'fence-lease-1',
          issuedAt: NOW,
          expiresAt: NOW + 60_000,
        }),
      ),
    ).toBe('idempotency_conflict');
  });
});

describe('revokeLease and closeEscrow', () => {
  it('refuses to revoke a lease whose epoch is still current', () => {
    const leased = leaseTestEscrow();
    expect(
      failureCode(
        revokeLease(leased.book, { leaseId: 'lease-1', observedEpoch: 1, revokedAt: NOW + 1 }),
      ),
    ).toBe('lease_not_stale');
  });

  it('revokes a lease once a newer epoch has been observed', () => {
    const leased = leaseTestEscrow();
    const revoked = unwrap(
      revokeLease(leased.book, { leaseId: 'lease-1', observedEpoch: 2, revokedAt: NOW + 1 }),
    );
    expect(revoked.lease.state).toBe('revoked');
  });

  it('refuses to close an escrow without reconciliation evidence', () => {
    const opened = openTestEscrow();
    expect(
      failureCode(
        closeEscrow(opened.book, {
          escrowId: 'esc-1',
          reconciliationRef: '',
          closedAt: NOW + 1,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('reconciliation_required');
  });

  it('refuses to close an escrow that still has an active lease', () => {
    const leased = leaseTestEscrow();
    expect(
      failureCode(
        closeEscrow(leased.book, {
          escrowId: 'esc-1',
          reconciliationRef: 'recon-1',
          closedAt: NOW + 1,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('lease_not_stale');
  });

  it('returns unused escrow to available only after reconciliation and lease revocation', () => {
    const leased = leaseTestEscrow();
    const revoked = unwrap(
      revokeLease(leased.book, { leaseId: 'lease-1', observedEpoch: 2, revokedAt: NOW + 1 }),
    );
    const closed = unwrap(
      closeEscrow(revoked.book, {
        escrowId: 'esc-1',
        reconciliationRef: 'recon-1',
        closedAt: NOW + 2,
        fencingToken: IDS.ucFence,
      }),
    );
    const next = balances(closed.book, IDS.ucWallet);
    expect(next.available.minor).toBe(1_000n);
    expect(next.held.minor).toBe(0n);
    expect(next.total.minor).toBe(1_000n);
    expect(closed.escrow.reconciliation_ref).toBe('recon-1');
    expect(escrowState(closed.escrow)).toBe('released');
  });

  it('is idempotent on close and reports a missing escrow', () => {
    const leased = leaseTestEscrow();
    const revoked = unwrap(
      revokeLease(leased.book, { leaseId: 'lease-1', observedEpoch: 2, revokedAt: NOW + 1 }),
    );
    const closed = unwrap(
      closeEscrow(revoked.book, {
        escrowId: 'esc-1',
        reconciliationRef: 'recon-1',
        closedAt: NOW + 2,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(
      unwrap(
        closeEscrow(closed.book, {
          escrowId: 'esc-1',
          reconciliationRef: 'recon-1',
          closedAt: NOW + 2,
          fencingToken: IDS.ucFence,
        }),
      ).replayed,
    ).toBe(true);
    expect(failureCode(findEscrow(closed.book, 'missing'))).toBe('escrow_not_found');
  });
});

/** Mở một escrow 400 UC trên fixture. */
function openTestEscrow() {
  const { book } = createTestBook({ ucAmount: 1_000n });
  return unwrap(
    openEscrow(book, {
      escrowId: 'esc-1',
      walletId: IDS.ucWallet,
      amount: uc(400n),
      createdAt: NOW,
      fencingToken: IDS.ucFence,
    }),
  );
}

/** Mở escrow rồi cấp một lease 100 UC với epoch 1. */
function leaseTestEscrow() {
  const opened = openTestEscrow();
  return unwrap(
    issueLease(opened.book, {
      leaseId: 'lease-1',
      escrowId: 'esc-1',
      amount: uc(100n),
      epoch: 1,
      fencingToken: 'fence-lease-1',
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    }),
  );
}
