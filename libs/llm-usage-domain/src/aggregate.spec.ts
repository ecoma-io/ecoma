import { describe, expect, it } from 'vitest';

import {
  aggregateAttemptUsage,
  type AttemptUsage,
  type NormalizedUsage,
  type Provenance,
  type UsageStatus,
} from './index';

function usage(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    input_tokens: 100,
    output_tokens: 50,
    cached_tokens: 20,
    reasoning_tokens: 10,
    request_count: 1,
    ...overrides,
  } as NormalizedUsage;
}

function provenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    provider: 'provider-a',
    model: 'model-x',
    attempt_id: 'attempt-1',
    request_id: 'request-1',
    normalizer_version: '1.0.0',
    raw_usage_reference: 'raw-1',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Provenance;
}

function attempt(status: UsageStatus, overrides: Partial<AttemptUsage> = {}): AttemptUsage {
  return {
    usage: usage(),
    status,
    provenance: provenance(),
    raw_usage_reference: 'raw-1',
    ...overrides,
  } as AttemptUsage;
}

describe('aggregateAttemptUsage', () => {
  it('sums completed (known) attempts', () => {
    const result = aggregateAttemptUsage([
      attempt('known', { usage: usage({ input_tokens: 100, output_tokens: 50 }) }),
      attempt('known', { usage: usage({ input_tokens: 50, output_tokens: 25 }) }),
    ]);
    expect(result.aggregated).toEqual(
      usage({
        input_tokens: 150,
        output_tokens: 75,
        cached_tokens: 40,
        reasoning_tokens: 20,
        request_count: 2,
      }),
    );
    expect(result.status).toBe('known');
  });

  it('returns null aggregated when no known attempts (status reflects worst non-missing)', () => {
    const result = aggregateAttemptUsage([attempt('missing'), attempt('malformed')]);
    expect(result.aggregated).toBe(null);
    expect(result.status).toBe('malformed');
  });

  it('empty attempts → missing status, null aggregated', () => {
    const result = aggregateAttemptUsage([]);
    expect(result.aggregated).toBe(null);
    expect(result.status).toBe('missing');
    expect(result.attempts).toEqual([]);
  });

  it.each([
    [[attempt('missing'), attempt('missing')], 'missing'],
    [[attempt('known'), attempt('missing')], 'known'],
    [[attempt('malformed')], 'malformed'],
    [[attempt('partial')], 'partial'],
    [[attempt('known'), attempt('partial')], 'known'],
    [[attempt('partial'), attempt('missing')], 'partial'],
  ])('status for attempts %j → %s', (attempts, expectedStatus) => {
    expect(aggregateAttemptUsage(attempts).status).toBe(expectedStatus);
  });

  it('does not mutate attempts', () => {
    const attempts = [attempt('known'), attempt('missing')];
    const before = attempts.map((a) => JSON.stringify(a));
    aggregateAttemptUsage(attempts);
    expect(attempts.map((a) => JSON.stringify(a))).toEqual(before);
  });

  it('request_id comes from first attempt provenance', () => {
    const result = aggregateAttemptUsage([
      attempt('known', { provenance: provenance({ request_id: 'req-42' }) }),
    ]);
    expect(result.request_id).toBe('req-42');
  });
});
