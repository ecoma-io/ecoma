import { describe, expect, it } from 'vitest';

import {
  evaluateRunnerGuard,
  type GuardPoint,
  type RunListQueryResult,
  type RunnerGuardInput,
} from './runner-guard.ts';

const SHA = 'a'.repeat(40);
const NEWER_SHA = 'b'.repeat(40);

/** Input chuẩn: run 41, bắt đầu ở SHA. */
function input(overrides: Partial<RunnerGuardInput> = {}): RunnerGuardInput {
  return { contextSha: SHA, runId: 41, point: 'before-deploy', ...overrides };
}

/** Tra cứu mới thành công: main vẫn ở SHA, không run mới hơn. */
function query(
  overrides: Partial<Extract<RunListQueryResult, { ok: true }>> = {},
): RunListQueryResult {
  return { ok: true, mainSha: SHA, runs: [], ...overrides };
}

const POINTS: readonly GuardPoint[] = ['coalesce', 'before-deploy', 'before-status'];

describe('evaluateRunnerGuard', () => {
  it('proceeds when the run is newest and its SHA is still main edge', () => {
    for (const point of POINTS) {
      const decision = evaluateRunnerGuard(input({ point }), query());
      expect(decision.action).toBe('proceed');
      expect(decision.code).toBe('proceed-newest-run');
    }
  });

  it('proceeds when only an OLDER run exists — old runs never block the newest', () => {
    const decision = evaluateRunnerGuard(
      input(),
      query({ runs: [{ id: 40, status: 'completed' }] }),
    );
    expect(decision.action).toBe('proceed');
  });

  it('aborts without touching evidence when the run list query failed', () => {
    const decision = evaluateRunnerGuard(input(), { ok: false, error: 'gh rate limited' });
    expect(decision).toMatchObject({
      action: 'abort',
      code: 'query-failed',
      writeFailureStatus: false,
    });
    expect(decision.message).toContain('gh rate limited');
  });

  it('skips without writing anything when a newer run of the group already completed', () => {
    // Conclusion không có trong input có chủ đích: run hoàn thành — bất kể
    // thành bại — đã sở hữu mặt bằng chứng mới nhất của nhóm.
    for (const point of POINTS) {
      const decision = evaluateRunnerGuard(
        input({ point }),
        query({ runs: [{ id: 42, status: 'completed' }] }),
      );
      expect(decision.action).toBe('skip');
      expect(decision.code).toBe('superseded-by-newer-completed-run');
      expect(decision.writeFailureStatus).toBeUndefined();
    }
  });

  it('does not let a pending newer run block the evidence write mid-flight', () => {
    // Một run mới hơn được trigger GIỮA cửa sổ smoke chưa hoàn thành: evidence
    // của run này vẫn là mới nhất hiện có — ghi tiếp là trung thực.
    const decision = evaluateRunnerGuard(
      input({ point: 'before-status' }),
      query({ runs: [{ id: 42, status: 'in_progress' }] }),
    );
    expect(decision.action).toBe('proceed');
  });

  it('coalesces at admission when a newer run is pending for the group', () => {
    const decision = evaluateRunnerGuard(
      input({ point: 'coalesce' }),
      query({ runs: [{ id: 42, status: 'queued' }] }),
    );
    expect(decision).toMatchObject({
      action: 'skip',
      code: 'coalesced-into-newer-pending-run',
    });
    expect(decision.writeFailureStatus).toBeUndefined();
  });

  it('does not coalesce before-deploy on a pending newer run — deployment still serves its own revision', () => {
    const decision = evaluateRunnerGuard(
      input({ point: 'before-deploy' }),
      query({ runs: [{ id: 42, status: 'queued' }] }),
    );
    expect(decision.action).toBe('proceed');
  });

  it('aborts with a failure write when main advanced past the run SHA — stale direction', () => {
    for (const point of POINTS) {
      const decision = evaluateRunnerGuard(input({ point }), query({ mainSha: NEWER_SHA }));
      expect(decision).toMatchObject({
        action: 'abort',
        code: 'main-advanced',
        writeFailureStatus: true,
      });
    }
  });

  it('aborts with a failure write when the run SHA is not main at all — divergent direction', () => {
    // SHA của run khác main nhưng không "cũ hơn" theo thời gian: bất kỳ phân
    // kỳ nào với edge cũng phải dừng, không đoán hướng.
    const decision = evaluateRunnerGuard(
      input({ contextSha: 'c'.repeat(40) }),
      query({ mainSha: SHA }),
    );
    expect(decision).toMatchObject({
      action: 'abort',
      code: 'main-advanced',
      writeFailureStatus: true,
    });
  });

  it('checks supersession BEFORE sha divergence — a not-newest run writes nothing', () => {
    const decision = evaluateRunnerGuard(
      input(),
      query({ mainSha: NEWER_SHA, runs: [{ id: 42, status: 'completed' }] }),
    );
    expect(decision).toMatchObject({ action: 'skip', code: 'superseded-by-newer-completed-run' });
  });

  it('re-queries honestly: decisions come only from the query passed in this call', () => {
    // Hai lượt với danh sách khác nhau phải ra quyết định khác nhau — guard
    // không giữ state giữa các lượt (mỗi lượt tra lại, §7.4).
    const first = evaluateRunnerGuard(input({ point: 'before-status' }), query());
    const second = evaluateRunnerGuard(
      input({ point: 'before-status' }),
      query({ runs: [{ id: 42, status: 'completed' }] }),
    );
    expect(first.action).toBe('proceed');
    expect(second.action).toBe('skip');
  });

  it('throws on a malformed run identity instead of silently guarding nothing', () => {
    expect(() => evaluateRunnerGuard(input({ contextSha: '' }), query())).toThrowError(
      /contextSha is required/u,
    );
    expect(() => evaluateRunnerGuard(input({ runId: -1 }), query())).toThrowError(/runId/u);
  });
});
