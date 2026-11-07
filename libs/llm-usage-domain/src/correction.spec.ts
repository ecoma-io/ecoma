import { describe, expect, it } from 'vitest';

import {
  correctionIdempotencyKey,
  isCorrection,
  isCorrectionValid,
  type Correction,
  type NormalizedUsage,
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

function correction(overrides: Partial<Correction> = {}): Correction {
  return {
    correction_id: 'corr-1',
    scope: 'request',
    reservation_id: 'res-1',
    usage: usage(),
    ...overrides,
  } as Correction;
}

describe('isCorrection', () => {
  it('accepts valid correction and rejects others', () => {
    expect(isCorrection(correction())).toBe(true);
    expect(isCorrection(null)).toBe(false);
    expect(isCorrection(undefined)).toBe(false);
    expect(
      isCorrection({ correction_id: '', scope: 'request', reservation_id: 'r', usage: usage() }),
    ).toBe(false);
    expect(isCorrection({ correction_id: 'c', scope: 'bad', usage: usage() } as never)).toBe(false);
    expect(isCorrection({ correction_id: 'c', scope: 'request', usage: usage() } as never)).toBe(
      false,
    ); // missing reservation_id for request
    expect(
      isCorrection({ correction_id: 'c', scope: 'attempt', attempt_id: 'a', usage: usage() }),
    ).toBe(true);
  });
});

describe('isCorrectionValid', () => {
  it('accepts a structurally valid correction with valid usage', () => {
    expect(isCorrectionValid(correction(), usage()).valid).toBe(true);
  });

  it.each([
    { scope: 'request', reservation_id: '', attempt_id: undefined },
    { scope: 'attempt', reservation_id: undefined, attempt_id: '' },
  ])('rejects empty id for scope %j', (overrides) => {
    const result = isCorrectionValid(correction(overrides as never), usage());
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('rejects correction with invalid usage (cached > input)', () => {
    const result = isCorrectionValid(
      correction({ usage: usage({ input_tokens: 10, cached_tokens: 20 }) }),
      usage(),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('does not mutate inputs', () => {
    const corr = correction();
    const existing = usage();
    const beforeCorr = JSON.stringify(corr);
    const beforeExisting = JSON.stringify(existing);
    isCorrectionValid(corr, existing);
    expect(JSON.stringify(corr)).toBe(beforeCorr);
    expect(JSON.stringify(existing)).toBe(beforeExisting);
  });
});

describe('correctionIdempotencyKey', () => {
  it('builds request-level key', () => {
    expect(correctionIdempotencyKey({ scope: 'request', id: 'res-1', correction_id: 'c-1' })).toBe(
      'request:res-1:c-1',
    );
  });

  it('builds attempt-level key', () => {
    expect(correctionIdempotencyKey({ scope: 'attempt', id: 'att-1', correction_id: 'c-1' })).toBe(
      'attempt:att-1:c-1',
    );
  });

  it.each([
    { scope: 'request' as const, id: '', correction_id: 'c' },
    { scope: 'attempt' as const, id: 'a', correction_id: '' },
  ])('throws on empty id/correction_id %j', (input) => {
    expect(() => correctionIdempotencyKey(input)).toThrow(TypeError);
  });

  it('is deterministic', () => {
    const a = correctionIdempotencyKey({ scope: 'request', id: 'r', correction_id: 'c' });
    const b = correctionIdempotencyKey({ scope: 'request', id: 'r', correction_id: 'c' });
    expect(a).toBe(b);
  });
});
