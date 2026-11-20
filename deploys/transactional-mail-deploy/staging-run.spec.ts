/**
 * Unit tests của engine staging (`staging-run.ts`) — pure functions + exec
 * inject, KHÔNG chạy Pulumi thật và KHÔNG đụng backend nào. Port của
 * `auth-deploy/staging-run.spec.ts` (#539) với refs của project này, thay
 * specs Hyperdrive bằng specs tài nguyên mail: hằng tên D1/queue per-lane
 * (#355), reader output `mailDatabaseId`, và việc guard phân loại riêng slot
 * `staging-candidate` để từ chối (tên tài nguyên slot `-cand` thuộc #381).
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  DATABASE_PLACEHOLDER_ID,
  STAGING_MAIL_DATABASE_NAME,
  STAGING_QUEUE_NAMES,
  appendStagingRecord,
  backendBucket,
  classifyTransactionalMailDeployStack,
  ensureStagingStack,
  isProvisionedDatabaseId,
  parseResourceChanges,
  parseStagingPhaseArg,
  r2AccountIdFromStateUrl,
  readDatabaseId,
  readStagingRevision,
  resolveStagingRunEnv,
  stagingEvidencePath,
  type StagingExecDeps,
  type StagingProvisioningRecord,
} from './staging-run.js';

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'staging-run-spec-'));
  cleanup.push(dir);
  return dir;
}

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
        const result = results[index] ?? execResult();
        index += 1;
        return result;
      },
    },
    calls,
  };
}

/** Backend R2 hình đúng tổ hợp (đủ endpoint/region/s3ForcePathStyle=true). */
const R2_BACKEND_URL =
  's3://ecoma-pulumi-staging?endpoint=https%3A%2F%2Ftest.r2.cloudflarestorage.com&region=auto&s3ForcePathStyle=true';

/** Env inventory đầy đủ — mỗi test tự bớt khóa để sát khe fail-closed. */
function fullSourceEnv(): NodeJS.ProcessEnv {
  return {
    ECOMA_PULUMI_STATE_URL_STAGING: R2_BACKEND_URL,
    PULUMI_CONFIG_PASSPHRASE: 'test-passphrase',
    AWS_ACCESS_KEY_ID: 'test-key',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
    CLOUDFLARE_API_TOKEN: 'test-cf-token',
  };
}

/** State URL hình đúng với endpoint R2 chỉ định — dùng cho khe parser account id. */
function stateUrlWithEndpoint(host: string): string {
  return `s3://ecoma-pulumi-staging?endpoint=${encodeURIComponent(`https://${host}`)}&region=auto&s3ForcePathStyle=true`;
}

