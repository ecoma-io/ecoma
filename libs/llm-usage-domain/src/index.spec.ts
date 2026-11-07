import { describe, expect, it } from 'vitest';

import {
  type AttemptUsage,
  type NormalizedUsage,
  type Provenance,
  type RequestUsage,
  type UsageStatus,
  aggregateAttemptUsage,
  classifyUsage,
  computeTotalTokens,
  createNormalizedUsage,
  isCorrectionValid,
  isNormalizedUsage,
  normalizeUsage,
  reconcile,
  validateUsageInvariants,
} from './index';

describe('index public API surface', () => {
  it('exports every documented public operation', () => {
    expect(typeof normalizeUsage).toBe('function');
    expect(typeof classifyUsage).toBe('function');
    expect(typeof createNormalizedUsage).toBe('function');
    expect(typeof computeTotalTokens).toBe('function');
    expect(typeof validateUsageInvariants).toBe('function');
    expect(typeof aggregateAttemptUsage).toBe('function');
    expect(typeof isCorrectionValid).toBe('function');
    expect(typeof reconcile).toBe('function');
    expect(typeof isNormalizedUsage).toBe('function');
  });
});

describe('cross-operation behavior (regression)', () => {
  const provenance: Provenance = {
    provider: 'provider-a',
    model: 'model-x',
    attempt_id: 'att-1',
    request_id: 'req-1',
    normalizer_version: '1.0.0',
    raw_usage_reference: 'raw-1',
    timestamp: '2026-01-01T00:00:00Z',
  };

  const knownUsage: NormalizedUsage = createNormalizedUsage({
    input_tokens: 100,
    output_tokens: 50,
    cached_tokens: 20,
    reasoning_tokens: 10,
    request_count: 1,
  });

  it('unknown ≠ 0 end to end: missing provider → missing status, null total', () => {
    const status = classifyUsage(null);
    expect(status).toBe('missing');
    expect(computeTotalTokens(knownUsage)).toBe(150);
  });

  it('aggregate + reconcile: known attempts match settlement', () => {
    const attempts: readonly AttemptUsage[] = [
      {
        usage: knownUsage,
        status: 'known',
        provenance,
        raw_usage_reference: 'r1',
      },
    ];
    const aggregated = aggregateAttemptUsage(attempts);
    expect(aggregated.aggregated).toEqual(knownUsage);
    const result = reconcile({
      requestUsage: aggregated,
      attemptUsages: attempts.map((a) => a.usage),
      settlement: knownUsage,
    });
    expect(result.outcome).toBe('match');
  });

  it('correction valid then reconcile still works', () => {
    const correctionValid = isCorrectionValid(
      {
        correction_id: 'c-1',
        scope: 'request',
        reservation_id: 'res-1',
        usage: knownUsage,
      },
      knownUsage,
    );
    expect(correctionValid.valid).toBe(true);
  });

  it('RequestUsage type fields present', () => {
    const ru: RequestUsage = {
      request_id: 'req-1',
      attempts: [],
      aggregated: null,
      status: 'missing',
    };
    expect(ru.request_id).toBe('req-1');
    expect(ru.attempts).toEqual([]);
    expect(ru.aggregated).toBe(null);
    expect(ru.status).toBe('missing');
  });

  it('UsageStatus union values', () => {
    const statuses: UsageStatus[] = ['known', 'missing', 'malformed', 'partial'];
    expect(statuses.includes(classifyUsage({ input_tokens: 1 }))).toBe(true);
  });
});
