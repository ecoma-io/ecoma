/**
 * Ghim financial audit (append-only, không secret) và public surface của
 * aggregate root.
 */

import { describe, expect, it } from 'vitest';

import { appendAudit, readAudit } from './audit';
import { addBillingAccount, findBillingAccount, openFinancialBook, withLedger } from './book';
import { createLedger } from './ledger';
import { isLlmFinancialDomainError, llmFinancialDomainError } from './errors';
import { createAccountOwnerRef, createBillingAccountId, isOpaqueId } from './shared';
import { createBillingAccount } from './wallet';
import { createTestBook, failureCode, IDS, NOW, uc, unwrap } from './test-fixtures';

describe('appendAudit', () => {
  it('appends an audit entry without touching balances', () => {
    const { book } = createTestBook({ ucAmount: 100n });
    const audited = unwrap(
      appendAudit(book, {
        action: 'wallet_credited',
        actorRef: 'actor-1',
        targetRef: 'dep-uc',
        amount: uc(100n),
        correlationId: 'corr-1',
        at: NOW,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(readAudit(audited)).toHaveLength(1);
    expect(audited.accounts).toEqual(book.accounts);
    expect(audited.ledger.transactions).toHaveLength(book.ledger.transactions.length);
  });

  it('keeps every appended entry — there is no update or delete', () => {
    const { book } = createTestBook();
    const first = unwrap(
      appendAudit(book, {
        action: 'reserved',
        actorRef: 'actor-1',
        targetRef: 'rsv-1',
        amount: uc(10n),
        correlationId: 'corr-1',
        at: NOW,
        fencingToken: IDS.ucFence,
      }),
    );
    const second = unwrap(
      appendAudit(first, {
        action: 'settled',
        actorRef: 'actor-1',
        targetRef: 'stl-1',
        amount: uc(10n),
        correlationId: 'corr-2',
        at: NOW + 1,
        fencingToken: IDS.ucFence,
      }),
    );
    expect(readAudit(second).map((entry) => entry.action)).toEqual(['reserved', 'settled']);
    expect(readAudit(first)).toHaveLength(1);
  });

  it('accepts an entry without an amount and rejects a malformed reference', () => {
    const { book } = createTestBook();
    expect(
      unwrap(
        appendAudit(book, {
          action: 'hold_opened',
          actorRef: 'actor-1',
          targetRef: 'hold-1',
          amount: null,
          correlationId: 'corr-1',
          at: NOW,
          fencingToken: IDS.ucFence,
        }),
      ).audit,
    ).toHaveLength(1);
    expect(
      failureCode(
        appendAudit(book, {
          action: 'hold_opened',
          actorRef: '',
          targetRef: 'hold-1',
          amount: null,
          correlationId: 'corr-1',
          at: NOW,
          fencingToken: IDS.ucFence,
        }),
      ),
    ).toBe('invalid_id');
  });
});

describe('FinancialBook aggregate', () => {
  it('opens empty with every collection frozen', () => {
    const book = openFinancialBook();
    expect(book.accounts).toHaveLength(0);
    expect(book.ledger.transactions).toHaveLength(0);
    expect(Object.isFrozen(book)).toBe(true);
    expect(Object.isFrozen(book.accounts)).toBe(true);
  });

  it('finds a billing account and reports a missing one', () => {
    const { book } = createTestBook();
    expect(unwrap(findBillingAccount(book, IDS.consoleAccount as never)).owner_ref).toBe(
      IDS.consoleOwner,
    );
    expect(failureCode(findBillingAccount(book, 'missing' as never))).toBe('invalid_wallet');
  });

  it('rejects an invalid account and a structurally broken ledger', () => {
    const book = openFinancialBook();
    expect(failureCode(addBillingAccount(book, { billing_account_id: '' } as never))).toBe(
      'invalid_wallet',
    );
    expect(failureCode(withLedger(book, { transactions: 'x' } as never))).toBe(
      'invalid_ledger_transaction',
    );
    expect(unwrap(withLedger(book, createLedger())).ledger.transactions).toHaveLength(0);
  });
});

describe('opaque identifiers', () => {
  it('accepts trimmed non-empty ids and rejects malformed ones', () => {
    expect(isOpaqueId('acct-1')).toBe(true);
    expect(isOpaqueId('')).toBe(false);
    expect(isOpaqueId(' padded')).toBe(false);
    expect(isOpaqueId('x'.repeat(201))).toBe(false);
  });

  it('creates branded ids and throws on malformed input', () => {
    expect(createBillingAccountId('acct-1')).toBe('acct-1');
    expect(createAccountOwnerRef('owner-1')).toBe('owner-1');
    expect(() => createBillingAccountId('')).toThrow(TypeError);
  });
});

describe('domain error taxonomy', () => {
  it('builds a frozen error from the canonical table', () => {
    const error = llmFinancialDomainError('idempotency_conflict');
    expect(error.code).toBe('idempotency_conflict');
    expect(Object.isFrozen(error)).toBe(true);
    expect(isLlmFinancialDomainError(error)).toBe(true);
  });

  it('rejects an unknown code and a doctored message', () => {
    expect(() => llmFinancialDomainError('not_a_code' as never)).toThrow(TypeError);
    expect(
      isLlmFinancialDomainError({ code: 'idempotency_conflict', message: 'something else' }),
    ).toBe(false);
    expect(isLlmFinancialDomainError({ code: 'idempotency_conflict' })).toBe(false);
  });
});

describe('billing account creation', () => {
  it('rejects a non-integer creation timestamp', () => {
    expect(
      failureCode(
        createBillingAccount({
          billingAccountId: 'acct-x',
          ownerRef: 'owner-x',
          createdAt: 1.5,
        }),
      ),
    ).toBe('invalid_epoch_millis');
  });
});
