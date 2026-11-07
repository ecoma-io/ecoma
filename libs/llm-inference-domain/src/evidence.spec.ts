/**
 * Ghim vocabulary evidence và ma trận chuyển đổi: bằng chứng chỉ mạnh lên,
 * không bị hạ cấp, và adapter không được suy ra "not executed" từ HTTP status.
 */

import { describe, expect, it } from 'vitest';

import {
  EXECUTION_EVIDENCE,
  EXECUTION_EVIDENCE_VALUES,
  allowedEvidenceTargets,
  canTransitionEvidence,
  classifyEvidence,
  isAuthoritativeEvidence,
  isExecutionEvidence,
  isRetrySafeEvidence,
  type ExecutionEvidence,
} from './evidence';

const ALL: readonly ExecutionEvidence[] = [
  EXECUTION_EVIDENCE.not_sent,
  EXECUTION_EVIDENCE.may_have_executed,
  EXECUTION_EVIDENCE.confirmed_completed,
  EXECUTION_EVIDENCE.confirmed_not_executed,
];

describe('execution evidence vocabulary', () => {
  it('exposes exactly the four canonical values', () => {
    expect([...EXECUTION_EVIDENCE_VALUES]).toEqual([
      'not_sent',
      'may_have_executed',
      'confirmed_completed',
      'confirmed_not_executed',
    ]);
  });

  it('accepts every canonical value and rejects anything else', () => {
    for (const value of ALL) {
      expect(isExecutionEvidence(value)).toBe(true);
    }
    for (const value of ['', 'not-sent', 'executed', 'unknown', null, undefined, 0, {}]) {
      expect(isExecutionEvidence(value)).toBe(false);
    }
  });

  it('treats only confirmed_* as authoritative', () => {
    expect(isAuthoritativeEvidence(EXECUTION_EVIDENCE.confirmed_completed)).toBe(true);
    expect(isAuthoritativeEvidence(EXECUTION_EVIDENCE.confirmed_not_executed)).toBe(true);
    expect(isAuthoritativeEvidence(EXECUTION_EVIDENCE.not_sent)).toBe(false);
    expect(isAuthoritativeEvidence(EXECUTION_EVIDENCE.may_have_executed)).toBe(false);
  });

  it('allows retry only for evidence that proves no execution happened', () => {
    expect(isRetrySafeEvidence(EXECUTION_EVIDENCE.not_sent)).toBe(true);
    expect(isRetrySafeEvidence(EXECUTION_EVIDENCE.confirmed_not_executed)).toBe(true);
    expect(isRetrySafeEvidence(EXECUTION_EVIDENCE.may_have_executed)).toBe(false);
    expect(isRetrySafeEvidence(EXECUTION_EVIDENCE.confirmed_completed)).toBe(false);
  });
});

describe('execution evidence transition matrix', () => {
  it('never downgrades evidence', () => {
    expect(
      canTransitionEvidence(EXECUTION_EVIDENCE.may_have_executed, EXECUTION_EVIDENCE.not_sent),
    ).toBe(false);
    expect(
      canTransitionEvidence(
        EXECUTION_EVIDENCE.confirmed_completed,
        EXECUTION_EVIDENCE.may_have_executed,
      ),
    ).toBe(false);
    expect(
      canTransitionEvidence(
        EXECUTION_EVIDENCE.confirmed_not_executed,
        EXECUTION_EVIDENCE.may_have_executed,
      ),
    ).toBe(false);
  });

  it('never swaps one authoritative confirmation for the opposite one', () => {
    expect(
      canTransitionEvidence(
        EXECUTION_EVIDENCE.confirmed_completed,
        EXECUTION_EVIDENCE.confirmed_not_executed,
      ),
    ).toBe(false);
    expect(
      canTransitionEvidence(
        EXECUTION_EVIDENCE.confirmed_not_executed,
        EXECUTION_EVIDENCE.confirmed_completed,
      ),
    ).toBe(false);
  });

  it('allows every self-transition so duplicate commands are idempotent', () => {
    for (const value of ALL) {
      expect(canTransitionEvidence(value, value)).toBe(true);
    }
  });

  it('allows not_sent to strengthen into any later observation', () => {
    expect(canTransitionEvidence('not_sent', 'may_have_executed')).toBe(true);
    expect(canTransitionEvidence('not_sent', 'confirmed_not_executed')).toBe(true);
    expect(canTransitionEvidence('not_sent', 'confirmed_completed')).toBe(true);
  });

  it('allows an uncertain outcome to be reconciled by provider confirmation', () => {
    expect(canTransitionEvidence('may_have_executed', 'confirmed_completed')).toBe(true);
    expect(canTransitionEvidence('may_have_executed', 'confirmed_not_executed')).toBe(true);
    expect(canTransitionEvidence('may_have_executed', 'not_sent')).toBe(false);
  });

  it('treats terminal evidence as absorbing', () => {
    expect(allowedEvidenceTargets('confirmed_completed')).toEqual(['confirmed_completed']);
    expect(allowedEvidenceTargets('confirmed_not_executed')).toEqual(['confirmed_not_executed']);
  });

  it('verifies the whole matrix exhaustively', () => {
    const expected: Record<ExecutionEvidence, readonly ExecutionEvidence[]> = {
      not_sent: ['not_sent', 'may_have_executed', 'confirmed_not_executed', 'confirmed_completed'],
      may_have_executed: ['may_have_executed', 'confirmed_not_executed', 'confirmed_completed'],
      confirmed_not_executed: ['confirmed_not_executed'],
      confirmed_completed: ['confirmed_completed'],
    };
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransitionEvidence(from, to)).toBe(expected[from].includes(to));
      }
    }
  });

  it('rejects unknown evidence values instead of throwing', () => {
    expect(canTransitionEvidence('bogus' as ExecutionEvidence, 'not_sent')).toBe(false);
    expect(allowedEvidenceTargets('bogus' as ExecutionEvidence)).toBeUndefined();
  });
});

describe('classifyEvidence', () => {
  it('prefers an explicit provider confirmation of completion', () => {
    expect(
      classifyEvidence({
        dispatchAttempted: true,
        providerConfirmedCompleted: true,
        providerConfirmedNotExecuted: false,
      }),
    ).toBe('confirmed_completed');
  });

  it('accepts confirmed_not_executed only from an explicit provider statement', () => {
    expect(
      classifyEvidence({
        dispatchAttempted: true,
        providerConfirmedCompleted: false,
        providerConfirmedNotExecuted: true,
      }),
    ).toBe('confirmed_not_executed');
  });

  it('falls back to may_have_executed once a dispatch was attempted', () => {
    expect(
      classifyEvidence({
        dispatchAttempted: true,
        providerConfirmedCompleted: false,
        providerConfirmedNotExecuted: false,
      }),
    ).toBe('may_have_executed');
  });

  it('reports not_sent only when nothing was dispatched', () => {
    expect(
      classifyEvidence({
        dispatchAttempted: false,
        providerConfirmedCompleted: false,
        providerConfirmedNotExecuted: false,
      }),
    ).toBe('not_sent');
  });

  it('never derives confirmed_not_executed from absence of confirmation', () => {
    const evidence = classifyEvidence({
      dispatchAttempted: true,
      providerConfirmedCompleted: false,
      providerConfirmedNotExecuted: false,
    });
    expect(evidence).not.toBe('confirmed_not_executed');
    expect(isRetrySafeEvidence(evidence)).toBe(false);
  });
});
