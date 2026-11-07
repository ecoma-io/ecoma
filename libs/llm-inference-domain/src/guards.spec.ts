/**
 * Ghim guard rehydrate: state đọc từ persistence phải bị từ chối nếu vi phạm
 * invariant mà aggregate tự bảo đảm khi sinh state.
 */

import { describe, expect, it } from 'vitest';

import { isProviderAttempt, type ProviderAttempt } from './attempt';
import { isClientDelivery } from './delivery';
import {
  closeAttempt,
  createLogicalRequest,
  isLogicalRequest,
  recordDispatchIntent,
  type LogicalRequest,
} from './request';

const ADMITTED_AT = 1_700_000_000_000;

function openRequest(): LogicalRequest {
  const result = createLogicalRequest({
    requestId: 'req_guard',
    admittedAt: ADMITTED_AT,
    policy: { maxAttempts: 3, deadlineAt: ADMITTED_AT + 60_000 },
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value;
}

function attempt(): ProviderAttempt {
  const result = recordDispatchIntent(openRequest(), {
    attemptId: 'att_1',
    candidateRef: 'cand_a',
    endpointRef: null,
    recordedAt: ADMITTED_AT + 1,
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  return result.value.attempts[0];
}

function closedAttempt(): { request: LogicalRequest; attempt: ProviderAttempt } {
  const result = recordDispatchIntent(openRequest(), {
    attemptId: 'att_1',
    candidateRef: 'cand_a',
    endpointRef: null,
    recordedAt: ADMITTED_AT + 1,
  });
  if (!result.ok) {
    throw new Error('fixture is invalid');
  }
  const closed = closeAttempt(result.value, {
    attemptId: 'att_1',
    evidence: 'confirmed_not_executed',
    endedAt: ADMITTED_AT + 2,
  });
  if (!closed.ok) {
    throw new Error('fixture is invalid');
  }
  return { request: closed.value, attempt: closed.value.attempts[0] };
}

describe('isProviderAttempt', () => {
  it('accepts an attempt produced by the domain', () => {
    expect(isProviderAttempt(attempt())).toBe(true);
    expect(isProviderAttempt(closedAttempt().attempt)).toBe(true);
  });

  it('rejects authoritative evidence that was never recorded', () => {
    expect(isProviderAttempt({ ...attempt(), evidence: 'confirmed_completed' })).toBe(false);
  });

  it('rejects evidence recorded before dispatch', () => {
    expect(
      isProviderAttempt({ ...attempt(), evidence: 'may_have_executed', evidenceRecordedAt: 1 }),
    ).toBe(false);
  });

  it('rejects a closed attempt without a recorded evidence time', () => {
    expect(isProviderAttempt({ ...attempt(), endedAt: ADMITTED_AT + 2 })).toBe(false);
  });

  it('rejects a sequence that is not a positive integer', () => {
    for (const sequence of [0, -1, 1.5, Number.NaN]) {
      expect(isProviderAttempt({ ...attempt(), sequence })).toBe(false);
    }
  });
});

describe('isLogicalRequest', () => {
  it('accepts a request produced by the domain', () => {
    expect(isLogicalRequest(openRequest())).toBe(true);
    expect(isLogicalRequest({ ...closedAttempt().request })).toBe(true);
  });

  it('rejects non-contiguous or duplicate attempt sequences', () => {
    const { request, attempt: closed } = closedAttempt();
    expect(isLogicalRequest({ ...request, attempts: [{ ...closed, sequence: 2 }] })).toBe(false);
    expect(isLogicalRequest({ ...request, attempts: [closed, closed] })).toBe(false);
  });

  it('rejects attempts recorded before the previous attempt', () => {
    const { request, attempt: closed } = closedAttempt();
    const second = { ...closed, attemptId: 'att_2', sequence: 2, recordedAt: ADMITTED_AT };
    expect(isLogicalRequest({ ...request, attempts: [closed, second] })).toBe(false);
  });

  it('rejects a deadline that is not after admission', () => {
    const request = openRequest();
    expect(
      isLogicalRequest({
        ...request,
        policy: { ...request.policy, deadlineAt: request.admittedAt },
      }),
    ).toBe(false);
  });

  it('rejects a delivery fact recorded before admission', () => {
    const request = openRequest();
    expect(
      isLogicalRequest({
        ...request,
        delivery: { state: 'committed', committedAt: 1, disconnectedAt: null },
      }),
    ).toBe(false);
    expect(
      isLogicalRequest({
        ...request,
        delivery: { state: 'not_committed', committedAt: null, disconnectedAt: 1 },
      }),
    ).toBe(false);
  });

  it('rejects a terminal request that still carries an open attempt', () => {
    const request = openRequest();
    const dispatched = recordDispatchIntent(request, {
      attemptId: 'att_1',
      candidateRef: 'cand_a',
      endpointRef: null,
      recordedAt: ADMITTED_AT + 1,
    });
    if (!dispatched.ok) {
      throw new Error('fixture is invalid');
    }
    expect(
      isLogicalRequest({
        ...dispatched.value,
        status: 'completed',
        completion: { status: 'completed', closedAt: ADMITTED_AT + 2, reason: null },
      }),
    ).toBe(false);
  });

  it('rejects completion without a confirmed provider completion', () => {
    const { request } = closedAttempt();
    expect(
      isLogicalRequest({
        ...request,
        status: 'completed',
        completion: { status: 'completed', closedAt: ADMITTED_AT + 3, reason: null },
      }),
    ).toBe(false);
  });

  it('rejects a completion closed before a recorded attempt', () => {
    const { request } = closedAttempt();
    expect(
      isLogicalRequest({
        ...request,
        status: 'completed',
        attempts: request.attempts.map((item) => ({
          ...item,
          evidence: 'confirmed_completed',
        })),
        completion: { status: 'completed', closedAt: ADMITTED_AT, reason: null },
      }),
    ).toBe(false);
  });

  it('rejects a cancellation without a reason and a failure with one', () => {
    const { request } = closedAttempt();
    expect(
      isLogicalRequest({
        ...request,
        status: 'cancelled',
        completion: { status: 'cancelled', closedAt: ADMITTED_AT + 3, reason: null },
      }),
    ).toBe(false);
    expect(
      isLogicalRequest({
        ...request,
        status: 'failed',
        completion: { status: 'failed', closedAt: ADMITTED_AT + 3, reason: 'client_cancelled' },
      }),
    ).toBe(false);
  });
});

describe('isClientDelivery', () => {
  it('rejects a delivery whose facts contradict its state', () => {
    expect(isClientDelivery({ state: 'committed', committedAt: null, disconnectedAt: null })).toBe(
      false,
    );
    expect(
      isClientDelivery({ state: 'not_committed', committedAt: ADMITTED_AT, disconnectedAt: null }),
    ).toBe(false);
  });
});
