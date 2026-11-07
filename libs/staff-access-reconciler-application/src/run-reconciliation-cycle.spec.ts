import { describe, expect, it } from 'vitest';

import type { OutboxReconcileRepository, StalePublishedEvent } from './outbox-reconcile-repository';
import { runReconciliationCycle, type ReconciliationCycleDeps } from './run-reconciliation-cycle';

function fakeRepo(stale: StalePublishedEvent[]): OutboxReconcileRepository {
  return {
    async listStalePublished(input) {
      void input;
      return stale;
    },
  };
}

const BASE_ROW: StalePublishedEvent = {
  event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  event_type: 'entitlement.revoked',
  occurred_at: '2026-10-30T00:00:00Z',
  published_at: '2026-10-30T00:00:10Z',
  attempts: 1,
  last_error: null,
  settled_at: null,
};

function deps(overrides: Partial<ReconciliationCycleDeps> = {}): ReconciliationCycleDeps {
  return {
    outbox: fakeRepo([]),
    staleAfterMs: 300_000,
    limit: 100,
    clock: { now: () => 1_780_400_000_000 },
    ...overrides,
  };
}

describe('runReconciliationCycle', () => {
  it('returns zero for an empty scan without throwing', async () => {
    const result = await runReconciliationCycle(deps());
    expect(result.stalePublished).toBe(0);
    expect(result.staleEventIds).toEqual([]);
  });

  it('reports stale published rows with their event ids', async () => {
    const result = await runReconciliationCycle(
      deps({
        outbox: fakeRepo([
          BASE_ROW,
          { ...BASE_ROW, event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        ]),
      }),
    );
    expect(result.stalePublished).toBe(2);
    expect(result.staleEventIds).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ]);
  });

  it('passes the configured thresholds to the repository', async () => {
    let captured: unknown;
    const repo: OutboxReconcileRepository = {
      async listStalePublished(input) {
        captured = input;
        return [];
      },
    };
    await runReconciliationCycle(deps({ outbox: repo, staleAfterMs: 123_456, limit: 7 }), 5_000);
    expect(captured).toEqual({ nowMs: 5_000, staleAfterMs: 123_456, limit: 7 });
  });

  it('uses the injected clock when no override is given', async () => {
    let capturedNow = 0;
    const repo: OutboxReconcileRepository = {
      async listStalePublished(input) {
        capturedNow = input.nowMs;
        return [];
      },
    };
    await runReconciliationCycle(deps({ outbox: repo }));
    expect(capturedNow).toBe(1_780_400_000_000);
  });

  it('carries the configured limit and threshold in the result', async () => {
    const result = await runReconciliationCycle(deps({ staleAfterMs: 456_789, limit: 12 }));
    expect(result.limit).toBe(12);
    expect(result.staleAfterMs).toBe(456_789);
  });

  it('throws when limit is 0 or below', async () => {
    await expect(runReconciliationCycle(deps({ limit: 0 }))).rejects.toThrow(
      'reconciliation cycle limit must be a positive integer: 0',
    );
    await expect(runReconciliationCycle(deps({ limit: -5 }))).rejects.toThrow(
      'reconciliation cycle limit must be a positive integer: -5',
    );
  });

  it('throws when limit is non-integer', async () => {
    await expect(runReconciliationCycle(deps({ limit: 1.5 }))).rejects.toThrow(
      'reconciliation cycle limit must be a positive integer: 1.5',
    );
  });

  it('throws when limit exceeds MAX_RECONCILIATION_LIMIT', async () => {
    await expect(runReconciliationCycle(deps({ limit: 10_001 }))).rejects.toThrow(
      'reconciliation cycle limit must not exceed',
    );
  });

  it('accepts limit at exactly MAX_RECONCILIATION_LIMIT', async () => {
    const result = await runReconciliationCycle(deps({ limit: 10_000 }));
    expect(result.limit).toBe(10_000);
  });

  it('throws when staleAfterMs is 0 or below', async () => {
    await expect(runReconciliationCycle(deps({ staleAfterMs: -1 }))).rejects.toThrow(
      'reconciliation cycle staleAfterMs must be a non-negative integer: -1',
    );
  });

  it('throws when staleAfterMs is non-integer', async () => {
    await expect(runReconciliationCycle(deps({ staleAfterMs: 1.5 }))).rejects.toThrow(
      'reconciliation cycle staleAfterMs must be a non-negative integer: 1.5',
    );
  });

  it('accepts staleAfterMs = 0', async () => {
    const result = await runReconciliationCycle(deps({ staleAfterMs: 0 }));
    expect(result.staleAfterMs).toBe(0);
  });

  it('throws when nowMs is NaN', async () => {
    await expect(runReconciliationCycle(deps(), NaN)).rejects.toThrow(
      'reconciliation cycle nowMs must be a finite number',
    );
  });

  it('throws when nowMs is Infinity', async () => {
    await expect(runReconciliationCycle(deps(), Infinity)).rejects.toThrow(
      'reconciliation cycle nowMs must be a finite number',
    );
  });
});
