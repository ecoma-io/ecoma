/**
 * Unit tests của engine staging dùng chung (`staging-run.ts`) — pure functions
 * + exec inject, KHÔNG chạy Pulumi thật và KHÔNG đụng backend nào. Hợp nhất
 * 12 bản spec per-unit (issue #543): mọi assertion của các bản copy được port
 * nguyên vẹn (không làm yếu), phần per-unit (hằng tên tài nguyên, classify
 * mapping riêng) thuộc spec của từng deploy project giữ lại ở đó.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ExecResult } from './pulumi-context.js';

import {
  RESOURCE_PLACEHOLDER_ID,
  STAGING_SLOT,
  appendStagingRecord,
  backendBucket,
  classifyDeployStackRef,
  ensureStagingStack,
  isProvisionedResourceId,
  parseResourceChanges,
  parseStagingPhaseArg,
  r2AccountIdFromStateUrl,
  readGitHeadSha,
  readStackOutputId,
  readStagingRevision,
  resolveStagingHyperdriveOrigin,
  resolveStagingRunEnv,
  runStagingPhase,
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
        // Quá số kết quả giả là lỗi test, KHÔNG phải thành công ngầm: lệnh
        // Pulumi mới thêm vào engine mà spec chưa cập nhật phải làm test ĐỎ,
        // không được lặng lẽ nhận execResult() status 0 (OCR round 3).
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
    stackRef: 'organization/test-deploy/staging',
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

describe('classifyDeployStackRef', () => {
  it('local namespace slug routes to the local lane', () => {
    expect(classifyDeployStackRef('organization/test-deploy/local-john')).toBe('local');
  });

  it('the continuous staging slug routes to the staging lane', () => {
    expect(classifyDeployStackRef('organization/test-deploy/staging')).toBe('staging');
  });

  it('the staging-candidate slug is recognized on its own so the guard can refuse it (#381)', () => {
    expect(classifyDeployStackRef('organization/test-deploy/staging-candidate')).toBe(
      'staging-candidate',
    );
  });

  it('a bare local word without the local- prefix is unknown', () => {
    expect(classifyDeployStackRef('organization/test-deploy/local')).toBe('unknown');
  });

  it('any other slug is unknown and must fail closed', () => {
    expect(classifyDeployStackRef('organization/test-deploy/prod')).toBe('unknown');
    expect(classifyDeployStackRef('johndoe')).toBe('unknown');
  });
});

describe('resolveStagingRunEnv', () => {
  it('builds the child env from the full inventory and never carries the file-passphrase variant', () => {
    const { backendUrl, env } = resolveStagingRunEnv('test-deploy', {
      ...fullSourceEnv(),
      PULUMI_CONFIG_PASSPHRASE_FILE: '/tmp/should-not-win',
    });
    expect(backendUrl).toBe(R2_BACKEND_URL);
    expect(env.PULUMI_BACKEND_URL).toBe(R2_BACKEND_URL);
    expect(env.PULUMI_CONFIG_PASSPHRASE).toBe('test-passphrase');
    expect(env.PULUMI_SKIP_UPDATE_CHECK).toBe('1');
    expect(env.PULUMI_CONFIG_PASSPHRASE_FILE).toBeUndefined();
    // Token Cloudflare là inventory bắt buộc (program staging khai resource
    // Cloudflare) nhưng vẫn env-only — không bao giờ vào provider config (state
    // ghi lại config provider, token thì không).
    expect(env.CLOUDFLARE_API_TOKEN).toBe('test-cf-token');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('test-secret');
  });

  it('allowlists the child env to the inventory keys plus PATH/HOME and never leaks an unrelated variable', () => {
    const { env } = resolveStagingRunEnv('test-deploy', {
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
    // Đủ chặt để mọi khóa lạ của môi trường operator bị cắt khỏi env con
    // (decoy spec: biến lạ trong source env không lọt vào env con).
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

  it('falls back PATH/HOME to process.env when the source env lacks them instead of spawning with undefined', () => {
    // OCR round 5: env thiếu PATH/HOME không được biến thành spawn ENOENT khó
    // chẩn đoán — fallback về process.env cho đúng hai khóa đó.
    const source = fullSourceEnv();
    delete source.PATH;
    delete source.HOME;
    const { env } = resolveStagingRunEnv('test-deploy', source);
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('fails closed listing every missing key at once', () => {
    const source = fullSourceEnv();
    delete source.PULUMI_CONFIG_PASSPHRASE;
    delete source.AWS_ACCESS_KEY_ID;
    expect(() => resolveStagingRunEnv('test-deploy', source)).toThrow(
      /PULUMI_CONFIG_PASSPHRASE.*AWS_ACCESS_KEY_ID|AWS_ACCESS_KEY_ID.*PULUMI_CONFIG_PASSPHRASE/su,
    );
  });

  it('treats an empty string as a missing credential', () => {
    expect(() =>
      resolveStagingRunEnv('test-deploy', { ...fullSourceEnv(), AWS_SECRET_ACCESS_KEY: '  ' }),
    ).toThrow(/AWS_SECRET_ACCESS_KEY/u);
  });

  it('a missing Cloudflare token fails closed because the staging program consults the Cloudflare provider', () => {
    const source = fullSourceEnv();
    delete source.CLOUDFLARE_API_TOKEN;
    expect(() => resolveStagingRunEnv('test-deploy', source)).toThrow(/CLOUDFLARE_API_TOKEN/u);
  });

  it('a missing state URL means not bootstrapped and refuses without a fallback', () => {
    const source = fullSourceEnv();
    delete source.ECOMA_PULUMI_STATE_URL_STAGING;
    expect(() => resolveStagingRunEnv('test-deploy', source)).toThrow(
      /ECOMA_PULUMI_STATE_URL_STAGING.*(not bootstrapped|fall back)/su,
    );
  });

  it('a file:// backend is rejected by the stack-backend pairing rule', () => {
    expect(() =>
      resolveStagingRunEnv('test-deploy', {
        ...fullSourceEnv(),
        ECOMA_PULUMI_STATE_URL_STAGING: 'file:///tmp/some-local-state',
      }),
    ).toThrow(/staging.*requires an s3:\/\/ backend/su);
  });

  it('returns the adapter selection so a run never consults stackSelection twice', () => {
    // OCR round 2: selection cấp ngay trong `resolveStagingRunEnv` — caller
    // (`runStagingPhase`) dùng lại, không gọi adapter lần hai.
    const { selection } = resolveStagingRunEnv('test-deploy', fullSourceEnv());
    expect(selection.environment).toBe('staging');
    expect(selection.stackName).toBe('staging');
    expect(selection.backendUrl).toBe(R2_BACKEND_URL);
    expect(selection.fullStackRef).toBe('organization/test-deploy/staging');
  });
});

describe('resolveStagingHyperdriveOrigin', () => {
  it('fails closed naming every missing origin key and issue #349 when the tunnel is not provisioned', () => {
    expect(() =>
      resolveStagingHyperdriveOrigin(
        { originHost: undefined, originPort: undefined, originPassword: undefined },
        'db-test',
        'ecoma_test_runtime',
        'test-deploy',
      ),
    ).toThrow(/namespace:originHost.*namespace:originPassword[\s\S]*#349/su);
  });

  it('an empty host counts as missing, not as a value', () => {
    expect(() =>
      resolveStagingHyperdriveOrigin(
        { originHost: '  ', originPort: undefined, originPassword: 'pw' },
        'db-test',
        'ecoma_test_runtime',
        'test-deploy',
      ),
    ).toThrow(/namespace:originHost/su);
  });

  it('defaults a missing port to 5432 and keeps the per-database identity parameters', () => {
    const origin = resolveStagingHyperdriveOrigin(
      {
        originHost: 'db-test-staging.ecoma.internal',
        originPort: undefined,
        originPassword: 'origin-password-sentinel',
      },
      'db-test',
      'ecoma_test_runtime',
      'test-deploy',
    );
    expect(origin.host).toBe('db-test-staging.ecoma.internal');
    expect(origin.port).toBe(5432);
    expect(origin.database).toBe('db-test');
    expect(origin.user).toBe('ecoma_test_runtime');
    expect(origin.scheme).toBe('postgres');
    expect(origin.password).toBe('origin-password-sentinel');
  });

  it('accepts an explicit port and refuses a non-numeric or out-of-range one', () => {
    expect(
      resolveStagingHyperdriveOrigin(
        { originHost: 'h', originPort: ' 6543 ', originPassword: 'pw' },
        'db-test',
        'ecoma_test_runtime',
        'test-deploy',
      ).port,
    ).toBe(6543);
    expect(() =>
      resolveStagingHyperdriveOrigin(
        { originHost: 'h', originPort: 'postgres', originPassword: 'pw' },
        'db-test',
        'ecoma_test_runtime',
        'test-deploy',
      ),
    ).toThrow(/origin port/su);
    expect(() =>
      resolveStagingHyperdriveOrigin(
        { originHost: 'h', originPort: '70000', originPassword: 'pw' },
        'db-test',
        'ecoma_test_runtime',
        'test-deploy',
      ),
    ).toThrow(/origin port/su);
  });

  it('an empty or whitespace-only password counts as missing, same as the host', () => {
    expect(() =>
      resolveStagingHyperdriveOrigin(
        { originHost: 'h', originPort: undefined, originPassword: '   ' },
        'db-test',
        'ecoma_test_runtime',
        'test-deploy',
      ),
    ).toThrow(/namespace:originPassword/su);
  });
});

describe('isProvisionedResourceId', () => {
  it('accepts a non-placeholder UUID id', () => {
    expect(isProvisionedResourceId('0af52597-051b-4cba-90c9-e0f6ff6cd5d5')).toBe(true);
  });

  it('refuses the all-zeros placeholder and every malformed shape', () => {
    expect(isProvisionedResourceId(RESOURCE_PLACEHOLDER_ID)).toBe(false);
    expect(isProvisionedResourceId('')).toBe(false);
    expect(isProvisionedResourceId('not-a-uuid')).toBe(false);
    expect(isProvisionedResourceId('0AF52597-051B-4CBA-90C9-E0F6FF6CD5D5')).toBe(false);
    expect(isProvisionedResourceId(`${'0'.repeat(31)}1`)).toBe(false);
  });
});

describe('readStackOutputId', () => {
  const selection = {
    environment: 'staging' as const,
    stackName: 'staging',
    fullStackRef: 'organization/test-deploy/staging',
    backendUrl: R2_BACKEND_URL,
  };

  it('reads a stack output id by full stack ref and returns a real id', () => {
    const { deps, calls } = recordingExec([
      execResult({ stdout: '0af52597-051b-4cba-90c9-e0f6ff6cd5d5\n' }),
    ]);
    expect(readStackOutputId('hyperdriveConfigId', '/tmp/pd', selection, {}, deps)).toBe(
      '0af52597-051b-4cba-90c9-e0f6ff6cd5d5',
    );
    expect(calls[0]?.args).toEqual([
      'stack',
      'output',
      'hyperdriveConfigId',
      '--stack',
      'organization/test-deploy/staging',
    ]);
  });

  it('reads a per-target output name unchanged (llm pattern `<target>HyperdriveConfigId`)', () => {
    const { deps, calls } = recordingExec([execResult()]);
    readStackOutputId('gatewayHyperdriveConfigId', '/tmp/pd', selection, {}, deps);
    expect(calls[0]?.args).toContain('gatewayHyperdriveConfigId');
  });

  it('a failing read yields undefined instead of failing a succeeded provision', () => {
    expect(
      readStackOutputId(
        'mailDatabaseId',
        '/tmp/pd',
        selection,
        {},
        recordingExec([execResult({ status: 1 })]).deps,
      ),
    ).toBeUndefined();
  });

  it('a placeholder-shaped output (all zeros) is refused as undefined, never surfaced as an id', () => {
    const { deps } = recordingExec([execResult({ stdout: `${RESOURCE_PLACEHOLDER_ID}\n` })]);
    expect(readStackOutputId('hyperdriveConfigId', '/tmp/pd', selection, {}, deps)).toBeUndefined();
  });

  it('a malformed output yields undefined instead of a fabricated id', () => {
    const { deps } = recordingExec([execResult({ stdout: 'junk' })]);
    expect(readStackOutputId('hyperdriveConfigId', '/tmp/pd', selection, {}, deps)).toBeUndefined();
  });
});

describe('ensureStagingStack', () => {
  const selection = {
    environment: 'staging' as const,
    stackName: 'staging',
    fullStackRef: 'organization/test-deploy/staging',
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
    expect(calls[1]?.args).toEqual(['stack', 'select', 'organization/test-deploy/staging']);
  });

  it('an init failure without an already-exists stderr fails loudly instead of a select fallback', () => {
    // OCR round 3: lỗi thật của `stack init` (mạng/backend/credential) không
    // được che giấu bởi một lần `stack select` thành công trên stack trùng tên.
    const { deps, calls } = recordingExec([execResult({ status: 1, stderr: 'network boom' })]);
    expect(() => ensureStagingStack('/tmp/pd', selection, {}, deps)).toThrow(/network boom/u);
    expect(calls).toHaveLength(1);
  });

  it('an init failure with a non-string stderr throws with the raw value instead of coercing it', () => {
    // OCR round 4: `RegExp.test(undefined)` ép kiểu thành "undefined" — guard
    // typeof phải giữ nguyên giá trị thô trong message lỗi.
    const { deps, calls } = recordingExec([
      { status: 1, stdout: '', stderr: undefined } as unknown as ExecResult,
    ]);
    expect(() => ensureStagingStack('/tmp/pd', selection, {}, deps)).toThrow(/undefined/u);
    expect(calls).toHaveLength(1);
  });

  it('both init and select failing throws with both stderr bodies', () => {
    const { deps, calls } = recordingExec([
      execResult({ status: 1, stderr: 'already exists but select also fails' }),
      execResult({ status: 1, stderr: 'select boom' }),
    ]);
    expect(() => ensureStagingStack('/tmp/pd', selection, {}, deps)).toThrow(
      /already exists[\s\S]*select boom/u,
    );
    expect(calls).toHaveLength(2);
  });
});

describe('parseResourceChanges', () => {
  it('parses summary.resourceChanges from clean --json output', () => {
    const stdout = JSON.stringify({ summary: { resourceChanges: { create: 2, same: 5 } } });
    expect(parseResourceChanges(stdout)).toEqual({ create: 2, same: 5 });
  });

  it('parses the JSON object embedded after progress noise', () => {
    const stdout = `some progress line\n${JSON.stringify({ summary: { resourceChanges: { update: 1 } } })}`;
    expect(parseResourceChanges(stdout)).toEqual({ update: 1 });
  });

  it('parses the JSON object even when progress noise itself contains a brace', () => {
    // OCR round 5: parse thử từng vị trí `{` — dòng noise chứa `{` không được
    // làm mất resourceChanges.
    const stdout = `progress {"partial":\n${JSON.stringify({ summary: { resourceChanges: { same: 4 } } })}`;
    expect(parseResourceChanges(stdout)).toEqual({ same: 4 });
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
    fullStackRef: 'organization/test-deploy/staging',
    backendUrl: R2_BACKEND_URL,
  };

  it('takes the version of the newest history entry', () => {
    const { deps } = recordingExec([
      execResult({ status: 0, stdout: JSON.stringify([{ version: 12 }, { version: 11 }]) }),
    ]);
    expect(readStagingRevision('/tmp/pd', selection, {}, deps)).toBe(12);
    const { deps: deps2, calls } = recordingExec([execResult()]);
    readStagingRevision('/tmp/pd', selection, {}, deps2);
    expect(calls[0]?.args).toEqual([
      'stack',
      'history',
      '--json',
      '--stack',
      'organization/test-deploy/staging',
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

  it('two records sharing the same millisecond, phase and outcome never overwrite each other', () => {
    // OCR round 5: hậu tố suffix phân biệt filename — cùng mili-giây vẫn là
    // hai file, hợp đồng append-only không có ngoại lệ.
    const projectDir = tempProjectDir();
    const startedAt = '2026-11-20T01:02:03.000Z';
    const first = appendStagingRecord(projectDir, sampleRecord({ startedAt }));
    const second = appendStagingRecord(projectDir, sampleRecord({ startedAt }));
    expect(first).not.toBe(second);
    expect(readdirSync(join(projectDir, '.staging-evidence'))).toHaveLength(2);
  });
});

describe('readGitHeadSha', () => {
  it('runs git with the PATH/HOME of the injected source env, never unrelated variables', () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const deps: StagingExecDeps = {
      execFn: (_command, _args, _cwd, env) => {
        capturedEnv = env;
        return execResult({ stdout: `${'a'.repeat(40)}\n` });
      },
    };
    const sha = readGitHeadSha('/tmp/pd', { PATH: '/injected/bin', HOME: '/injected/home' }, deps);
    expect(sha).toBe('a'.repeat(40));
    expect(capturedEnv).toEqual({ PATH: '/injected/bin', HOME: '/injected/home' });
  });

  it('falls back PATH/HOME to process.env when the injected source env lacks them', () => {
    // OCR round 5: cùng fallback với env Pulumi — git phải chạy được, không
    // chết spawn với PATH undefined.
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const deps: StagingExecDeps = {
      execFn: (_command, _args, _cwd, env) => {
        capturedEnv = env;
        return execResult({ stdout: `${'a'.repeat(40)}\n` });
      },
    };
    readGitHeadSha('/tmp/pd', {}, deps);
    expect(capturedEnv?.PATH).toBe(process.env.PATH);
    expect(capturedEnv?.HOME).toBe(process.env.HOME);
  });

  it('a failing or non-SHA output yields undefined instead of a fabricated sha', () => {
    const failing: StagingExecDeps = {
      execFn: () => execResult({ status: 1 }),
    };
    expect(readGitHeadSha('/tmp/pd', {}, failing)).toBeUndefined();
    const junk: StagingExecDeps = {
      execFn: () => execResult({ stdout: 'not-a-sha' }),
    };
    expect(readGitHeadSha('/tmp/pd', {}, junk)).toBeUndefined();
  });
});

describe('stagingEvidencePath', () => {
  it('surfaces the recordPath a failed runStagingPhase attaches and ignores other errors', () => {
    expect(stagingEvidencePath(Object.assign(new Error('x'), { recordPath: '/tmp/r.json' }))).toBe(
      '/tmp/r.json',
    );
    expect(stagingEvidencePath(new Error('no path'))).toBeUndefined();
    expect(stagingEvidencePath('boom')).toBeUndefined();
    expect(
      stagingEvidencePath(Object.assign(new Error('x'), { recordPath: undefined })),
    ).toBeUndefined();
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

  it('strips any number of intermediate labels by contract, taking the last label as the account id', () => {
    // OCR round 3: hành vi là TƯỜNG MINH — mọi nhãn phía trước account id đều
    // bị bỏ (không đoán ý nghĩa từng nhãn). Endpoint R22 hiện tại chỉ có một
    // tiền tố jurisdiction, nhưng contract là "nhãn cuối trước suffix là
    // account id"; test này ghim đúng hành vi đó để một format nhãn mới của R2
    // chỉ được thêm vào khi thay đổi hàm một cách tường minh.
    expect(
      r2AccountIdFromStateUrl(stateUrlWithEndpoint('custom-region.acct.r2.cloudflarestorage.com')),
    ).toBe('acct');
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

// `pulumiRun`/`deployProjectDir` được inject qua deps (spec không đụng
// Pulumi thật, evidence ghi vào tmpdir của spec) — không cần mock module.
function stagingDeps(projectDir: string, pulumiRun: () => string): StagingExecDeps {
  return {
    execFn: () => execResult(),
    projectDirFn: () => projectDir,
    pulumiRunFn: () => pulumiRun(),
  };
}

describe('runStagingPhase', () => {
  it('a failed phase keeps the original provisioning error even when writing the evidence record fails', () => {
    // OCR round 4: lỗi gốc phải unwrap được qua `cause` (ES2022) — message gộp
    // là cho operator, caller phân loại lỗi theo lỗi Pulumi gốc.
    const dir = tempProjectDir();
    // Evidence write phải THẤT BẠI: `.staging-evidence` bị thay bằng một FILE
    // thường — `mkdirSync(recursive)` ném EEXIST (không tạo được thư mục trên
    // đường dẫn đã là file), bị catch vào `catch (recordError)` và giữ nguyên
    // lỗi Pulumi qua `cause`.
    writeFileSync(join(dir, '.staging-evidence'), 'not a directory', 'utf8');
    const thrown = (() => {
      try {
        runStagingPhase(
          'preview',
          'test-deploy',
          { ...fullSourceEnv(), PATH: '/injected/bin', HOME: '/injected/home' },
          stagingDeps(dir, () => {
            throw new Error('pulumi up boom');
          }),
        );
        return undefined;
      } catch (error) {
        return error as Error & { cause?: unknown };
      }
    })();
    expect(thrown?.message).toMatch(/pulumi up boom[\s\S]*evidence write failed/u);
    expect(thrown?.cause).toBeInstanceOf(Error);
    expect((thrown?.cause as Error | undefined)?.message).toBe('pulumi up boom');
  });

  it('a succeeded phase stays succeeded even when writing the evidence record fails', () => {
    // Đối xứng test thất bại ngay trên: ghi evidence không được che mất một
    // provisioning THÀNH CÔNG — throw của evidence chỉ làm mất record path.
    const dir = tempProjectDir();
    writeFileSync(join(dir, '.staging-evidence'), 'not a directory', 'utf8');
    const outcome = runStagingPhase(
      'up',
      'test-deploy',
      { ...fullSourceEnv(), PATH: '/injected/bin', HOME: '/injected/home' },
      stagingDeps(dir, () => '{"summary":{"resourceChanges":{"create":5}}}'),
    );
    expect(outcome.record.outcome).toBe('succeeded');
    expect(outcome.record.resourceChanges).toEqual({ create: 5 });
    expect(outcome.recordPath).toBe('');
  });

  it('returns the resolved env, selection and projectDir so the entry never re-resolves them', () => {
    // OCR round 2: `runStagingPhase` trả kèm selection + env + projectDir —
    // entry dùng lại đúng inventory của lần phase vừa chạy cho bước đọc output
    // id sau `up`, không gọi adapter/deployProjectDir lần hai.
    const dir = tempProjectDir();
    const outcome = runStagingPhase(
      'up',
      'test-deploy',
      { ...fullSourceEnv(), PATH: '/injected/bin', HOME: '/injected/home' },
      stagingDeps(dir, () => '{"summary":{"resourceChanges":{"create":5}}}'),
    );
    expect(outcome.projectDir).toBe(dir);
    expect(outcome.selection.environment).toBe('staging');
    expect(outcome.selection.fullStackRef).toBe('organization/test-deploy/staging');
    expect(outcome.env.ECOMA_PULUMI_STATE_URL_STAGING).toBe(R2_BACKEND_URL);
    expect(outcome.record.stackRef).toBe('organization/test-deploy/staging');
    expect(outcome.record.slot).toBe(STAGING_SLOT);
  });
});
