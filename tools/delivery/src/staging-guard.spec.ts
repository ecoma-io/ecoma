import { describe, expect, it } from 'vitest';

import {
  GUARD_MARKER_PREFIX,
  GuardAbortError,
  evaluateGuardAtPoint,
  guardActionOf,
  parseGuardInputs,
  queryFreshRunState,
  type GuardQueryDeps,
} from './staging-guard.ts';
import type { RunnerGuardDecision } from './runner-guard.ts';

const SHA = 'a'.repeat(40);

/** Deps giả cho truy vấn: ghi lại args, trả theo script. */
function fakeGhApi(script: Array<{ status: number; stdout: string; stderr?: string }>): {
  deps: GuardQueryDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  let index = 0;
  const deps: GuardQueryDeps = {
    ghApi: (args) => {
      calls.push(args);
      const step = script[Math.min(index, script.length - 1)] as {
        status: number;
        stdout: string;
        stderr?: string;
      };
      index += 1;
      return { status: step.status, stdout: step.stdout, stderr: step.stderr ?? '' };
    },
    env: {
      GITHUB_REPOSITORY: 'ecoma-io/ecoma',
      GITHUB_WORKFLOW_REF: '.github/workflows/staging.yaml@refs/heads/main',
    },
  };
  return { deps, calls };
}

const RUNS_PAGE = JSON.stringify({
  workflow_runs: [
    { id: 12, status: 'in_progress', path: '.github/workflows/staging.yaml' },
    { id: 7, status: 'completed', path: '.github/workflows/staging.yaml' },
    { id: 5, status: 'completed', path: '.github/workflows/other.yaml' },
  ],
});

/** Quyết định guard với override — helper module-level (consistent-function-scoping). */
function decision(overrides: Partial<RunnerGuardDecision>): RunnerGuardDecision {
  return { action: 'abort', code: 'query-failed', message: 'x', ...overrides };
}

/** Trang run + HEAD main chuẩn — hai lượt gh api đầu của một truy vấn sạch. */
function happyScript(): Array<{ status: number; stdout: string }> {
  return [
    { status: 0, stdout: RUNS_PAGE },
    { status: 0, stdout: 'main\n' },
    { status: 0, stdout: `${SHA}\n` },
  ];
}

describe('parseGuardInputs', () => {
  it('returns undefined when both flags are absent — guard disabled', () => {
    expect(parseGuardInputs(undefined, undefined, 'before-deploy')).toBeUndefined();
  });

  it('refuses half a guard configuration', () => {
    expect(() => parseGuardInputs('5', undefined, 'before-deploy')).toThrowError(/together/u);
    expect(() => parseGuardInputs(undefined, SHA, 'before-deploy')).toThrowError(/together/u);
  });

  it('requires a positive integer run id', () => {
    expect(parseGuardInputs('12', SHA, 'before-deploy')).toEqual({
      runId: 12,
      contextSha: SHA,
      point: 'before-deploy',
    });
    expect(() => parseGuardInputs('0', SHA, 'before-deploy')).toThrowError(/positive integer/u);
    expect(() => parseGuardInputs('-3', SHA, 'before-deploy')).toThrowError(/positive integer/u);
    expect(() => parseGuardInputs('abc', SHA, 'before-deploy')).toThrowError(/positive integer/u);
  });

  it('requires a non-empty context SHA', () => {
    expect(() => parseGuardInputs('12', '  ', 'before-deploy')).toThrowError(
      /non-empty commit SHA/u,
    );
  });
});

