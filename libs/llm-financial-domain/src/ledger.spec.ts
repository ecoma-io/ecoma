/**
 * Ghim bất biến 1 (double-entry), 7 (append-only) và idempotency của ledger.
 */

import { describe, expect, it } from 'vitest';

import {
  createLedger,
  createLedgerTransaction,
  deriveWalletBalances,
  isLedger,
  isLedgerReference,
  isLedgerTransaction,
  postTransaction,
  type LedgerEntry,
  type LedgerLeg,
} from './ledger';
import { failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';
/** Leg helper — mọi leg phải dương để transaction có nghĩa. */
function leg(
  index: number,
  account: LedgerLeg['account'],
  direction: LedgerLeg['direction'],
  minor: bigint,
): LedgerLeg {
  return {
    entry_id: `tx-1#${index}`,
    account,
    direction,
    amount: uc(minor),
  };
}

/** Dựng một transaction hợp lệ với id/entry id do test đặt. */
function transaction(
  overrides?: Partial<Parameters<typeof createLedgerTransaction>[0]>,
): ReturnType<typeof createLedgerTransaction> {
  return createLedgerTransaction({
    transactionId: 'tx-1',
    idempotencyKey: 'idem-1',
    walletId: IDS.ucWallet,
    billingAccountId: IDS.consoleAccount,
    denomination: 'UC',
    legs: [leg(0, 'wallet_available', 'credit', 100n), leg(1, 'funding_clearing', 'debit', 100n)],
    reference: { type: 'credit', id: 'dep-1' },
    fencingToken: IDS.ucFence,
    createdAt: NOW,
    ...overrides,
  });
}

describe('createLedgerTransaction', () => {
  it('accepts a balanced transaction and stamps every entry with the fencing token', () => {
    const created = unwrap(transaction());
    expect(created.entries).toHaveLength(2);
    expect(created.entries.every((entry: LedgerEntry) => entry.fencing_token === IDS.ucFence)).toBe(
      true,
    );
    expect(isLedgerTransaction(created)).toBe(true);
  });

  it('rejects an unbalanced transaction — invariant 1 fails closed', () => {
    expect(
      failureCode(
        transaction({
          legs: [
            leg(0, 'wallet_available', 'credit', 100n),
            leg(1, 'funding_clearing', 'debit', 99n),
          ],
        }),
      ),
    ).toBe('unbalanced_transaction');
  });

  it('rejects a zero-amount leg', () => {
    expect(
      failureCode(
        transaction({
          legs: [leg(0, 'wallet_available', 'credit', 0n), leg(1, 'funding_clearing', 'debit', 0n)],
        }),
      ),
    ).toBe('invalid_ledger_transaction');
  });

  it('rejects duplicate entry ids', () => {
    const duplicate = leg(0, 'wallet_available', 'credit', 10n);
    expect(failureCode(transaction({ legs: [duplicate, { ...duplicate }] }))).toBe(
      'invalid_ledger_transaction',
    );
  });

  it('rejects an unknown ledger account', () => {
    expect(
      failureCode(
        transaction({
          legs: [
            { entry_id: 'x#0', account: 'revenue' as never, direction: 'credit', amount: uc(1) },
            leg(1, 'funding_clearing', 'debit', 1n),
          ],
        }),
      ),
    ).toBe('invalid_ledger_transaction');
  });

  it('rejects a leg whose denomination differs from the transaction', () => {
    expect(
      failureCode(
        transaction({
          legs: [
            { entry_id: 'x#0', account: 'wallet_available', direction: 'credit', amount: uc(1) },
            {
              entry_id: 'x#1',
              account: 'funding_clearing',
              direction: 'debit',
              amount: {
                denomination: 'EC',
                minor: 1n,
              },
            },
          ],
        }),
      ),
    ).toBe('denomination_mismatch');
  });
});

describe('postTransaction', () => {
  it('appends the transaction and never mutates the previous ledger', () => {
    const ledger = createLedger();
    const posted = unwrap(postTransaction(ledger, unwrap(transaction())));
    expect(ledger.transactions).toHaveLength(0);
    expect(posted.ledger.transactions).toHaveLength(1);
    expect(isLedger(posted.ledger)).toBe(true);
  });

  it('replays an identical transaction without appending a second copy', () => {
    const first = unwrap(postTransaction(createLedger(), unwrap(transaction())));
    const second = unwrap(postTransaction(first.ledger, unwrap(transaction())));
    expect(second.replayed).toBe(true);
    expect(second.ledger.transactions).toHaveLength(1);
  });

  it('rejects the same idempotency key with a different payload — conflicts are not replays', () => {
    const first = unwrap(postTransaction(createLedger(), unwrap(transaction())));
    const conflicting = unwrap(
      transaction({
        legs: [
          leg(0, 'wallet_available', 'credit', 200n),
          leg(1, 'funding_clearing', 'debit', 200n),
        ],
      }),
    );
    expect(failureCode(postTransaction(first.ledger, conflicting))).toBe('idempotency_conflict');
  });

  it('rejects a structurally invalid ledger or transaction', () => {
    expect(
      failureCode(postTransaction({ transactions: 'x' } as never, unwrap(transaction()))),
    ).toBe('invalid_ledger_transaction');
  });
});

describe('deriveWalletBalances', () => {
  it('derives zero balances for a wallet without entries', () => {
    const balances = unwrap(deriveWalletBalances(createLedger(), IDS.ucWallet as never, 'UC'));
    expect(balances.available.minor).toBe(0n);
    expect(balances.total.minor).toBe(0n);
  });

  it('keeps available plus held plus charged equal to total after several movements', () => {
    let ledger = createLedger();
    const movements: readonly (readonly LedgerLeg[])[] = [
      [leg(0, 'wallet_available', 'debit', 500n), leg(1, 'funding_clearing', 'credit', 500n)],
      [leg(0, 'wallet_available', 'credit', 200n), leg(1, 'wallet_held', 'debit', 200n)],
      [leg(0, 'wallet_held', 'credit', 120n), leg(1, 'wallet_charged', 'debit', 120n)],
      [leg(0, 'wallet_held', 'credit', 80n), leg(1, 'wallet_available', 'debit', 80n)],
    ];
    movements.forEach((legs, index) => {
      const tx = unwrap(
        createLedgerTransaction({
          transactionId: `tx-${index}`,
          idempotencyKey: `idem-${index}`,
          walletId: IDS.ucWallet,
          billingAccountId: IDS.consoleAccount,
          denomination: 'UC',
          legs: legs.map((entry, legIndex) => ({ ...entry, entry_id: `tx-${index}#${legIndex}` })),
          reference: { type: 'credit', id: `ref-${index}` },
          fencingToken: IDS.ucFence,
          createdAt: NOW,
        }),
      );
      ledger = unwrap(postTransaction(ledger, tx)).ledger;
    });
    const balances = unwrap(deriveWalletBalances(ledger, IDS.ucWallet as never, 'UC'));
    expect(balances.available.minor).toBe(380n);
    expect(balances.held.minor).toBe(0n);
    expect(balances.charged.minor).toBe(120n);
    expect(balances.total.minor).toBe(500n);
    expect(balances.available.minor + balances.held.minor + balances.charged.minor).toBe(
      balances.total.minor,
    );
  });

  it('reports a corrupt ledger instead of returning a negative balance', () => {
    const corrupt = unwrap(
      createLedgerTransaction({
        transactionId: 'tx-bad',
        idempotencyKey: 'idem-bad',
        walletId: IDS.ucWallet,
        billingAccountId: IDS.consoleAccount,
        denomination: 'UC',
        legs: [leg(0, 'wallet_available', 'credit', 10n), leg(1, 'funding_clearing', 'debit', 10n)],
        reference: { type: 'credit', id: 'dep-bad' },
        fencingToken: IDS.ucFence,
        createdAt: NOW,
      }),
    );
    const ledger = unwrap(postTransaction(createLedger(), corrupt)).ledger;
    expect(failureCode(deriveWalletBalances(ledger, IDS.ucWallet as never, 'UC'))).toBe(
      'invalid_ledger_transaction',
    );
  });
});

describe('isLedgerReference', () => {
  it('accepts a known reference type and rejects an unknown one', () => {
    expect(isLedgerReference({ type: 'refund', id: 'r-1' })).toBe(true);
    expect(isLedgerReference({ type: 'payout', id: 'r-1' })).toBe(false);
  });
});
