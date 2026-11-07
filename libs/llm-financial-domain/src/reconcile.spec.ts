/**
 * Ghim reconciliation: thuần, không mutation, ba trạng thái, và mismatch được
 * báo có cấu trúc chứ không tự sửa số liệu.
 */

import { describe, expect, it } from 'vitest';

import { findConservationViolation, reconcileWallet } from './reconcile';
import { createTestBook, failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';

/** Snapshot balance quan sát khớp ledger của fixture. */
function observed(available: bigint, held: bigint, charged: bigint) {
  return Object.freeze({
    available: uc(available),
    held: uc(held),
    charged: uc(charged),
    total: uc(available + held + charged),
  });
}

describe('reconcileWallet', () => {
  it('reports matched when the observed balances equal the ledger', () => {
    const { book } = createTestBook({ ucAmount: 500n });
    const report = unwrap(
      reconcileWallet(book, {
        walletId: IDS.ucWallet,
        denomination: 'UC',
        observed: observed(500n, 0n, 0n),
        checkedAt: NOW,
      }),
    );
    expect(report.status).toBe('matched');
    expect(report.discrepancies).toHaveLength(0);
    expect(report.expected?.total.minor).toBe(500n);
  });

  it('reports a structured discrepancy without mutating the book', () => {
    const { book } = createTestBook({ ucAmount: 500n });
    const before = book.ledger.transactions.length;
    const report = unwrap(
      reconcileWallet(book, {
        walletId: IDS.ucWallet,
        denomination: 'UC',
        observed: observed(400n, 100n, 0n),
        checkedAt: NOW,
      }),
    );
    expect(report.status).toBe('mismatched');
    expect(report.discrepancies.map((entry) => entry.field)).toEqual(['available', 'held']);
    expect(book.ledger.transactions).toHaveLength(before);
  });

  it('reports unverifiable when there is no observed source, never a false green', () => {
    const { book } = createTestBook({ ucAmount: 500n });
    const report = unwrap(
      reconcileWallet(book, {
        walletId: IDS.ucWallet,
        denomination: 'UC',
        observed: null,
        checkedAt: NOW,
      }),
    );
    expect(report.status).toBe('unverifiable');
    expect(report.observed).toBeNull();
    expect(report.expected?.total.minor).toBe(500n);
  });

  it('rejects malformed input instead of pretending to reconcile', () => {
    const { book } = createTestBook({ ucAmount: 500n });
    expect(
      failureCode(
        reconcileWallet(book, {
          walletId: '',
          denomination: 'UC',
          observed: null,
          checkedAt: NOW,
        }),
      ),
    ).toBe('invalid_reconciliation');
    expect(
      failureCode(
        reconcileWallet(book, {
          walletId: IDS.ucWallet,
          denomination: 'UC',
          observed: { available: uc(1) } as never,
          checkedAt: NOW,
        }),
      ),
    ).toBe('invalid_reconciliation');
  });

  it('rejects an observed snapshot from another denomination', () => {
    const { book } = createTestBook({ ucAmount: 500n });
    expect(
      failureCode(
        reconcileWallet(book, {
          walletId: IDS.ucWallet,
          denomination: 'UC',
          observed: {
            available: { denomination: 'EC', minor: 1n },
            held: { denomination: 'EC', minor: 0n },
            charged: { denomination: 'EC', minor: 0n },
            total: { denomination: 'EC', minor: 1n },
          },
          checkedAt: NOW,
        }),
      ),
    ).toBe('denomination_mismatch');
  });
});

describe('findConservationViolation', () => {
  it('returns null for a consistent snapshot', () => {
    expect(findConservationViolation(observed(1n, 2n, 3n))).toBeNull();
  });

  it('reports a total that does not equal the sum of the three balances', () => {
    const broken = Object.freeze({
      available: uc(1n),
      held: uc(2n),
      charged: uc(3n),
      total: uc(7n),
    });
    expect(findConservationViolation(broken)?.field).toBe('total');
  });
});
