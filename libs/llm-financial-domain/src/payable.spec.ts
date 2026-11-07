/**
 * Ghim seller payable: bất biến 8 (payable ≠ provider cost), 9 (payable ≠
 * payout), ADR-0007 (hold) và append-only versioning.
 */

import { describe, expect, it } from 'vitest';

import {
  accruePayable,
  adjustPayable,
  currentPayable,
  markPayablePaid,
  payableState,
  settlePayable,
} from './payable';
import { openHold, releaseHold } from './hold';
import { createTestBook, day, ec, failureCode, NOW, unwrap } from './test-fixtures';
const AVAILABLE_AT = day(20);

/** Accrue một payable `pay-1` cho seller tenant. */
function accrual(book: ReturnType<typeof createTestBook>['book'], amount = 500n) {
  return unwrap(
    accruePayable(book, {
      payableId: 'pay-1',
      sellerTenant: 'tenant-seller',
      amount: ec(amount),
      period: '2026-10',
      availableAt: AVAILABLE_AT,
      accruedAt: NOW,
      settlementId: 'stl-1',
      chargeId: 'chg-1',
      fencingToken: 'fence-ec-1',
    }),
  );
}

describe('accruePayable', () => {
  it('records an accrued payable as an EC projection', () => {
    const { book } = createTestBook();
    const payable = accrual(book).payable;
    expect(payable.state).toBe('accrued');
    expect(payable.version).toBe(1);
    expect(payable.amount.denomination).toBe('EC');
    expect(payable.denomination).toBe('EC');
    expect(payableState(payable)).toBe('accrued');
  });

  it('rejects a negative or zero amount and a UC amount', () => {
    const { book } = createTestBook();
    expect(
      failureCode(
        accruePayable(book, {
          payableId: 'pay-0',
          sellerTenant: 'tenant-seller',
          amount: ec(0n),
          period: '2026-10',
          availableAt: AVAILABLE_AT,
          accruedAt: NOW,
          settlementId: null,
          chargeId: null,
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('invalid_amount');
    expect(
      failureCode(
        accruePayable(book, {
          payableId: 'pay-0',
          sellerTenant: 'tenant-seller',
          amount: { denomination: 'UC', minor: 1n } as never,
          period: '2026-10',
          availableAt: AVAILABLE_AT,
          accruedAt: NOW,
          settlementId: null,
          chargeId: null,
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('invalid_payable');
  });

  it('is idempotent for the same accrual and rejects a conflicting one', () => {
    const { book } = createTestBook();
    const first = accrual(book);
    expect(accrual(first.book).replayed).toBe(true);
    expect(
      failureCode(
        accruePayable(first.book, {
          payableId: 'pay-1',
          sellerTenant: 'tenant-seller',
          amount: ec(501n),
          period: '2026-10',
          availableAt: AVAILABLE_AT,
          accruedAt: NOW,
          settlementId: 'stl-1',
          chargeId: 'chg-1',
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('idempotency_conflict');
  });
});

describe('settlePayable', () => {
  it('settles only after the available_at date', () => {
    const { book } = createTestBook();
    const accrued = accrual(book);
    expect(
      failureCode(
        settlePayable(accrued.book, {
          payableId: 'pay-1',
          settledAt: NOW,
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('invalid_payable_transition');
    const settled = unwrap(
      settlePayable(accrued.book, {
        payableId: 'pay-1',
        settledAt: AVAILABLE_AT,
        fencingToken: 'fence-ec-1',
      }),
    );
    expect(settled.payable.state).toBe('settled');
    expect(settled.payable.version).toBe(2);
  });

  it('appends a version instead of mutating the previous record', () => {
    const { book } = createTestBook();
    const accrued = accrual(book);
    const settled = unwrap(
      settlePayable(accrued.book, {
        payableId: 'pay-1',
        settledAt: AVAILABLE_AT,
        fencingToken: 'fence-ec-1',
      }),
    );
    expect(settled.book.payables).toHaveLength(2);
    expect(settled.book.payables[0].state).toBe('accrued');
    expect(settled.book.payables[1].state).toBe('settled');
  });

  it('is idempotent on replay', () => {
    const { book } = createTestBook();
    const accrued = accrual(book);
    const first = unwrap(
      settlePayable(accrued.book, {
        payableId: 'pay-1',
        settledAt: AVAILABLE_AT,
        fencingToken: 'fence-ec-1',
      }),
    );
    const replay = unwrap(
      settlePayable(first.book, {
        payableId: 'pay-1',
        settledAt: AVAILABLE_AT,
        fencingToken: 'fence-ec-1',
      }),
    );
    expect(replay.replayed).toBe(true);
  });

  it('rejects settlement while a settlement hold covers the period', () => {
    const { book } = createTestBook();
    const accrued = accrual(book);
    const held = unwrap(
      openHold(accrued.book, {
        holdId: 'hold-1',
        scope: 'settlement',
        sellerTenant: 'tenant-seller',
        period: '2026-10',
        reasonRef: 'reason-1',
        actorRef: 'actor-1',
        startedAt: NOW,
      }),
    );
    expect(
      failureCode(
        settlePayable(held.book, {
          payableId: 'pay-1',
          settledAt: AVAILABLE_AT,
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('payable_on_hold');
  });

  it('blocks every period under an account-level hold', () => {
    const { book } = createTestBook();
    const accrued = accrual(book);
    const held = unwrap(
      openHold(accrued.book, {
        holdId: 'hold-acct',
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
        settlePayable(held.book, {
          payableId: 'pay-1',
          settledAt: AVAILABLE_AT,
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('payable_on_hold');
  });

  it('allows settlement again after the hold is released', () => {
    const { book } = createTestBook();
    const accrued = accrual(book);
    const held = unwrap(
      openHold(accrued.book, {
        holdId: 'hold-1',
        scope: 'settlement',
        sellerTenant: 'tenant-seller',
        period: '2026-10',
        reasonRef: 'reason-1',
        actorRef: 'actor-1',
        startedAt: NOW,
      }),
    );
    const released = unwrap(
      releaseHold(held.book, { holdId: 'hold-1', releasedAt: NOW + 1, actorRef: 'actor-2' }),
    );
    const settled = unwrap(
      settlePayable(released.book, {
        payableId: 'pay-1',
        settledAt: AVAILABLE_AT,
        fencingToken: 'fence-ec-1',
      }),
    );
    expect(settled.payable.state).toBe('settled');
  });
});

describe('markPayablePaid', () => {
  it('requires payout evidence — a request existing is not proof of disbursement', () => {
    const { book } = createTestBook();
    const settled = unwrap(
      settlePayable(accrual(book).book, {
        payableId: 'pay-1',
        settledAt: AVAILABLE_AT,
        fencingToken: 'fence-ec-1',
      }),
    );
    expect(
      failureCode(
        markPayablePaid(settled.book, {
          payableId: 'pay-1',
          paidAt: AVAILABLE_AT + 1,
          payoutEvidenceRef: '',
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('payout_evidence_required');
  });

  it('marks a payable paid only with evidence and records the opaque reference', () => {
    const { book } = createTestBook();
    const settled = unwrap(
      settlePayable(accrual(book).book, {
        payableId: 'pay-1',
        settledAt: AVAILABLE_AT,
        fencingToken: 'fence-ec-1',
      }),
    );
    const paid = unwrap(
      markPayablePaid(settled.book, {
        payableId: 'pay-1',
        paidAt: AVAILABLE_AT + 1,
        payoutEvidenceRef: 'payout-evidence-1',
        fencingToken: 'fence-ec-1',
      }),
    );
    expect(paid.payable.state).toBe('paid');
    expect(paid.payable.payout_evidence_ref).toBe('payout-evidence-1');
    // Payable không mang beneficiary hay fiat amount: payout execution nằm ngoài lib.
    expect(Object.hasOwn(paid.payable, 'beneficiary')).toBe(false);
  });

  it('rejects paying an accrued payable directly', () => {
    const { book } = createTestBook();
    const accrued = accrual(book);
    expect(
      failureCode(
        markPayablePaid(accrued.book, {
          payableId: 'pay-1',
          paidAt: NOW,
          payoutEvidenceRef: 'evidence-1',
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('invalid_payable_transition');
  });

  it('replays a paid payable with the same evidence and rejects different evidence', () => {
    const { book } = createTestBook();
    const settled = unwrap(
      settlePayable(accrual(book).book, {
        payableId: 'pay-1',
        settledAt: AVAILABLE_AT,
        fencingToken: 'fence-ec-1',
      }),
    );
    const paid = unwrap(
      markPayablePaid(settled.book, {
        payableId: 'pay-1',
        paidAt: AVAILABLE_AT + 1,
        payoutEvidenceRef: 'evidence-1',
        fencingToken: 'fence-ec-1',
      }),
    );
    expect(
      unwrap(
        markPayablePaid(paid.book, {
          payableId: 'pay-1',
          paidAt: AVAILABLE_AT + 1,
          payoutEvidenceRef: 'evidence-1',
          fencingToken: 'fence-ec-1',
        }),
      ).replayed,
    ).toBe(true);
    expect(
      failureCode(
        markPayablePaid(paid.book, {
          payableId: 'pay-1',
          paidAt: AVAILABLE_AT + 2,
          payoutEvidenceRef: 'evidence-2',
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('idempotency_conflict');
  });
});

describe('adjustPayable', () => {
  it('adjusts by appending a new version, keeping the previous one intact', () => {
    const { book } = createTestBook();
    const accrued = accrual(book);
    const adjusted = unwrap(
      adjustPayable(accrued.book, {
        payableId: 'pay-1',
        amount: ec(450n),
        reasonRef: 'reason-1',
        adjustedAt: NOW + 1,
        fencingToken: 'fence-ec-1',
      }),
    );
    expect(adjusted.payable.state).toBe('adjusted');
    expect(adjusted.payable.amount.minor).toBe(450n);
    expect(adjusted.book.payables[0].amount.minor).toBe(500n);
    expect(unwrap(currentPayable(adjusted.book, 'pay-1' as never)).amount.minor).toBe(450n);
  });

  it('rejects adjusting a paid payable', () => {
    const { book } = createTestBook();
    const settled = unwrap(
      settlePayable(accrual(book).book, {
        payableId: 'pay-1',
        settledAt: AVAILABLE_AT,
        fencingToken: 'fence-ec-1',
      }),
    );
    const paid = unwrap(
      markPayablePaid(settled.book, {
        payableId: 'pay-1',
        paidAt: AVAILABLE_AT + 1,
        payoutEvidenceRef: 'evidence-1',
        fencingToken: 'fence-ec-1',
      }),
    );
    expect(
      failureCode(
        adjustPayable(paid.book, {
          payableId: 'pay-1',
          amount: ec(1n),
          reasonRef: 'reason-1',
          adjustedAt: AVAILABLE_AT + 2,
          fencingToken: 'fence-ec-1',
        }),
      ),
    ).toBe('invalid_payable_transition');
  });

  it('reports a missing payable instead of returning undefined', () => {
    const { book } = createTestBook();
    expect(failureCode(currentPayable(book, 'missing' as never))).toBe('payable_not_found');
  });
});
