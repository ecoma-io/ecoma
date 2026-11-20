/**
 * Unit tests của engine staging (`staging-run.ts`) — pure functions + exec
 * inject, KHÔNG chạy Pulumi thật và KHÔNG đụng backend nào. Port thu gọn của
 * `transactional-mail-deploy/staging-run.spec.ts` (#355): không có lane local
 * (classify từ chối cả `local-*`), tài nguyên duy nhất là D1 `stg-mail-job`.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  DATABASE_PLACEHOLDER_ID,
  STAGING_MAIL_JOB_DATABASE_NAME,
  appendStagingRecord,
  backendBucket,
  classifyTransactionalMailerJobDeployStack,
  ensureStagingStack,
  isProvisionedDatabaseId,
  parseResourceChanges,
  parseStagingPhaseArg,
  r2AccountIdFromStateUrl,
  readDatabaseId,
  resolveStagingRunEnv,
  runStagingPhase,
  stagingEvidencePath,
  type StagingExecDeps,
  type StagingProvisioningRecord,
} from './staging-run.js';

// `runStagingPhase` dùng `pulumiRun` thật của lib — mock RIÊNG nó thành vi.fn
// (mặc định throw để spec lỗi phase không đụng Pulumi thật; test đường thành
// công ghi đè implementation qua `pulumiRunMock.mockImplementationOnce`).
// `deployProjectDir` trỏ về tmpdir của spec (engine ghi evidence theo
// projectDir). Mọi export khác giữ nguyên. vi.mock được hoist lên đầu module
// bởi vitest nên đứng sau import là đúng.
const { pulumiRunMock } = vi.hoisted(() => ({
  pulumiRunMock: vi.fn<() => string>(() => {
    throw new Error('pulumi up failed: simulated phase error');
  }),
}));
vi.mock('@ecoma-io/deployment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ecoma-io/deployment')>()),
  pulumiRun: pulumiRunMock,
  deployProjectDir: (project: string) => join(tmpdir(), `staging-run-spec-${project}`),
}));

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
    stackRef: 'organization/transactional-mailer-job-deploy/staging',
    slot: 'staging',
    backendBucket: 'ecoma-pulumi-staging.r2.cloudflarestorage.com',
    gitSha: 'a'.repeat(40),
    phase: 'preview',
    revision: 7,
    resourceChanges: { create: 1 },
    outcome: 'succeeded',
    startedAt: '2026-11-20T01:02:03.000Z',
    finishedAt: '2026-11-20T01:02:04.000Z',
    ...overrides,
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
    // Token Cloudflare là inventory bắt buộc (program khai D1Database #355)
    // nhưng vẫn env-only — không bao giờ vào provider config (state ghi lại
    // config provider, token thì không).
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

describe('ensureStagingStack', () => {
  const selection = {
    environment: 'staging' as const,
    stackName: 'staging',
    fullStackRef: 'organization/transactional-mailer-job-deploy/staging',
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
      'organization/transactional-mailer-job-deploy/staging',
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
    const stdout = JSON.stringify({ summary: { resourceChanges: { create: 1 } } });
    expect(parseResourceChanges(stdout)).toEqual({ create: 1 });
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
    expect(parsed).toMatchObject({ schemaVersion: 1, phase: 'up', outcome: 'failed' });
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
    expect(STAGING_MAIL_JOB_DATABASE_NAME).toBe('stg-mail-job');
    expect(STAGING_MAIL_JOB_DATABASE_NAME).not.toBe('mail-job');
  });
});

describe('runStagingPhase', () => {
  it('a failed phase keeps the original provisioning error even when writing the evidence record fails', () => {
    // Cùng tmpdir mà `deployProjectDir` (mocked) trả về — engine ghi evidence
    // theo projectDir, không theo cwd của spec.
    const projectDir = join(tmpdir(), 'staging-run-spec-transactional-mailer-job-deploy');
    cleanup.push(projectDir);
    mkdirSync(projectDir, { recursive: true });
    // `.staging-evidence` là FILE (không phải thư mục) — mkdirSync của
    // `appendStagingRecord` ném EEXIST, mô phỏng disk-full/quyền hạn.
    writeFileSync(join(projectDir, '.staging-evidence'), 'not a dir');
    const deps: StagingExecDeps = { execFn: () => execResult() };
    // Lỗi gốc của phase phải được ném lại nguyên văn — KHÔNG phải EEXIST của
    // lần ghi evidence.
    expect(() =>
      runStagingPhase('up', 'transactional-mailer-job-deploy', fullSourceEnv(), deps),
    ).toThrow(/pulumi up failed: simulated phase error/u);
    expect(() =>
      runStagingPhase('up', 'transactional-mailer-job-deploy', fullSourceEnv(), deps),
    ).toThrow(/staging up failed on organization\/transactional-mailer-job-deploy\/staging/u);
    expect(() =>
      runStagingPhase('up', 'transactional-mailer-job-deploy', fullSourceEnv(), deps),
    ).not.toThrow(/evidence/u);
  });

  it('a succeeded phase stays succeeded even when writing the evidence record fails', () => {
    // Đối xứng test thất bại ngay trên: ghi evidence không được che mất một
    // provisioning THÀNH CÔNG — throw của evidence chỉ làm mất record path.
    const projectDir = join(tmpdir(), 'staging-run-spec-transactional-mailer-job-deploy');
    cleanup.push(projectDir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, '.staging-evidence'), 'not a dir');
    pulumiRunMock.mockImplementationOnce(() => '{"summary":{"resourceChanges":{"create":1}}}');
    const deps: StagingExecDeps = { execFn: () => execResult() };
    const outcome = runStagingPhase('up', 'transactional-mailer-job-deploy', fullSourceEnv(), deps);
    expect(outcome.record.outcome).toBe('succeeded');
    expect(outcome.record.resourceChanges).toEqual({ create: 1 });
    expect(outcome.recordPath).toBe('');
  });
});