function sampleRecord(
  overrides: Partial<StagingProvisioningRecord> = {},
): StagingProvisioningRecord {
  return {
    schemaVersion: 1,
    stackRef: 'organization/transactional-mail-deploy/staging',
    slot: 'staging',
    backendBucket: 'ecoma-pulumi-staging.r2.cloudflarestorage.com',
    gitSha: 'a'.repeat(40),
    phase: 'preview',
    revision: 7,
    resourceChanges: { same: 3 },
    outcome: 'succeeded',
    startedAt: '2026-11-20T01:02:03.000Z',
    finishedAt: '2026-11-20T01:02:04.000Z',
    ...overrides,
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

describe('resolveStagingRunEnv', () => {
  it('builds the child env from the full inventory and never carries the file-passphrase variant', () => {
    const { backendUrl, env } = resolveStagingRunEnv({
      ...fullSourceEnv(),
      PULUMI_CONFIG_PASSPHRASE_FILE: '/tmp/should-not-win',
    });
    expect(backendUrl).toBe(R2_BACKEND_URL);
    expect(env.PULUMI_BACKEND_URL).toBe(R2_BACKEND_URL);
    expect(env.PULUMI_CONFIG_PASSPHRASE).toBe('test-passphrase');
    expect(env.PULUMI_SKIP_UPDATE_CHECK).toBe('1');
    expect(env.PULUMI_CONFIG_PASSPHRASE_FILE).toBeUndefined();
    // Token Cloudflare là inventory bắt buộc (program khai D1/Queue #355) nhưng
    // vẫn env-only — không bao giờ vào provider config (state ghi lại config
    // provider, token thì không).
    expect(env.CLOUDFLARE_API_TOKEN).toBe('test-cf-token');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('test-secret');
  });

  it('allowlists the child env to the inventory keys plus PATH/HOME and never leaks an unrelated variable', () => {
    const { env } = resolveStagingRunEnv({
      ...fullSourceEnv(),
      PATH: '/usr/bin:/bin',
      HOME: '/home/operator',
      CLOUDFLARE_ACCOUNT_ID: 'decoy-account-id',
      GITHUB_TOKEN: 'decoy-github-token',
    });
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/operator');
    expect(env.ECOMA_PULUMI_STATE_URL_STAGING).toBe(R2_BACKEND_URL);
    expect(env.PULUMI_CONFIG_PASSPHRASE).toBe('test-passphrase');
    expect(env.AWS_ACCESS_KEY_ID).toBe('test-key');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('test-secret');
    expect(env.CLOUDFLARE_API_TOKEN).toBe('test-cf-token');
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    // Đủ chặt để mọi khóa lạ của môi trường operator bị cắt khỏi env con.
    expect(Object.keys(env).toSorted()).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'CLOUDFLARE_API_TOKEN',
      'ECOMA_PULUMI_STATE_URL_STAGING',
      'HOME',
      'PATH',
      'PULUMI_BACKEND_URL',
      'PULUMI_CONFIG_PASSPHRASE',
      'PULUMI_SKIP_UPDATE_CHECK',
    ]);
  });

  it('fails closed listing every missing key at once', () => {
    const source = fullSourceEnv();
    delete source.PULUMI_CONFIG_PASSPHRASE;
    delete source.AWS_ACCESS_KEY_ID;
    expect(() => resolveStagingRunEnv(source)).toThrow(
      /PULUMI_CONFIG_PASSPHRASE.*AWS_ACCESS_KEY_ID|AWS_ACCESS_KEY_ID.*PULUMI_CONFIG_PASSPHRASE/su,
    );
  });

  it('treats an empty string as a missing credential', () => {
    expect(() => resolveStagingRunEnv({ ...fullSourceEnv(), AWS_SECRET_ACCESS_KEY: '  ' })).toThrow(
      /AWS_SECRET_ACCESS_KEY/u,
    );
  });

  it('a missing Cloudflare token fails closed because the staging program consults the Cloudflare provider', () => {
    const source = fullSourceEnv();
    delete source.CLOUDFLARE_API_TOKEN;
    expect(() => resolveStagingRunEnv(source)).toThrow(/CLOUDFLARE_API_TOKEN/u);
  });

  it('a missing state URL means not bootstrapped and refuses without a fallback', () => {
    const source = fullSourceEnv();
    delete source.ECOMA_PULUMI_STATE_URL_STAGING;
    expect(() => resolveStagingRunEnv(source)).toThrow(
      /ECOMA_PULUMI_STATE_URL_STAGING.*#350|#350.*ECOMA_PULUMI_STATE_URL_STAGING/su,
    );
  });

  it('a file:// backend is rejected by the stack-backend pairing rule', () => {
    expect(() =>
      resolveStagingRunEnv({
        ...fullSourceEnv(),
        ECOMA_PULUMI_STATE_URL_STAGING: 'file:///tmp/some-local-state',
      }),
    ).toThrow(/staging.*requires an s3:\/\/ backend/su);
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

describe('ensureStagingStack', () => {
  const selection = {
    environment: 'staging' as const,
    stackName: 'staging',
    fullStackRef: 'organization/transactional-mail-deploy/staging',
    backendUrl: R2_BACKEND_URL,
  };

  it('a fresh stack init succeeds without a select fallback', () => {
    const { deps, calls } = recordingExec([execResult()]);
    ensureStagingStack('/tmp/pd', selection, {}, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['stack', 'init', 'staging']);
  });

  it('an existing stack falls back to select by full ref', () => {
    const { deps, calls } = recordingExec([
      execResult({ status: 1, stderr: 'already exists' }),
      execResult(),
    ]);
    ensureStagingStack('/tmp/pd', selection, {}, deps);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual([
      'stack',
      'select',
      'organization/transactional-mail-deploy/staging',
    ]);
  });

  it('both init and select failing throws with both stderr bodies', () => {
    const { deps } = recordingExec([
      execResult({ status: 1, stderr: 'init boom' }),
      execResult({ status: 1, stderr: 'select boom' }),
    ]);
    expect(() => ensureStagingStack('/tmp/pd', selection, {}, deps)).toThrow(
      /init boom[\s\S]*select boom/u,
    );
  });
});

describe('parseResourceChanges', () => {
  it('parses summary.resourceChanges from clean --json output', () => {
    const stdout = JSON.stringify({ summary: { resourceChanges: { create: 5, same: 2 } } });
    expect(parseResourceChanges(stdout)).toEqual({ create: 5, same: 2 });
  });

  it('parses the JSON object embedded after progress noise', () => {
    const stdout = `some progress line\n${JSON.stringify({ summary: { resourceChanges: { update: 1 } } })}`;
    expect(parseResourceChanges(stdout)).toEqual({ update: 1 });
  });

  it('returns undefined for malformed output instead of inventing counts', () => {
    expect(parseResourceChanges('not json at all')).toBeUndefined();
    expect(parseResourceChanges('{"summary":{}}')).toBeUndefined();
    expect(
      parseResourceChanges('{"summary":{"resourceChanges":{"same":"three"}}}'),
    ).toBeUndefined();
  });

  it('an empty change set is undefined, not a fabricated zero map', () => {
    expect(parseResourceChanges('{"summary":{"resourceChanges":{}}}')).toBeUndefined();
  });
});

describe('readStagingRevision', () => {
  const selection = {
    environment: 'staging' as const,
    stackName: 'staging',
    fullStackRef: 'organization/transactional-mail-deploy/staging',
    backendUrl: R2_BACKEND_URL,
  };

  it('takes the version of the newest history entry', () => {
    const { deps } = recordingExec([
      execResult({ status: 0, stdout: JSON.stringify([{ version: 12 }, { version: 11 }]) }),
    ]);
    expect(readStagingRevision('/tmp/pd', selection, {}, deps)).toBe(12);
    const { deps: deps2, calls } = recordingExec([]);
    readStagingRevision('/tmp/pd', selection, {}, deps2);
    expect(calls[0]?.args).toEqual([
      'stack',
      'history',
      '--json',
      '--stack',
      'organization/transactional-mail-deploy/staging',
    ]);
  });

  it('a failing or malformed history yields undefined instead of failing the run', () => {
    expect(
      readStagingRevision(
        '/tmp/pd',
        selection,
        {},
        recordingExec([execResult({ status: 1 })]).deps,
      ),
    ).toBeUndefined();
    expect(
      readStagingRevision(
        '/tmp/pd',
        selection,
        {},
        recordingExec([execResult({ stdout: 'junk' })]).deps,
      ),
    ).toBeUndefined();
  });
});

describe('appendStagingRecord', () => {
  it('writes one new JSON file per run into the evidence dir and never overwrites', () => {
    const projectDir = tempProjectDir();
    const first = appendStagingRecord(projectDir, sampleRecord());
    const second = appendStagingRecord(
      projectDir,
      sampleRecord({ phase: 'up', outcome: 'failed' }),
    );
    expect(first).not.toBe(second);
    const files = readdirSync(join(projectDir, '.staging-evidence')).toSorted();
    expect(files).toHaveLength(2);
    const parsed = JSON.parse(readFileSync(second, 'utf8')) as StagingProvisioningRecord;
    expect(parsed).toMatchObject({ schemaVersion: 1, phase: 'up', outcome: 'failed', revision: 7 });
  });
});

describe('stagingEvidencePath', () => {
  it('extracts the evidence path from a failed-run error and refuses every other shape', () => {
    const failed = Object.assign(new Error('staging up failed'), {
      recordPath: '/tmp/r.json',
    });
    expect(stagingEvidencePath(failed)).toBe('/tmp/r.json');
    expect(stagingEvidencePath(new Error('no path attached'))).toBeUndefined();
    expect(stagingEvidencePath('not an error')).toBeUndefined();
    expect(stagingEvidencePath({ recordPath: 42 })).toBeUndefined();
  });
});

describe('backendBucket', () => {
  it('reduces the backend URL to its bucket authority and drops credentials in the query', () => {
    // Trong `s3://<bucket>?endpoint=...`, bucket là authority của URL —
    // endpoint R2 thật nằm ở query parameter, không phải host.
    expect(backendBucket(R2_BACKEND_URL)).toBe('ecoma-pulumi-staging');
    expect(backendBucket(R2_BACKEND_URL)).not.toContain('endpoint');
  });
});

describe('parseStagingPhaseArg', () => {
  it('accepts exactly preview and up', () => {
    expect(parseStagingPhaseArg(['preview'])).toEqual({ kind: 'ok', phase: 'preview' });
    expect(parseStagingPhaseArg(['up'])).toEqual({ kind: 'ok', phase: 'up' });
  });

  it('refuses down and destroy with the verb named', () => {
    expect(parseStagingPhaseArg(['down'])).toEqual({ kind: 'refused', verb: 'down' });
    expect(parseStagingPhaseArg(['destroy'])).toEqual({ kind: 'refused', verb: 'destroy' });
  });

  it('a missing argument is a usage error, not an assumed preview', () => {
    expect(parseStagingPhaseArg([])).toEqual({ kind: 'missing' });
  });
});

describe('r2AccountIdFromStateUrl', () => {
  it('takes the account id from the R2 path-style endpoint host (04 R22)', () => {
    expect(
      r2AccountIdFromStateUrl(
        stateUrlWithEndpoint('a1b2c3d4e5f60718293a4b5c6d7e8f90.r2.cloudflarestorage.com'),
      ),
    ).toBe('a1b2c3d4e5f60718293a4b5c6d7e8f90');
  });

  it('drops the jurisdiction prefix labels, which are not part of the account id', () => {
    expect(
      r2AccountIdFromStateUrl(stateUrlWithEndpoint('eu.a1b2c3d4.r2.cloudflarestorage.com')),
    ).toBe('a1b2c3d4');
    expect(
      r2AccountIdFromStateUrl(stateUrlWithEndpoint('fedramp.a1b2c3d4.r2.cloudflarestorage.com')),
    ).toBe('a1b2c3d4');
  });

  it('a missing endpoint query parameter refuses instead of guessing', () => {
    expect(() =>
      r2AccountIdFromStateUrl('s3://ecoma-pulumi-staging?region=auto&s3ForcePathStyle=true'),
    ).toThrow(/endpoint/u);
  });

  it('a non-R2 endpoint refuses with the R22 shape named', () => {
    expect(() => r2AccountIdFromStateUrl(stateUrlWithEndpoint('s3.amazonaws.com'))).toThrow(
      /R2 path-style endpoint/u,
    );
  });

  it('a malformed state URL refuses', () => {
    expect(() => r2AccountIdFromStateUrl('not a url')).toThrow(/valid staging state URL/u);
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
