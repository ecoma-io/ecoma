/**
 * Unit tests PER-UNIT của `staging-run.ts` — phần riêng của unit
 * `transactional-mail` (#355): classify lane (guard riêng slot
 * `staging-candidate`), hằng tên D1/queue per-lane và wrapper reader output
 * `mailDatabaseId`. Các test dùng chung của engine (inventory env, ensureStack,
 * parsers, evidence, runStagingPhase…) đã dồn về
 * `libs/deployment/src/staging-run.spec.ts` (#543).
 */

import { describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  DATABASE_PLACEHOLDER_ID,
  STAGING_MAIL_DATABASE_NAME,
  STAGING_QUEUE_NAMES,
  classifyTransactionalMailDeployStack,
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

describe('classifyTransactionalMailDeployStack', () => {
  it('local namespace slug routes to the local lane', () => {
    expect(
      classifyTransactionalMailDeployStack('organization/transactional-mail-deploy/local-john'),
    ).toBe('local');
  });

  it('the continuous staging slug routes to the staging lane', () => {
    expect(
      classifyTransactionalMailDeployStack('organization/transactional-mail-deploy/staging'),
    ).toBe('staging');
  });

  it('the staging-candidate slug is recognized on its own so the guard can refuse it (#381)', () => {
    // Khác pilot auth-deploy (route chung): slot candidate phải RÕ RÀNG là
    // refused ở guard — chạy chương trình continuous trên đó là collision tên
    // D1/Queue account-unique.
    expect(
      classifyTransactionalMailDeployStack(
        'organization/transactional-mail-deploy/staging-candidate',
      ),
    ).toBe('staging-candidate');
  });

  it('a bare local word without the local- prefix is unknown', () => {
    expect(
      classifyTransactionalMailDeployStack('organization/transactional-mail-deploy/local'),
    ).toBe('unknown');
  });

  it('any other slug is unknown and must fail closed', () => {
    expect(
      classifyTransactionalMailDeployStack('organization/transactional-mail-deploy/prod'),
    ).toBe('unknown');
    expect(classifyTransactionalMailDeployStack('johndoe')).toBe('unknown');
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
    fullStackRef: 'organization/transactional-mail-deploy/staging',
    backendUrl: R2_BACKEND_URL,
  };

  it('reads stack output mailDatabaseId by full stack ref and returns a real id', () => {
    const { deps, calls } = recordingExec([
      execResult({ stdout: '0af52597-051b-4cba-90c9-e0f6ff6cd5d5\n' }),
    ]);
    expect(readDatabaseId('/tmp/pd', selection, {}, deps)).toBe(
      '0af52597-051b-4cba-90c9-e0f6ff6cd5d5',
    );
    expect(calls[0]?.args).toEqual([
      'stack',
      'output',
      'mailDatabaseId',
      '--stack',
      'organization/transactional-mail-deploy/staging',
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
    expect(STAGING_MAIL_DATABASE_NAME).toBe('stg-mail');
    expect(STAGING_MAIL_DATABASE_NAME).not.toBe('mail');
  });

  it('declares the full four-queue chain with the stg- prefix and a DLQ per producer queue', () => {
    expect(STAGING_QUEUE_NAMES).toEqual([
      'stg-ecoma-mail-delivery',
      'stg-ecoma-mail-delivery-dlq',
      'stg-ecoma-mail-lifecycle-events',
      'stg-ecoma-mail-lifecycle-events-dlq',
    ]);
    for (const name of STAGING_QUEUE_NAMES) {
      expect(name.startsWith('stg-')).toBe(true);
    }
    expect(STAGING_QUEUE_NAMES[1]).toBe(`${STAGING_QUEUE_NAMES[0]}-dlq`);
    expect(STAGING_QUEUE_NAMES[3]).toBe(`${STAGING_QUEUE_NAMES[2]}-dlq`);
  });
});
