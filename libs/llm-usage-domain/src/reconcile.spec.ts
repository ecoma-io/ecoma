import { describe, expect, it } from 'vitest';

import { reconcile, type NormalizedUsage, type RequestUsage } from './index';

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

function requestUsage(overrides: Partial<RequestUsage> = {}): RequestUsage {
  return {
    request_id: 'req-1',
    attempts: [],
    aggregated: usage(),
    status: 'known',
    ...overrides,
  } as RequestUsage;
}

describe('reconcile', () => {
  it('match when request == attempt total == settlement', () => {
    const result = reconcile({
      requestUsage: requestUsage({ aggregated: usage({ input_tokens: 100, output_tokens: 50 }) }),
      attemptUsages: [
        usage({ input_tokens: 60, output_tokens: 30 }),
        usage({ input_tokens: 40, output_tokens: 20 }),
      ],
      settlement: usage({ input_tokens: 100, output_tokens: 50 }),
    });
    expect(result.outcome).toBe('match');
    expect(result.detail).toContain('matches');
  });

  it('mismatch when request != attempt total', () => {
    const result = reconcile({
      requestUsage: requestUsage({ aggregated: usage({ input_tokens: 100, output_tokens: 50 }) }),
      attemptUsages: [usage({ input_tokens: 60, output_tokens: 30 })],
      settlement: null,
    });
    expect(result.outcome).toBe('mismatch');
  });

  it('mismatch when settlement differs', () => {
    const result = reconcile({
      requestUsage: requestUsage({ aggregated: usage({ input_tokens: 100, output_tokens: 50 }) }),
      attemptUsages: [usage({ input_tokens: 100, output_tokens: 50 })],
      settlement: usage({ input_tokens: 90, output_tokens: 40 }),
    });
    expect(result.outcome).toBe('mismatch');
  });

  it('incomplete when no data at all', () => {
    const result = reconcile({
      requestUsage: requestUsage({ aggregated: null }),
      attemptUsages: [],
      settlement: null,
    });
    expect(result.outcome).toBe('incomplete');
  });

  it('match when request matches attempt but settlement is null', () => {
    const result = reconcile({
      requestUsage: requestUsage({ aggregated: usage({ input_tokens: 100, output_tokens: 50 }) }),
      attemptUsages: [usage({ input_tokens: 100, output_tokens: 50 })],
      settlement: null,
    });
    expect(result.outcome).toBe('match');
  });

  it('does not mutate inputs', () => {
    const ru = requestUsage();
    const au = [usage(), usage()];
    const s = usage();
    const beforeRu = JSON.stringify(ru);
    const beforeAu = au.map((u) => JSON.stringify(u));
    const beforeS = JSON.stringify(s);
    reconcile({ requestUsage: ru, attemptUsages: au, settlement: s });
    expect(JSON.stringify(ru)).toBe(beforeRu);
    expect(au.map((u) => JSON.stringify(u))).toEqual(beforeAu);
    expect(JSON.stringify(s)).toBe(beforeS);
  });
});
