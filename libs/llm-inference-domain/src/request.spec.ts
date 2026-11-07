/**
 * Ghim vòng đời logical request: chuyển trạng thái, retry admissibility,
 * streaming/delivery facts, reconciliation của outcome bất định và các cửa sổ
 * crash. Mọi test đều kiểm hành vi nghiệp vụ, không kiểm chi tiết cài đặt.
 */

import { describe, expect, it } from 'vitest';

import { classifyAttemptOutcome, isAttemptOpen, type ProviderAttempt } from './attempt';
import type { InferenceDomainErrorCode } from './errors';
import {
  awaitReconciliation,
  cancelRequest,
  closeAttempt,
  completeRequest,
  createLogicalRequest,
  describeRequestProgress,
  evaluateRetryAdmissibility,
  failRequest,
  findAttempt,
  hasUnresolvedUncertainty,
  isLogicalRequest,
  isRequestTerminal,
  latestAttempt,
  reconcileUncertainAttempt,
  recordAttemptEvidence,
  recordClientDisconnectEvent,
  recordClientOutputCommitted,
  recordDispatchIntent,
  type LogicalRequest,
} from './request';

const ADMITTED_AT = 1_700_000_000_000;
const DEADLINE = ADMITTED_AT + 60_000;

function request(overrides: { maxAttempts?: number; deadlineAt?: number } = {}): LogicalRequest {
  const result = createLogicalRequest({
    requestId: 'req_1',
    admittedAt: ADMITTED_AT,
    policy: {
      maxAttempts: overrides.maxAttempts ?? 3,
      deadlineAt: overrides.deadlineAt ?? DEADLINE,
    },
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
}

function unwrap(result: ReturnType<typeof recordDispatchIntent>): LogicalRequest {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}`);
  }
  return result.value;
}

function errorOf(result: {
  ok: boolean;
  error?: { code: InferenceDomainErrorCode };
}): InferenceDomainErrorCode | null {
  return result.ok ? null : (result.error?.code ?? null);
}

function withAttempt(
  options: {
    attemptId?: string;
    recordedAt?: number;
    candidateRef?: string;
    endpointRef?: string | null;
    maxAttempts?: number;
    deadlineAt?: number;
  } = {},
): LogicalRequest {
  return unwrap(
    recordDispatchIntent(
      request({ maxAttempts: options.maxAttempts, deadlineAt: options.deadlineAt }),
      {
        attemptId: options.attemptId ?? 'att_1',
        candidateRef: options.candidateRef ?? 'cand_a',
        endpointRef: options.endpointRef ?? null,
        recordedAt: options.recordedAt ?? ADMITTED_AT + 1,
      },
    ),
  );
}

/** Request với attempt 1 đã đóng bằng `evidence` cho trước. */
function withClosedAttempt(
  evidence: 'not_sent' | 'may_have_executed' | 'confirmed_completed' | 'confirmed_not_executed',
  options: { maxAttempts?: number; deadlineAt?: number; endedAt?: number } = {},
): LogicalRequest {
  const dispatched = withAttempt({
    maxAttempts: options.maxAttempts,
    deadlineAt: options.deadlineAt,
  });
  const closed = unwrap(
    closeAttempt(dispatched, {
      attemptId: 'att_1',
      evidence,
      endedAt: options.endedAt ?? ADMITTED_AT + 2,
    }),
  );
  return closed;
}

describe('createLogicalRequest', () => {
  it('creates an open request with no attempts and no delivery', () => {
    const created = request();
    expect(created.status).toBe('open');
    expect(created.attempts).toEqual([]);
    expect(created.completion).toBeNull();
    expect(created.delivery).toEqual({
      state: 'not_committed',
      committedAt: null,
      disconnectedAt: null,
    });
    expect(isLogicalRequest(created)).toBe(true);
  });

  it('rejects an invalid request id or admission timestamp', () => {
    const base = {
      requestId: 'req_1',
      admittedAt: ADMITTED_AT,
      policy: { maxAttempts: 2, deadlineAt: DEADLINE },
    };
    expect(errorOf(createLogicalRequest({ ...base, requestId: '  ' }))).toBe('invalid_request_id');
    expect(errorOf(createLogicalRequest({ ...base, requestId: 42 }))).toBe('invalid_request_id');
    expect(errorOf(createLogicalRequest({ ...base, admittedAt: 1.5 }))).toBe('invalid_timestamp');
    expect(errorOf(createLogicalRequest({ ...base, admittedAt: null }))).toBe('invalid_timestamp');
  });

  it('rejects an invalid attempt policy', () => {
    const base = { requestId: 'req_1', admittedAt: ADMITTED_AT };
    for (const maxAttempts of [0, -1, 1.5, Infinity, NaN, undefined]) {
      expect(
        errorOf(
          createLogicalRequest({
            ...base,
            policy: { maxAttempts, deadlineAt: DEADLINE },
          }),
        ),
      ).toBe('invalid_attempt_limit');
    }
    expect(
      errorOf(createLogicalRequest({ ...base, policy: { maxAttempts: 2, deadlineAt: null } })),
    ).toBe('invalid_attempt_limit');
  });

  it('rejects a deadline that is not after admission', () => {
    for (const deadlineAt of [ADMITTED_AT, ADMITTED_AT - 1]) {
      expect(
        errorOf(
          createLogicalRequest({
            requestId: 'req_1',
            admittedAt: ADMITTED_AT,
            policy: { maxAttempts: 2, deadlineAt },
          }),
        ),
      ).toBe('invalid_deadline');
    }
  });

  it('does not mutate or leak the caller policy object', () => {
    const policy = { maxAttempts: 3, deadlineAt: DEADLINE };
    const created = createLogicalRequest({ requestId: 'req_1', admittedAt: ADMITTED_AT, policy });
    expect(policy).toEqual({ maxAttempts: 3, deadlineAt: DEADLINE });
    expect(created.ok && Object.isFrozen(created.value)).toBe(true);
  });
});

describe('dispatch intent and provider attempt lifecycle', () => {
  it('records an attempt as not_sent and in progress', () => {
    const dispatched = withAttempt();
    expect(dispatched.attempts).toHaveLength(1);
    const attempt = dispatched.attempts[0];
    expect(attempt.sequence).toBe(1);
    expect(attempt.evidence).toBe('not_sent');
    expect(isAttemptOpen(attempt)).toBe(true);
    expect(classifyAttemptOutcome(attempt)).toBe('not_executed');
  });

  it('assigns increasing sequence numbers', () => {
    const first = withClosedAttempt('confirmed_not_executed');
    const second = unwrap(
      recordDispatchIntent(first, {
        attemptId: 'att_2',
        candidateRef: 'cand_b',
        endpointRef: 'ep_2',
        recordedAt: ADMITTED_AT + 3,
      }),
    );
    expect(second.attempts.map((attempt) => attempt.sequence)).toEqual([1, 2]);
  });

  it('treats a repeated dispatch intent with identical facts as idempotent', () => {
    const dispatched = withAttempt();
    const replay = recordDispatchIntent(dispatched, {
      attemptId: 'att_1',
      candidateRef: 'cand_a',
      endpointRef: null,
      recordedAt: ADMITTED_AT + 1,
    });
    expect(replay.ok).toBe(true);
    expect(replay.ok && replay.value).toBe(dispatched);
  });

  it('rejects a reused attempt id with different facts', () => {
    const dispatched = withAttempt();
    expect(
      errorOf(
        recordDispatchIntent(dispatched, {
          attemptId: 'att_1',
          candidateRef: 'cand_other',
          endpointRef: null,
          recordedAt: ADMITTED_AT + 1,
        }),
      ),
    ).toBe('duplicate_attempt_id');
  });

  it('rejects an attempt while another is still open', () => {
    const dispatched = withAttempt();
    expect(
      errorOf(
        recordDispatchIntent(dispatched, {
          attemptId: 'att_2',
          candidateRef: 'cand_b',
          endpointRef: null,
          recordedAt: ADMITTED_AT + 2,
        }),
      ),
    ).toBe('attempt_in_flight');
  });

  it('rejects malformed dispatch input', () => {
    const fresh = request();
    expect(
      errorOf(
        recordDispatchIntent(fresh, {
          attemptId: '',
          candidateRef: 'cand_a',
          endpointRef: null,
          recordedAt: ADMITTED_AT + 1,
        }),
      ),
    ).toBe('invalid_attempt_id');
    expect(
      errorOf(
        recordDispatchIntent(fresh, {
          attemptId: 'att_1',
          candidateRef: '',
          endpointRef: null,
          recordedAt: ADMITTED_AT + 1,
        }),
      ),
    ).toBe('invalid_candidate_ref');
    expect(
      errorOf(
        recordDispatchIntent(fresh, {
          attemptId: 'att_1',
          candidateRef: 'cand_a',
          endpointRef: ' ',
          recordedAt: ADMITTED_AT + 1,
        }),
      ),
    ).toBe('invalid_candidate_ref');
    expect(
      errorOf(
        recordDispatchIntent(fresh, {
          attemptId: 'att_1',
          candidateRef: 'cand_a',
          endpointRef: null,
          recordedAt: 'now',
        }),
      ),
    ).toBe('invalid_timestamp');
  });

  it('rejects a dispatch intent recorded before admission', () => {
    expect(
      errorOf(
        recordDispatchIntent(request(), {
          attemptId: 'att_1',
          candidateRef: 'cand_a',
          endpointRef: null,
          recordedAt: ADMITTED_AT - 1,
        }),
      ),
    ).toBe('timestamp_regression');
  });

  it('closes an attempt exactly once and keeps the recorded facts', () => {
    const closed = withClosedAttempt('confirmed_completed');
    const attempt = closed.attempts[0];
    expect(isAttemptOpen(attempt)).toBe(false);
    expect(attempt.endedAt).toBe(ADMITTED_AT + 2);
    expect(classifyAttemptOutcome(attempt)).toBe('succeeded');
  });

  it('treats a repeated identical close as idempotent and rejects a conflicting one', () => {
    const closed = withClosedAttempt('confirmed_not_executed');
    const replay = closeAttempt(closed, {
      attemptId: 'att_1',
      evidence: 'confirmed_not_executed',
      endedAt: ADMITTED_AT + 2,
    });
    expect(replay.ok).toBe(true);
    expect(replay.ok && replay.value).toBe(closed);

    expect(
      errorOf(
        closeAttempt(closed, {
          attemptId: 'att_1',
          evidence: 'confirmed_completed',
          endedAt: ADMITTED_AT + 3,
        }),
      ),
    ).toBe('attempt_not_in_flight');
  });

  it('reports attempt_not_found for an attempt of another request', () => {
    const closed = withClosedAttempt('confirmed_not_executed');
    expect(
      errorOf(
        closeAttempt(closed, {
          attemptId: 'att_other',
          evidence: 'not_sent',
          endedAt: ADMITTED_AT + 2,
        }),
      ),
    ).toBe('attempt_not_found');
    expect(findAttempt(closed, 'att_other')).toBeNull();
  });

  it('rejects invalid close input', () => {
    const dispatched = withAttempt();
    expect(
      errorOf(
        closeAttempt(dispatched, { attemptId: 'att_1', evidence: 'x', endedAt: ADMITTED_AT + 2 }),
      ),
    ).toBe('invalid_evidence');
    expect(
      errorOf(
        closeAttempt(dispatched, { attemptId: 'att_1', evidence: 'not_sent', endedAt: null }),
      ),
    ).toBe('invalid_timestamp');
  });

  it('never mutates the previous state when recording an attempt', () => {
    const fresh = request();
    const before = fresh.attempts.length;
    withAttempt();
    expect(fresh.attempts.length).toBe(before);
    expect(Object.isFrozen(fresh)).toBe(true);
  });
});

describe('execution evidence recorded on an attempt', () => {
  it('strengthens evidence from not_sent to may_have_executed', () => {
    const dispatched = withAttempt();
    const updated = unwrap(
      recordAttemptEvidence(dispatched, {
        attemptId: 'att_1',
        evidence: 'may_have_executed',
        recordedAt: ADMITTED_AT + 5,
      }),
    );
    expect(updated.attempts[0].evidence).toBe('may_have_executed');
    expect(updated.attempts[0].evidenceRecordedAt).toBe(ADMITTED_AT + 5);
    expect(isAttemptOpen(updated.attempts[0])).toBe(true);
  });

  it('rejects a downgrade of evidence', () => {
    const dispatched = withAttempt();
    const uncertain = unwrap(
      recordAttemptEvidence(dispatched, {
        attemptId: 'att_1',
        evidence: 'may_have_executed',
        recordedAt: ADMITTED_AT + 5,
      }),
    );
    expect(
      errorOf(
        recordAttemptEvidence(uncertain, {
          attemptId: 'att_1',
          evidence: 'not_sent',
          recordedAt: ADMITTED_AT + 6,
        }),
      ),
    ).toBe('invalid_evidence_transition');
  });

  it('treats an identical evidence record as idempotent', () => {
    const dispatched = withAttempt();
    const updated = unwrap(
      recordAttemptEvidence(dispatched, {
        attemptId: 'att_1',
        evidence: 'may_have_executed',
        recordedAt: ADMITTED_AT + 5,
      }),
    );
    const replay = recordAttemptEvidence(updated, {
      attemptId: 'att_1',
      evidence: 'may_have_executed',
      recordedAt: ADMITTED_AT + 5,
    });
    expect(replay.ok && replay.value).toBe(updated);
  });

  it('rejects an out-of-order evidence record', () => {
    const dispatched = withAttempt();
    const updated = unwrap(
      recordAttemptEvidence(dispatched, {
        attemptId: 'att_1',
        evidence: 'may_have_executed',
        recordedAt: ADMITTED_AT + 5,
      }),
    );
    expect(
      errorOf(
        recordAttemptEvidence(updated, {
          attemptId: 'att_1',
          evidence: 'confirmed_completed',
          recordedAt: ADMITTED_AT + 4,
        }),
      ),
    ).toBe('timestamp_regression');
  });

  it('rejects evidence for a closed attempt', () => {
    const closed = withClosedAttempt('confirmed_not_executed');
    expect(
      errorOf(
        recordAttemptEvidence(closed, {
          attemptId: 'att_1',
          evidence: 'confirmed_completed',
          recordedAt: ADMITTED_AT + 9,
        }),
      ),
    ).toBe('attempt_not_in_flight');
  });

  it('validates evidence and timestamp values', () => {
    const dispatched = withAttempt();
    expect(
      errorOf(
        recordAttemptEvidence(dispatched, { attemptId: 'att_1', evidence: 'done', recordedAt: 1 }),
      ),
    ).toBe('invalid_evidence');
    expect(
      errorOf(
        recordAttemptEvidence(dispatched, {
          attemptId: 'att_1',
          evidence: 'confirmed_completed',
          recordedAt: 'now',
        }),
      ),
    ).toBe('invalid_timestamp');
  });

  it('keeps an uncertain outcome distinguishable from a confirmed failure', () => {
    const uncertain = withClosedAttempt('may_have_executed');
    const notExecuted = withClosedAttempt('confirmed_not_executed');
    expect(classifyAttemptOutcome(uncertain.attempts[0])).toBe('uncertain');
    expect(classifyAttemptOutcome(notExecuted.attempts[0])).toBe('not_executed');
    expect(hasUnresolvedUncertainty(uncertain)).toBe(true);
    expect(hasUnresolvedUncertainty(notExecuted)).toBe(false);
  });

  it('treats an open uncertain attempt as in progress, not as failure', () => {
    const dispatched = withAttempt();
    const uncertain = unwrap(
      recordAttemptEvidence(dispatched, {
        attemptId: 'att_1',
        evidence: 'may_have_executed',
        recordedAt: ADMITTED_AT + 5,
      }),
    );
    expect(classifyAttemptOutcome(uncertain.attempts[0])).toBe('in_progress');
  });
});

describe('retry admissibility', () => {
  it('admits the first attempt of an open request', () => {
    const decision = evaluateRetryAdmissibility(request(), { now: ADMITTED_AT });
    expect(decision.ok && decision.value).toEqual({ admissible: true, nextSequence: 1 });
  });

  it('admits another attempt after a confirmed not-executed attempt', () => {
    const closed = withClosedAttempt('confirmed_not_executed');
    const next = unwrap(
      recordDispatchIntent(closed, {
        attemptId: 'att_2',
        candidateRef: 'cand_b',
        endpointRef: null,
        recordedAt: ADMITTED_AT + 3,
      }),
    );
    expect(next.attempts).toHaveLength(2);
  });

  it('admits another attempt after a not_sent attempt', () => {
    const closed = withClosedAttempt('not_sent');
    const decision = evaluateRetryAdmissibility(closed, { now: ADMITTED_AT + 3 });
    expect(decision.ok && decision.value.admissible).toBe(true);
  });

  it('rejects a blind retry after may_have_executed', () => {
    const uncertain = withClosedAttempt('may_have_executed');
    const decision = evaluateRetryAdmissibility(uncertain, { now: ADMITTED_AT + 3 });
    expect(decision.ok && decision.value).toEqual({
      admissible: false,
      reason: 'previous_attempt_uncertain',
    });
    expect(
      errorOf(
        recordDispatchIntent(uncertain, {
          attemptId: 'att_2',
          candidateRef: 'cand_b',
          endpointRef: null,
          recordedAt: ADMITTED_AT + 3,
        }),
      ),
    ).toBe('previous_attempt_uncertain');
  });

  it('rejects a retry after a confirmed completion', () => {
    const completed = withClosedAttempt('confirmed_completed');
    const decision = evaluateRetryAdmissibility(completed, { now: ADMITTED_AT + 3 });
    expect(decision.ok && decision.value).toEqual({
      admissible: false,
      reason: 'previous_attempt_completed',
    });
  });

  it('rejects a retry after client-visible output was committed', () => {
    const notExecuted = withClosedAttempt('confirmed_not_executed');
    const committed = unwrap(
      recordClientOutputCommitted(notExecuted, { committedAt: ADMITTED_AT + 3 }),
    );
    const decision = evaluateRetryAdmissibility(committed, { now: ADMITTED_AT + 4 });
    expect(decision.ok && decision.value).toEqual({
      admissible: false,
      reason: 'client_output_committed',
    });
    expect(
      errorOf(
        recordDispatchIntent(committed, {
          attemptId: 'att_2',
          candidateRef: 'cand_b',
          endpointRef: null,
          recordedAt: ADMITTED_AT + 4,
        }),
      ),
    ).toBe('client_output_committed');
  });

  it('rejects an attempt after a terminal request', () => {
    const failed = unwrap(
      failRequest(withClosedAttempt('confirmed_not_executed'), { failedAt: ADMITTED_AT + 5 }),
    );
    expect(isRequestTerminal(failed)).toBe(true);
    const decision = evaluateRetryAdmissibility(failed, { now: ADMITTED_AT + 6 });
    expect(decision.ok && decision.value).toEqual({ admissible: false, reason: 'request_closed' });
    expect(
      errorOf(
        recordDispatchIntent(failed, {
          attemptId: 'att_2',
          candidateRef: 'cand_b',
          endpointRef: null,
          recordedAt: ADMITTED_AT + 6,
        }),
      ),
    ).toBe('request_closed');
  });

  it('rejects an attempt while one is still open', () => {
    const decision = evaluateRetryAdmissibility(withAttempt(), { now: ADMITTED_AT + 2 });
    expect(decision.ok && decision.value).toEqual({
      admissible: false,
      reason: 'attempt_in_flight',
    });
  });

  it('enforces the attempt budget', () => {
    const closed = withClosedAttempt('confirmed_not_executed', { maxAttempts: 1 });
    expect(evaluateRetryAdmissibility(closed, { now: ADMITTED_AT + 3 })).toMatchObject({
      ok: true,
      value: { admissible: false, reason: 'attempts_exhausted' },
    });
  });

  it('enforces the request deadline', () => {
    const closed = withClosedAttempt('confirmed_not_executed');
    expect(evaluateRetryAdmissibility(closed, { now: DEADLINE })).toMatchObject({
      ok: true,
      value: { admissible: false, reason: 'deadline_exhausted' },
    });
    expect(
      errorOf(
        recordDispatchIntent(closed, {
          attemptId: 'att_2',
          candidateRef: 'cand_b',
          endpointRef: null,
          recordedAt: DEADLINE,
        }),
      ),
    ).toBe('deadline_exhausted');
  });

  it('rejects a retry while the request awaits reconciliation', () => {
    const reconciling = unwrap(awaitReconciliation(withClosedAttempt('may_have_executed')));
    expect(evaluateRetryAdmissibility(reconciling, { now: ADMITTED_AT + 5 })).toMatchObject({
      ok: true,
      value: { admissible: false, reason: 'requires_reconciliation' },
    });
  });

  it('rejects a non-timestamp decision time', () => {
    expect(errorOf(evaluateRetryAdmissibility(request(), { now: 'later' }))).toBe(
      'invalid_timestamp',
    );
  });

  it('reports the next sequence when admissible', () => {
    const closed = withClosedAttempt('confirmed_not_executed');
    const decision = evaluateRetryAdmissibility(closed, { now: ADMITTED_AT + 3 });
    expect(decision.ok && decision.value).toEqual({ admissible: true, nextSequence: 2 });
  });
});

describe('client delivery and streaming facts', () => {
  it('records the first committed response byte once', () => {
    const committed = unwrap(
      recordClientOutputCommitted(request(), { committedAt: ADMITTED_AT + 1 }),
    );
    expect(committed.delivery.state).toBe('committed');
    expect(committed.delivery.committedAt).toBe(ADMITTED_AT + 1);
    const replay = unwrap(recordClientOutputCommitted(committed, { committedAt: ADMITTED_AT + 9 }));
    expect(replay.delivery.committedAt).toBe(ADMITTED_AT + 1);
  });

  it('rejects output committed after the client already disconnected', () => {
    const disconnected = unwrap(
      recordClientDisconnectEvent(request(), { disconnectedAt: ADMITTED_AT + 1 }),
    );
    expect(
      errorOf(recordClientOutputCommitted(disconnected, { committedAt: ADMITTED_AT + 2 })),
    ).toBe('invalid_delivery_transition');
  });

  it('does not treat a client disconnect as a provider cancellation', () => {
    const dispatched = withAttempt();
    const disconnected = unwrap(
      recordClientDisconnectEvent(dispatched, { disconnectedAt: ADMITTED_AT + 2 }),
    );
    expect(disconnected.status).toBe('open');
    expect(disconnected.attempts).toEqual(dispatched.attempts);
    expect(isAttemptOpen(disconnected.attempts[0])).toBe(true);
    expect(evaluateRetryAdmissibility(disconnected, { now: ADMITTED_AT + 3 })).toMatchObject({
      ok: true,
      value: { admissible: false, reason: 'attempt_in_flight' },
    });
  });

  it('keeps the disconnect fact separate from execution outcome', () => {
    const uncertain = withClosedAttempt('may_have_executed');
    const disconnected = unwrap(
      recordClientDisconnectEvent(uncertain, { disconnectedAt: ADMITTED_AT + 3 }),
    );
    expect(hasUnresolvedUncertainty(disconnected)).toBe(true);
    expect(describeRequestProgress(disconnected)).toMatchObject({
      status: 'open',
      clientDisconnected: true,
      clientOutputCommitted: false,
    });
  });

  it('treats a repeated disconnect as idempotent and rejects timestamp regression', () => {
    const disconnected = unwrap(
      recordClientDisconnectEvent(request(), { disconnectedAt: ADMITTED_AT + 2 }),
    );
    const replay = recordClientDisconnectEvent(disconnected, { disconnectedAt: ADMITTED_AT + 2 });
    expect(replay.ok && replay.value).toBe(disconnected);
    expect(
      errorOf(recordClientDisconnectEvent(disconnected, { disconnectedAt: ADMITTED_AT + 1 })),
    ).toBe('timestamp_regression');
  });

  it('rejects an invalid delivery timestamp', () => {
    expect(errorOf(recordClientOutputCommitted(request(), { committedAt: null }))).toBe(
      'invalid_timestamp',
    );
    expect(errorOf(recordClientDisconnectEvent(request(), { disconnectedAt: 'x' }))).toBe(
      'invalid_timestamp',
    );
  });
});

describe('reconciliation of an uncertain outcome', () => {
  it('requires uncertainty before entering reconciliation', () => {
    expect(errorOf(awaitReconciliation(withClosedAttempt('confirmed_not_executed')))).toBe(
      'no_uncertainty_to_reconcile',
    );
    expect(errorOf(awaitReconciliation(withAttempt()))).toBe('attempt_in_flight');
  });

  it('rejects reconciliation of a terminal request', () => {
    const failed = unwrap(
      failRequest(withClosedAttempt('confirmed_not_executed'), { failedAt: ADMITTED_AT + 5 }),
    );
    expect(errorOf(awaitReconciliation(failed))).toBe('request_closed');
  });

  it('reconciles may_have_executed into confirmed_not_executed and reopens the request', () => {
    const reconciling = unwrap(awaitReconciliation(withClosedAttempt('may_have_executed')));
    expect(reconciling.status).toBe('reconciling');

    const reconciled = unwrap(
      reconcileUncertainAttempt(reconciling, {
        attemptId: 'att_1',
        evidence: 'confirmed_not_executed',
        recordedAt: ADMITTED_AT + 10,
      }),
    );
    expect(reconciled.status).toBe('open');
    expect(reconciled.attempts[0].evidence).toBe('confirmed_not_executed');
    expect(hasUnresolvedUncertainty(reconciled)).toBe(false);
    expect(evaluateRetryAdmissibility(reconciled, { now: ADMITTED_AT + 11 })).toMatchObject({
      ok: true,
      value: { admissible: true },
    });
  });

  it('reconciles may_have_executed into confirmed_completed and completes the request', () => {
    const reconciling = unwrap(awaitReconciliation(withClosedAttempt('may_have_executed')));
    const completed = unwrap(
      reconcileUncertainAttempt(reconciling, {
        attemptId: 'att_1',
        evidence: 'confirmed_completed',
        recordedAt: ADMITTED_AT + 10,
      }),
    );
    expect(completed.status).toBe('completed');
    expect(completed.completion).toEqual({
      status: 'completed',
      closedAt: ADMITTED_AT + 10,
      reason: null,
    });
    expect(hasUnresolvedUncertainty(completed)).toBe(false);
  });

  it('refuses a second-hand "not executed" conclusion without provider confirmation', () => {
    const reconciling = unwrap(awaitReconciliation(withClosedAttempt('may_have_executed')));
    for (const evidence of ['may_have_executed', 'not_sent']) {
      expect(
        errorOf(
          reconcileUncertainAttempt(reconciling, {
            attemptId: 'att_1',
            evidence,
            recordedAt: ADMITTED_AT + 10,
          }),
        ),
      ).toBe('reconciliation_requires_confirmation');
    }
  });

  it('rejects reconciliation when the request is not reconciling', () => {
    expect(
      errorOf(
        reconcileUncertainAttempt(withClosedAttempt('may_have_executed'), {
          attemptId: 'att_1',
          evidence: 'confirmed_not_executed',
          recordedAt: ADMITTED_AT + 10,
        }),
      ),
    ).toBe('reconciliation_not_pending');
  });

  it('rejects reconciliation of an attempt that does not belong to the request', () => {
    const uncertainty = withClosedAttempt('may_have_executed');
    const reconciling = unwrap(awaitReconciliation(uncertainty));
    expect(
      errorOf(
        reconcileUncertainAttempt(reconciling, {
          attemptId: 'att_missing',
          evidence: 'confirmed_not_executed',
          recordedAt: ADMITTED_AT + 10,
        }),
      ),
    ).toBe('attempt_not_found');
  });

  it('treats a reconciling request with no uncertainty as an inconsistent state', () => {
    const inconsistent = {
      ...withClosedAttempt('confirmed_not_executed'),
      status: 'reconciling',
    };
    expect(isLogicalRequest(inconsistent)).toBe(false);
  });

  it('still refuses to reconcile an attempt that is not uncertain', () => {
    // Defence in depth: state này không hợp lệ theo `isLogicalRequest`, nhưng
    // operation không được tin vào guard của caller.
    const inconsistent = {
      ...withClosedAttempt('confirmed_not_executed'),
      status: 'reconciling',
    } as LogicalRequest;
    expect(
      errorOf(
        reconcileUncertainAttempt(inconsistent, {
          attemptId: 'att_1',
          evidence: 'confirmed_completed',
          recordedAt: ADMITTED_AT + 10,
        }),
      ),
    ).toBe('attempt_not_uncertain');
  });

  it('keeps uncertainty visible until reconciliation actually happens', () => {
    const reconciling = unwrap(awaitReconciliation(withClosedAttempt('may_have_executed')));
    expect(hasUnresolvedUncertainty(reconciling)).toBe(true);
    expect(errorOf(failRequest(reconciling, { failedAt: ADMITTED_AT + 10 }))).toBe(
      'uncertain_execution_unresolved',
    );
    expect(
      errorOf(
        cancelRequest(reconciling, { cancelledAt: ADMITTED_AT + 10, reason: 'client_cancelled' }),
      ),
    ).toBe('uncertain_execution_unresolved');
  });
});

describe('logical request completion', () => {
  it('completes the request after a confirmed provider completion', () => {
    const completed = unwrap(
      completeRequest(withClosedAttempt('confirmed_completed'), {
        completedAt: ADMITTED_AT + 2,
      }),
    );
    expect(completed.status).toBe('completed');
    expect(completed.completion).toEqual({
      status: 'completed',
      closedAt: ADMITTED_AT + 2,
      reason: null,
    });
    expect(isRequestTerminal(completed)).toBe(true);
  });

  it('refuses completion without a confirmed provider completion', () => {
    for (const evidence of ['not_sent', 'confirmed_not_executed'] as const) {
      expect(
        errorOf(completeRequest(withClosedAttempt(evidence), { completedAt: ADMITTED_AT + 5 })),
      ).toBe('completion_requires_completed_attempt');
    }
  });

  it('refuses completion while an attempt is still open', () => {
    expect(errorOf(completeRequest(withAttempt(), { completedAt: ADMITTED_AT + 5 }))).toBe(
      'attempt_in_flight',
    );
  });

  it('fails the request when no attempt may have executed', () => {
    const failed = unwrap(
      failRequest(withClosedAttempt('confirmed_not_executed'), { failedAt: ADMITTED_AT + 5 }),
    );
    expect(failed.status).toBe('failed');
    expect(failed.completion).toEqual({
      status: 'failed',
      closedAt: ADMITTED_AT + 5,
      reason: null,
    });
  });

  it('refuses to fail a request that may have executed', () => {
    expect(
      errorOf(failRequest(withClosedAttempt('may_have_executed'), { failedAt: ADMITTED_AT + 5 })),
    ).toBe('uncertain_execution_unresolved');
  });

  it('cancels a request with a reason and refuses without one', () => {
    const cancelled = unwrap(
      cancelRequest(withClosedAttempt('confirmed_not_executed'), {
        cancelledAt: ADMITTED_AT + 5,
        reason: 'client_cancelled',
      }),
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.completion?.reason).toBe('client_cancelled');

    expect(
      errorOf(
        cancelRequest(withClosedAttempt('confirmed_not_executed'), {
          cancelledAt: ADMITTED_AT + 5,
          reason: 'because',
        }),
      ),
    ).toBe('invalid_cancellation_reason');
  });

  it('refuses cancellation while an attempt is in flight', () => {
    expect(
      errorOf(
        cancelRequest(withAttempt(), {
          cancelledAt: ADMITTED_AT + 5,
          reason: 'client_cancelled',
        }),
      ),
    ).toBe('attempt_in_flight');
  });

  it('refuses a terminal transition on an already terminal request', () => {
    const failed = unwrap(
      failRequest(withClosedAttempt('confirmed_not_executed'), { failedAt: ADMITTED_AT + 5 }),
    );
    const completed = unwrap(
      completeRequest(withClosedAttempt('confirmed_completed'), { completedAt: ADMITTED_AT + 2 }),
    );
    expect(errorOf(completeRequest(failed, { completedAt: ADMITTED_AT + 6 }))).toBe(
      'request_closed',
    );
    expect(
      errorOf(
        cancelRequest(completed, { cancelledAt: ADMITTED_AT + 6, reason: 'client_cancelled' }),
      ),
    ).toBe('request_closed');
  });

  it('treats a repeated identical completion as idempotent', () => {
    const completed = unwrap(
      completeRequest(withClosedAttempt('confirmed_completed'), { completedAt: ADMITTED_AT + 2 }),
    );
    const replay = completeRequest(completed, { completedAt: ADMITTED_AT + 2 });
    expect(replay.ok && replay.value).toBe(completed);
    expect(errorOf(completeRequest(completed, { completedAt: ADMITTED_AT + 3 }))).toBe(
      'request_closed',
    );
  });

  it('rejects a completion timestamp before admission', () => {
    expect(
      errorOf(
        completeRequest(withClosedAttempt('confirmed_completed'), { completedAt: ADMITTED_AT - 1 }),
      ),
    ).toBe('timestamp_regression');
  });
});

describe('crash windows and duplicate or out-of-order commands', () => {
  it('does not allow a retry when a crash left an open dispatch intent', () => {
    const dispatched = withAttempt();
    expect(evaluateRetryAdmissibility(dispatched, { now: ADMITTED_AT + 2 })).toMatchObject({
      ok: true,
      value: { admissible: false, reason: 'attempt_in_flight' },
    });
    expect(errorOf(completeRequest(dispatched, { completedAt: ADMITTED_AT + 2 }))).toBe(
      'attempt_in_flight',
    );
  });

  it('allows a duplicate dispatch intent replay after a crash to be a no-op', () => {
    const dispatched = withAttempt();
    const replay = recordDispatchIntent(dispatched, {
      attemptId: 'att_1',
      candidateRef: 'cand_a',
      endpointRef: null,
      recordedAt: ADMITTED_AT + 1,
    });
    expect(replay.ok && replay.value.attempts).toHaveLength(1);
  });

  it('rejects a duplicate attempt id even when the request is terminal', () => {
    const failed = unwrap(
      failRequest(withClosedAttempt('confirmed_not_executed'), { failedAt: ADMITTED_AT + 5 }),
    );
    expect(
      errorOf(
        recordDispatchIntent(failed, {
          attemptId: 'att_1',
          candidateRef: 'cand_other',
          endpointRef: null,
          recordedAt: ADMITTED_AT + 6,
        }),
      ),
    ).toBe('duplicate_attempt_id');
  });

  it('is deterministic for identical inputs', () => {
    const first = withClosedAttempt('may_have_executed');
    const second = withClosedAttempt('may_have_executed');
    expect(first).toEqual(second);
    expect(evaluateRetryAdmissibility(first, { now: ADMITTED_AT + 3 })).toEqual(
      evaluateRetryAdmissibility(second, { now: ADMITTED_AT + 3 }),
    );
  });

  it('keeps the previous state intact across every rejected command', () => {
    const uncertain = withClosedAttempt('may_have_executed');
    const snapshot = structuredClone(uncertain);
    recordDispatchIntent(uncertain, {
      attemptId: 'att_2',
      candidateRef: 'cand_b',
      endpointRef: null,
      recordedAt: ADMITTED_AT + 3,
    });
    failRequest(uncertain, { failedAt: ADMITTED_AT + 3 });
    recordAttemptEvidence(uncertain, {
      attemptId: 'att_1',
      evidence: 'not_sent',
      recordedAt: ADMITTED_AT + 3,
    });
    expect(uncertain).toEqual(snapshot);
  });

  it('freezes every returned state and its nested collections', () => {
    const dispatched = withAttempt();
    expect(Object.isFrozen(dispatched)).toBe(true);
    expect(Object.isFrozen(dispatched.attempts)).toBe(true);
    expect(Object.isFrozen(dispatched.attempts[0])).toBe(true);
    expect(Object.isFrozen(dispatched.delivery)).toBe(true);
  });
});

describe('describeRequestProgress', () => {
  it('summarises outcomes without replacing the execution state', () => {
    const closed = withClosedAttempt('confirmed_not_executed');
    const progress = describeRequestProgress(closed);
    expect(progress).toEqual({
      status: 'open',
      attemptCount: 1,
      attemptOutcomes: ['not_executed'],
      clientOutputCommitted: false,
      clientDisconnected: false,
    });
    expect(latestAttempt(closed)?.attemptId).toBe('att_1');
  });

  it('reports an uncertain closed attempt as uncertain', () => {
    const progress = describeRequestProgress(withClosedAttempt('may_have_executed'));
    expect(progress.attemptOutcomes).toEqual(['uncertain']);
  });

  it('reports an open not_sent attempt as not_executed but still in flight', () => {
    const attempt: ProviderAttempt = withAttempt().attempts[0];
    expect(isAttemptOpen(attempt)).toBe(true);
    expect(describeRequestProgress(withAttempt()).attemptOutcomes).toEqual(['not_executed']);
  });
});
