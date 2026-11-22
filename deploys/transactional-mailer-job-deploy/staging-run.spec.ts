/**
 * Unit tests PER-UNIT của `staging-run.ts` — phần riêng của unit
 * `transactional-mailer-job` (#355): classify lane (KHÔNG có lane local) và
 * wrapper reader output `mailJobDatabaseId`. Các test dùng chung của engine
 * (inventory env, ensureStack, parsers, evidence, runStagingPhase…) đã dồn về
 * `libs/deployment/src/staging-run.spec.ts` (#543).
 */

import { describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  DATABASE_PLACEHOLDER_ID,
  STAGING_MAIL_JOB_DATABASE_NAME,
  classifyTransactionalMailerJobDeployStack,
  isProvisionedDatabaseId,
  readDatabaseId,
  type StagingExecDeps,
} from './staging-run.js';

/** Backend R2 hình đúng tổ hợp (đủ endpoint/region/s3ForcePathStyle=true). */
const R2_BACKEND_URL =
  's3://ecoma-pulumi-staging?endpoint=https%3A%2F%2Ftest.r2.cloudflarestorage.com&region=auto&s3ForcePathStyle=true';

/** ExecResult hình đúng CLI: chỉ cần status/stdout/stderr cho các pure parser. */
function execResult(
  overrides: Partial<{ status: number | null; stdout: string; stderr: string }> = {},
): ExecResult {
  return { status: 0, stdout: '', stderr: '', ...overrides };
}

/** Fake deps ghi lại mỗi lời gọi exec — assert số lần gọi + đối số. */
function recordingExec(results: ExecResult[]): {
  deps: StagingExecDeps;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  let index = 0;
  return {
    deps: {
      execFn: (command, args) => {
        calls.push({ command, args });
        // Quá số kết quả giả là lỗi test, KHÔNG phải thành công ngầm.
        const result = results[index];
        if (result === undefined) {
          throw new Error(
            `unexpected exec call #${index + 1} (${command} ${args.join(' ')}) — ` +
              'the spec mock exhausted its scripted results; update the test',
          );
        }
        index += 1;
        return result;
      },
    },
    calls,
  };
}

describe('classifyTransactionalMailerJobDeployStack', () => {
  it('the continuous staging slug routes to the staging lane', () => {
    expect(
      classifyTransactionalMailerJobDeployStack(
        'organization/transactional-mailer-job-deploy/staging',
      ),
    ).toBe('staging');
  });

  it('the staging-candidate slug is recognized on its own so the guard can refuse it (#381)', () => {
    expect(
      classifyTransactionalMailerJobDeployStack(
        'organization/transactional-mailer-job-deploy/staging-candidate',
      ),
    ).toBe('staging-candidate');
  });

  it('there is no local lane — a local-<namespace> stack is unknown and must fail closed', () => {
    // Local runtime của worker thuộc WIC container của
    // transactional-mail-deploy; project này không khai Docker resource nào.
    expect(
      classifyTransactionalMailerJobDeployStack(
        'organization/transactional-mailer-job-deploy/local-john',
      ),
    ).toBe('unknown');
  });

  it('any other slug is unknown and must fail closed', () => {
    expect(
      classifyTransactionalMailerJobDeployStack(
        'organization/transactional-mailer-job-deploy/prod',
      ),
    ).toBe('unknown');
    expect(classifyTransactionalMailerJobDeployStack('johndoe')).toBe('unknown');
  });
});

describe('isProvisionedDatabaseId', () => {
  it('accepts a non-placeholder UUID id', () => {
    expect(isProvisionedDatabaseId('0af52597-051b-4cba-90c9-e0f6ff6cd5d5')).toBe(true);
  });

  it('refuses the all-zeros placeholder and every malformed shape', () => {
    expect(isProvisionedDatabaseId(DATABASE_PLACEHOLDER_ID)).toBe(false);
    expect(isProvisionedDatabaseId('')).toBe(false);
    expect(isProvisionedDatabaseId('not-a-uuid')).toBe(false);
    expect(isProvisionedDatabaseId('0AF52597-051B-4CBA-90C9-E0F6FF6CD5D5')).toBe(false);
    expect(isProvisionedDatabaseId(`${'0'.repeat(31)}1`)).toBe(false);
  });
});

describe('readDatabaseId', () => {
  const selection = {
    environment: 'staging' as const,
    stackName: 'staging',
    fullStackRef: 'organization/transactional-mailer-job-deploy/staging',
    backendUrl: R2_BACKEND_URL,
  };

  it('reads stack output mailJobDatabaseId by full stack ref and returns a real id', () => {
    const { deps, calls } = recordingExec([
      execResult({ stdout: '0af52597-051b-4cba-90c9-e0f6ff6cd5d5\n' }),
    ]);
    expect(readDatabaseId('/tmp/pd', selection, {}, deps)).toBe(
      '0af52597-051b-4cba-90c9-e0f6ff6cd5d5',
    );
    expect(calls[0]?.args).toEqual([
      'stack',
      'output',
      'mailJobDatabaseId',
      '--stack',
      'organization/transactional-mailer-job-deploy/staging',
    ]);
  });

  it('a failing read yields undefined instead of failing a succeeded provision', () => {
    expect(
      readDatabaseId('/tmp/pd', selection, {}, recordingExec([execResult({ status: 1 })]).deps),
    ).toBeUndefined();
  });

  it('a placeholder-shaped output (all zeros) is refused as undefined, never surfaced as an id', () => {
    const { deps } = recordingExec([execResult({ stdout: `${DATABASE_PLACEHOLDER_ID}\n` })]);
    expect(readDatabaseId('/tmp/pd', selection, {}, deps)).toBeUndefined();
  });

  it('a malformed output yields undefined instead of a fabricated id', () => {
    const { deps } = recordingExec([execResult({ stdout: 'junk' })]);
    expect(readDatabaseId('/tmp/pd', selection, {}, deps)).toBeUndefined();
  });
});

describe('staging resource name constants', () => {
  it('names the staging D1 database per-lane, not the production name', () => {
    expect(STAGING_MAIL_JOB_DATABASE_NAME).toBe('stg-mail-job');
    expect(STAGING_MAIL_JOB_DATABASE_NAME).not.toBe('mail-job');
  });
});
