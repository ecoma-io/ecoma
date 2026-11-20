import { describe, expect, it } from 'vitest';

import { buildValidationEvidence, maskSecrets } from './audit.ts';
import type { BaselineIdentity, CandidateIdentity } from './contract.ts';
import type { ValidationOutcome } from './runner.ts';

const candidate: CandidateIdentity = { commitSha: 'abc123', version: '1.2.3' };

const baseline: BaselineIdentity = {
  mechanism: 'pg-dump-per-database',
  database: 'db-remote-cache',
  dumpSha256: 'f'.repeat(64),
  dumpBytes: 1024,
  capturedAt: '2026-11-20T00:00:00.000Z',
  sourceLsn: '0/1234568',
  integrity: {
    historyCount: 1,
    historyMaxWhen: 1700000000000,
    tables: ['rvl.baseline_probe', 'rvl.__drizzle_migrations'],
  },
};

const outcome: ValidationOutcome = {
  status: 'passed',
  firstRelease: false,
  historyAfter: 2,
  stages: [
    { stage: 'target-install', status: 'passed', detail: 'restored', exit: null, durationMs: 5 },
    { stage: 'integrity', status: 'passed', detail: 'match', exit: null, durationMs: 4 },
    { stage: 'candidate-migration', status: 'passed', detail: 'exited 0', exit: 0, durationMs: 9 },
  ],
};

describe('secret masking', () => {
  it('masks the password of a postgres connection string', () => {
    expect(maskSecrets('postgresql://su:hunter2@127.0.0.1:5432/postgres')).toBe(
      'postgresql://su:****@127.0.0.1:5432/postgres',
    );
  });

  it('leaves text without credentials untouched', () => {
    expect(maskSecrets('restore failed: syntax error at "DROP"')).toBe(
      'restore failed: syntax error at "DROP"',
    );
    // Không nuốt URL không có password.
    expect(maskSecrets('postgresql://127.0.0.1:5432/postgres')).toBe(
      'postgresql://127.0.0.1:5432/postgres',
    );
  });
});

describe('validation evidence', () => {
  it('carries the exact candidate identity, the versioned baseline identity and per-stage results', () => {
    const evidence = buildValidationEvidence(
      'run-1',
      { database: 'db-remote-cache', candidate, baseline },
      outcome,
    );
    expect(evidence.runId).toBe('run-1');
    expect(evidence.mechanism).toBe('pg-baseline');
    expect(evidence.database).toBe('db-remote-cache');
    expect(evidence.candidate).toEqual({ commitSha: 'abc123', version: '1.2.3' });
    expect(evidence.baseline).toBe(baseline);
    expect(evidence.baseline?.database).toBe('db-remote-cache');
    expect(evidence.firstRelease).toBe(false);
    expect(evidence.status).toBe('passed');
    expect(evidence.stages).toEqual(outcome.stages);
    expect(evidence.historyAfter).toBe(2);
  });

  it('marks the first-release path with a null baseline and firstRelease true', () => {
    const fresh: ValidationOutcome = { ...outcome, firstRelease: true, historyAfter: 2 };
    const evidence = buildValidationEvidence(
      'run-2',
      { database: 'db-remote-cache', candidate, baseline: null },
      fresh,
    );
    expect(evidence.firstRelease).toBe(true);
    expect(evidence.baseline).toBeNull();
  });

  it('propagates a failed outcome without reshaping it', () => {
    const failed: ValidationOutcome = {
      status: 'failed',
      firstRelease: false,
      historyAfter: null,
      stages: [
        { stage: 'integrity', status: 'failed', detail: 'mismatch', exit: null, durationMs: 3 },
        {
          stage: 'candidate-migration',
          status: 'skipped',
          detail: 'not run',
          exit: null,
          durationMs: 0,
        },
      ],
    };
    const evidence = buildValidationEvidence(
      'run-3',
      { database: 'db-remote-cache', candidate, baseline },
      failed,
    );
    expect(evidence.status).toBe('failed');
    expect(evidence.stages).toEqual(failed.stages);
    expect(evidence.historyAfter).toBeNull();
  });
});