describe('queryFreshRunState', () => {
  it('queries the coordinator runs on main and the current main HEAD', () => {
    const { deps, calls } = fakeGhApi(happyScript());
    const result = queryFreshRunState(deps);
    expect(result).toEqual({
      ok: true,
      mainSha: SHA,
      runs: [
        { id: 12, status: 'in_progress' },
        { id: 7, status: 'completed' },
      ],
    });
    expect(calls[0]).toEqual(['repos/ecoma-io/ecoma/actions/runs?branch=main&per_page=100']);
    expect(calls[1]).toEqual(['repos/ecoma-io/ecoma', '--jq', '.default_branch']);
    expect(calls[2]).toEqual(['repos/ecoma-io/ecoma/branches/main', '--jq', '.commit.sha']);
  });

  it('fails typed when the runner env is missing', () => {
    const deps: GuardQueryDeps = {
      ghApi: () => ({ status: 0, stdout: '', stderr: '' }),
      env: {},
    };
    expect(queryFreshRunState(deps)).toEqual({
      ok: false,
      error: expect.stringContaining('GITHUB_REPOSITORY is not set'),
    });
  });

  it('fails typed when GITHUB_WORKFLOW_REF is missing', () => {
    const deps: GuardQueryDeps = {
      ghApi: () => ({ status: 0, stdout: '', stderr: '' }),
      env: { GITHUB_REPOSITORY: 'ecoma-io/ecoma' },
    };
    expect(queryFreshRunState(deps).ok).toBe(false);
  });

  it('maps an exec failure to a typed query failure, never a throw', () => {
    const deps: GuardQueryDeps = {
      ghApi: () => ({ status: 1, stdout: '', stderr: 'gh: auth required' }),
      env: { GITHUB_REPOSITORY: 'ecoma-io/ecoma', GITHUB_WORKFLOW_REF: 'wf.yaml@main' },
    };
    const result = queryFreshRunState(deps);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('gh: auth required') });
  });

  it('maps invalid JSON to a typed query failure', () => {
    const deps: GuardQueryDeps = {
      ghApi: () => ({ status: 0, stdout: 'not json', stderr: '' }),
      env: { GITHUB_REPOSITORY: 'ecoma-io/ecoma', GITHUB_WORKFLOW_REF: 'wf.yaml@main' },
    };
    expect(queryFreshRunState(deps).ok).toBe(false);
  });

  it('keeps only runs of the coordinator workflow path', () => {
    const { deps } = fakeGhApi(happyScript());
    const result = queryFreshRunState(deps);
    if (!result.ok) throw new Error('expected a fresh query result');
    expect(result.runs.every((run) => run.id !== 5)).toBe(true);
  });

  it('propagates a missing HEAD SHA as a query failure', () => {
    const { deps } = fakeGhApi([
      { status: 0, stdout: RUNS_PAGE },
      { status: 0, stdout: 'main\n' },
      { status: 0, stdout: '\n' },
    ]);
    expect(queryFreshRunState(deps)).toEqual({
      ok: false,
      error: expect.stringContaining('empty HEAD SHA'),
    });
  });
});

// `evaluateGuardAtPoint` throw GuardAbortError trên trang đầy thiếu run — test
// bắt lỗi với đúng action.
describe('evaluateGuardAtPoint completeness (§7.4 fail-closed)', () => {
  const input = { runId: 7, contextSha: SHA, point: 'before-deploy' as const };

  it('fails the query when the first full page does not contain the caller run', () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, status: 'completed' }));
    expect(() =>
      evaluateGuardAtPoint(input, { ok: true, mainSha: SHA, runs: fullPage }),
    ).toThrowError(GuardAbortError);
    // Bắt error ngoài expect (no-conditional-expect) rồi assert action ở
    // code đường thẳng.
    let caught: GuardAbortError | undefined;
    try {
      evaluateGuardAtPoint(input, { ok: true, mainSha: SHA, runs: fullPage });
    } catch (error) {
      caught = error as GuardAbortError;
    }
    expect(caught?.action).toBe('abort-query-failed');
  });

  it('maps proceed and skip without throwing', () => {
    expect(
      evaluateGuardAtPoint(input, {
        ok: true,
        mainSha: SHA,
        runs: [{ id: 7, status: 'completed' }],
      }).action,
    ).toBe('proceed');
    expect(
      evaluateGuardAtPoint(input, {
        ok: true,
        mainSha: SHA,
        runs: [
          { id: 7, status: 'completed' },
          { id: 9, status: 'completed' },
        ],
      }).action,
    ).toBe('skip');
  });

  it('proceeds when the caller run IS present in the full page', () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, status: 'completed' }));
    fullPage[99] = { id: 7, status: 'completed' };
    const { action } = evaluateGuardAtPoint(input, { ok: true, mainSha: SHA, runs: fullPage });
    expect(action).toBe('skip');
  });
});

describe('guardActionOf', () => {
  it('maps each decision path to its marker action', () => {
    expect(guardActionOf(decision({ action: 'proceed', code: 'proceed-newest-run' }))).toBe(
      'proceed',
    );
    expect(
      guardActionOf(decision({ action: 'skip', code: 'superseded-by-newer-completed-run' })),
    ).toBe('skip');
    expect(
      guardActionOf(decision({ action: 'abort', code: 'query-failed', writeFailureStatus: false })),
    ).toBe('abort-query-failed');
    expect(
      guardActionOf(decision({ action: 'abort', code: 'main-advanced', writeFailureStatus: true })),
    ).toBe('abort-main-advanced');
  });

  it('uses the marker prefix the workflow greps for', () => {
    expect(GUARD_MARKER_PREFIX).toBe('staging-guard action=');
  });
});

describe('GuardAbortError', () => {
  it('carries its action for the marker line', () => {
    const error = new GuardAbortError('abort-main-advanced', 'main advanced');
    expect(error.action).toBe('abort-main-advanced');
    expect(error.message).toBe('main advanced');
    expect(error).toBeInstanceOf(Error);
  });
});
