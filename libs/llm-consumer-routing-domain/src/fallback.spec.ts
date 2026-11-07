import { describe, expect, it } from 'vitest';

import {
  decideFallback,
  isFallbackAllowedEvidence,
  isExecutionEvidence,
  EXECUTION_EVIDENCE,
} from './fallback';
import type { FallbackInputs } from './fallback';

function inputs(overrides: Partial<FallbackInputs> = {}): FallbackInputs {
  return {
    evidence: EXECUTION_EVIDENCE.not_sent,
    streamStarted: false,
    attemptCount: 0,
    maxAttempts: 3,
    ...overrides,
  };
}

describe('fallback decision', () => {
  it('allows fallback for not_sent evidence', () => {
    const result = decideFallback(inputs({ evidence: EXECUTION_EVIDENCE.not_sent }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.fallbackAllowed).toBe(true);
  });

  it('allows fallback for confirmed_not_executed evidence', () => {
    const result = decideFallback(inputs({ evidence: EXECUTION_EVIDENCE.confirmed_not_executed }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.fallbackAllowed).toBe(true);
  });

  it('blocks fallback for may_have_executed evidence', () => {
    const result = decideFallback(inputs({ evidence: EXECUTION_EVIDENCE.may_have_executed }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('fallback_not_allowed');
    expect(result.fallbackAllowed).toBe(false);
  });

  it('blocks fallback for confirmed_completed evidence', () => {
    const result = decideFallback(inputs({ evidence: EXECUTION_EVIDENCE.confirmed_completed }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('fallback_not_allowed');
  });

  it('blocks fallback when stream already started', () => {
    const result = decideFallback(inputs({ streamStarted: true }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('fallback_not_allowed');
  });

  it('blocks fallback when attempts exhausted', () => {
    const result = decideFallback(inputs({ attemptCount: 3, maxAttempts: 3 }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('fallback_exhausted');
  });

  it('allows fallback when attempts remain', () => {
    const result = decideFallback(inputs({ attemptCount: 2, maxAttempts: 3 }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.fallbackAllowed).toBe(true);
  });

  it('rejects invalid evidence', () => {
    const result = decideFallback(inputs({ evidence: 'unknown' as unknown as never }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('fallback_not_allowed');
  });

  it('isFallbackAllowedEvidence classifies correctly', () => {
    expect(isFallbackAllowedEvidence(EXECUTION_EVIDENCE.not_sent)).toBe(true);
    expect(isFallbackAllowedEvidence(EXECUTION_EVIDENCE.confirmed_not_executed)).toBe(true);
    expect(isFallbackAllowedEvidence(EXECUTION_EVIDENCE.may_have_executed)).toBe(false);
    expect(isFallbackAllowedEvidence(EXECUTION_EVIDENCE.confirmed_completed)).toBe(false);
  });

  it('isExecutionEvidence validates vocabulary', () => {
    expect(isExecutionEvidence('not_sent')).toBe(true);
    expect(isExecutionEvidence('may_have_executed')).toBe(true);
    expect(isExecutionEvidence('confirmed_completed')).toBe(true);
    expect(isExecutionEvidence('confirmed_not_executed')).toBe(true);
    expect(isExecutionEvidence('')).toBe(false);
    expect(isExecutionEvidence(null)).toBe(false);
  });

  it('pins the evidence vocabulary owned by llm-inference', () => {
    // Routing khai báo lại vocabulary tại biên (không import xuyên bounded
    // context). Bốn literal dưới đây là contract với `llm-inference`
    // (`docs/domains/llm-inference/domain-model.md` §2): đổi một bên mà
    // không đổi bên kia sẽ làm fallback và retry hiểu khác nhau.
    expect(Object.keys(EXECUTION_EVIDENCE).toSorted()).toEqual([
      'confirmed_completed',
      'confirmed_not_executed',
      'may_have_executed',
      'not_sent',
    ]);
    expect(EXECUTION_EVIDENCE.not_sent).toBe('not_sent');
    expect(EXECUTION_EVIDENCE.may_have_executed).toBe('may_have_executed');
    expect(EXECUTION_EVIDENCE.confirmed_completed).toBe('confirmed_completed');
    expect(EXECUTION_EVIDENCE.confirmed_not_executed).toBe('confirmed_not_executed');
  });

  it('only answers whether routing can fall back, not whether execution continues', () => {
    // Fallback allowed ở routing không thay thế luật retry của llm-inference:
    // request vẫn có thể bị chặn bởi terminal state, deadline hoặc bất định
    // chưa reconcile mà routing không nhìn thấy.
    const result = decideFallback(
      inputs({ evidence: EXECUTION_EVIDENCE.not_sent, attemptCount: 0, maxAttempts: 3 }),
    );
    expect(result.ok && result.fallbackAllowed).toBe(true);
    expect(Object.keys(result).toSorted()).toEqual(['fallbackAllowed', 'ok', 'reason']);
  });
});
