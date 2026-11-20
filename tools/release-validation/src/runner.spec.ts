import { describe, expect, it } from 'vitest';

import type { BaselineIdentity, CandidateIdentity } from './contract.ts';
import { runValidation, type ValidationDeps } from './runner.ts';

const candidate: CandidateIdentity = { commitSha: 'abc123', version: '1.2.3' };

const baseline: BaselineIdentity = {
  mechanism: 'pg-dump-per-database',
  database: 'db-remote-cache',
  dumpSha256: 'f'.repeat(64),
  dumpBytes: 1024,
  capturedAt: '2026-11-20T00:00:00.000Z',
  sourceLsn: null,
  integrity: { historyCount: 1, historyMaxWhen: 1700000000000, tables: ['rvl.baseline_probe'] },
};

/** Fake deps ghi lại thứ tự stage được gọi — chứng minh fail-closed ở tầng orchestration. */
function fakeDeps(
  overrides?: Partial<ValidationDeps>,
): ValidationDeps & { readonly calls: string[] } {
  const calls: string[] = [];
  const deps: ValidationDeps = {
    installTarget: (name, b) => {
      calls.push(`install:${name}:${b === null ? 'fresh' : b.dumpSha256.slice(0, 4)}`);
      return { ok: true, detail: 'installed' };
    },
    verifyIntegrity: (name) => {
      calls.push(`integrity:${name}`);
      return { ok: true, detail: 'match' };
    },
    runCandidateMigration: (name) => {
      calls.push(`migrate:${name}`);
      return { exit: 0, detail: 'exited 0', historyAfter: 2 };
    },
  };
  return { calls, ...deps, ...overrides };
}

const okPlan = { database: 'db-remote-cache', candidate, baseline };

describe('baseline validation stage machine', () => {
  it('runs restore, integrity and candidate migration in order and passes', () => {
    const deps = fakeDeps();
    const outcome = runValidation(okPlan, deps);
    expect(deps.calls).toEqual([
      'install:db-remote-cache:ffff',
      'integrity:db-remote-cache',
      'migrate:db-remote-cache',
    ]);
    expect(outcome.status).toBe('passed');
    expect(outcome.firstRelease).toBe(false);
    expect(outcome.stages.map((stage) => stage.status)).toEqual(['passed', 'passed', 'passed']);
    expect(outcome.historyAfter).toBe(2);
  });

  it('fails closed when the target install fails — integrity and migration stay skipped', () => {
    const deps = fakeDeps({
      installTarget: (name, b) => {
        deps.calls.push(`install:${name}:${b === null ? 'fresh' : b.dumpSha256.slice(0, 4)}`);
        return { ok: false, detail: 'restore failed: syntax error' };
      },
    });
    const outcome = runValidation(okPlan, deps);
    expect(deps.calls).toEqual(['install:db-remote-cache:ffff']);
    expect(outcome.status).toBe('failed');
    expect(outcome.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['target-install', 'failed'],
      ['integrity', 'skipped'],
      ['candidate-migration', 'skipped'],
    ]);
    expect(outcome.historyAfter).toBeNull();
  });

  it('fails closed on an integrity mismatch — candidate migration never runs on an unverified baseline', () => {
    const deps = fakeDeps({
      verifyIntegrity: (name) => {
        deps.calls.push(`integrity:${name}`);
        return { ok: false, detail: 'history differs' };
      },
    });
    const outcome = runValidation(okPlan, deps);
    expect(deps.calls).toEqual(['install:db-remote-cache:ffff', 'integrity:db-remote-cache']);
    expect(outcome.status).toBe('failed');
    expect(outcome.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['target-install', 'passed'],
      ['integrity', 'failed'],
      ['candidate-migration', 'skipped'],
    ]);
  });

  it('fails closed when the candidate migration exits non-zero', () => {
    const deps = fakeDeps({
      runCandidateMigration: () => ({ exit: 1, detail: 'boom', historyAfter: 1 }),
    });
    const outcome = runValidation(okPlan, deps);
    expect(outcome.status).toBe('failed');
    expect(outcome.stages.at(-1)?.status).toBe('failed');
    expect(outcome.stages.at(-1)?.exit).toBe(1);
    expect(outcome.historyAfter).toBe(1);
  });

  it('marks integrity not-applicable on the first-release path and migrates onto an empty database', () => {
    const deps = fakeDeps();
    const outcome = runValidation({ database: 'db-remote-cache', candidate, baseline: null }, deps);
    expect(deps.calls).toEqual(['install:db-remote-cache:fresh', 'migrate:db-remote-cache']);
    expect(outcome.firstRelease).toBe(true);
    expect(outcome.status).toBe('passed');
    expect(outcome.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['target-install', 'passed'],
      ['integrity', 'not-applicable'],
      ['candidate-migration', 'passed'],
    ]);
  });
});
