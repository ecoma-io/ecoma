/**
 * Unit tests của engine staging (`staging-run.ts`) — pure functions + exec
 * inject, KHÔNG chạy Pulumi thật và KHÔNG đụng backend nào. Port của
 * `auth-deploy/staging-run.spec.ts` (#539) với refs của project này, gồm specs
 * cho phần Hyperdrive: origin fail-closed (#349), id thật vs placeholder, tên
 * config per-database.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  HYPERDRIVE_PLACEHOLDER_ID,
  STAGING_REMOTE_CACHE_APP_DATABASE,
  STAGING_REMOTE_CACHE_APP_HYPERDRIVE_CONFIG_NAME,
  STAGING_REMOTE_CACHE_APP_RUNTIME_ROLE,
  appendStagingRecord,
  backendBucket,
  classifyRemoteCacheAppDeployStack,
  ensureStagingStack,
  isProvisionedHyperdriveConfigId,
  parseResourceChanges,
  parseStagingPhaseArg,
  r2AccountIdFromStateUrl,
  readHyperdriveConfigId,
  readStagingRevision,
  resolveStagingHyperdriveOrigin,
  resolveStagingRunEnv,
  type StagingExecDeps,
  type StagingProvisioningRecord,
  stagingHyperdriveWiringExit,
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
    stackRef: 'organization/remote-cache-app-deploy/staging',
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

describe('classifyRemoteCacheAppDeployStack', () => {
  it('local namespace slug routes to the local lane', () => {
    expect(
      classifyRemoteCacheAppDeployStack('organization/remote-cache-app-deploy/local-john'),
    ).toBe('local');
  });

  it('staging and staging-candidate slugs route to the staging lane', () => {
    expect(classifyRemoteCacheAppDeployStack('organization/remote-cache-app-deploy/staging')).toBe(
      'staging',
    );
    expect(
      classifyRemoteCacheAppDeployStack('organization/remote-cache-app-deploy/staging-candidate'),
    ).toBe('staging');
  });

  it('a bare local word without the local- prefix is unknown', () => {
    expect(classifyRemoteCacheAppDeployStack('organization/remote-cache-app-deploy/local')).toBe(
      'unknown',
    );
  });

  it('any other slug is unknown and must fail closed', () => {
    expect(classifyRemoteCacheAppDeployStack('organization/remote-cache-app-deploy/prod')).toBe(
      'unknown',
    );
    expect(classifyRemoteCacheAppDeployStack('johndoe')).toBe('unknown');
  });
});

describe('resolveStagingRunEnv', () => {
  it('builds the child env from the full inventory and strips the file-passphrase variant', () => {
    const { backendUrl, env } = resolveStagingRunEnv({
      ...fullSourceEnv(),
      PULUMI_CONFIG_PASSPHRASE_FILE: '/tmp/should-not-win',
    });
    expect(backendUrl).toBe(R2_BACKEND_URL);
    expect(env.PULUMI_BACKEND_URL).toBe(R2_BACKEND_URL);
    expect(env.PULUMI_CONFIG_PASSPHRASE).toBe('test-passphrase');
    expect(env.PULUMI_SKIP_UPDATE_CHECK).toBe('1');
    expect(env.PULUMI_CONFIG_PASSPHRASE_FILE).toBeUndefined();
    // Token Cloudflare giờ là inventory bắt buộc (program khai HyperdriveConfig
    // #350) nhưng vẫn env-only — không bao giờ vào provider config (state ghi
    // lại config provider, token thì không).
    expect(env.CLOUDFLARE_API_TOKEN).toBe('test-cf-token');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('test-secret');
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

describe('resolveStagingHyperdriveOrigin', () => {
  it('fails closed naming every missing origin key and issue #349 when the tunnel is not provisioned', () => {
    expect(() =>
      resolveStagingHyperdriveOrigin({
        originHost: undefined,
        originPort: undefined,
        originPassword: undefined,
      }),
    ).toThrow(/namespace:originHost.*namespace:originPassword[\s\S]*#349/su);
  });

  it('an empty host counts as missing, not as a value', () => {
    expect(() =>
      resolveStagingHyperdriveOrigin({
        originHost: '  ',
        originPort: undefined,
        originPassword: 'pw',
      }),
    ).toThrow(/namespace:originHost/su);
  });

  it('defaults a missing port to 5432 and keeps the per-database identity constants', () => {
    const origin = resolveStagingHyperdriveOrigin({
      originHost: 'db-remote-cache-app-staging.ecoma.internal',
      originPort: undefined,
      originPassword: 'origin-password-sentinel',
    });
    expect(origin.host).toBe('db-remote-cache-app-staging.ecoma.internal');
    expect(origin.port).toBe(5432);
    expect(origin.database).toBe(STAGING_REMOTE_CACHE_APP_DATABASE);
    expect(origin.user).toBe(STAGING_REMOTE_CACHE_APP_RUNTIME_ROLE);
    expect(origin.scheme).toBe('postgres');
    expect(origin.password).toBe('origin-password-sentinel');
  });

  it('accepts an explicit port and refuses a non-numeric or out-of-range one', () => {
    expect(
      resolveStagingHyperdriveOrigin({
        originHost: 'h',
        originPort: ' 6543 ',
        originPassword: 'pw',
      }).port,
    ).toBe(6543);
    expect(() =>
      resolveStagingHyperdriveOrigin({
        originHost: 'h',
        originPort: 'postgres',
        originPassword: 'pw',
      }),
    ).toThrow(/origin port/su);
    expect(() =>
      resolveStagingHyperdriveOrigin({
        originHost: 'h',
        originPort: '70000',
        originPassword: 'pw',
      }),
    ).toThrow(/origin port/su);
  });
});

describe('isProvisionedHyperdriveConfigId', () => {
  it('accepts a non-placeholder UUID id', () => {
    expect(isProvisionedHyperdriveConfigId('0af52597-051b-4cba-90c9-e0f6ff6cd5d5')).toBe(true);
  });

  it('refuses the all-zeros placeholder and every malformed shape', () => {
    expect(isProvisionedHyperdriveConfigId(HYPERDRIVE_PLACEHOLDER_ID)).toBe(false);
    expect(isProvisionedHyperdriveConfigId('')).toBe(false);
    expect(isProvisionedHyperdriveConfigId('not-a-uuid')).toBe(false);
    expect(isProvisionedHyperdriveConfigId('0AF52597-051B-4CBA-90C9-E0F6FF6CD5D5')).toBe(false);
    expect(isProvisionedHyperdriveConfigId(`${'0'.repeat(31)}1`)).toBe(false);
  });
});

describe('readHyperdriveConfigId', () => {
  const selection = {
    environment: 'staging' as const,
    stackName: 'staging',
    fullStackRef: 'organization/remote-cache-app-deploy/staging',
    backendUrl: R2_BACKEND_URL,
  };

  it('reads stack output hyperdriveConfigId by full stack ref and returns a real id', () => {
    const { deps, calls } = recordingExec([
      execResult({ stdout: '0af52597-051b-4cba-90c9-e0f6ff6cd5d5\n' }),
    ]);
    expect(readHyperdriveConfigId('/tmp/pd', selection, {}, deps)).toBe(
      '0af52597-051b-4cba-90c9-e0f6ff6cd5d5',
    );
    expect(calls[0]?.args).toEqual([
      'stack',
      'output',
      'hyperdriveConfigId',
      '--stack',
      'organization/remote-cache-app-deploy/staging',
    ]);
  });

  it('a failing read yields undefined instead of failing a succeeded provision', () => {
    expect(
      readHyperdriveConfigId(
        '/tmp/pd',
        selection,
        {},
        recordingExec([execResult({ status: 1 })]).deps,
      ),
    ).toBeUndefined();
  });

  it('a placeholder-shaped output (all zeros) is refused as undefined, never surfaced as an id', () => {
    const { deps } = recordingExec([execResult({ stdout: `${HYPERDRIVE_PLACEHOLDER_ID}\n` })]);
    expect(readHyperdriveConfigId('/tmp/pd', selection, {}, deps)).toBeUndefined();
  });

  it('a malformed output yields undefined instead of a fabricated id', () => {
    const { deps } = recordingExec([execResult({ stdout: 'junk' })]);
    expect(readHyperdriveConfigId('/tmp/pd', selection, {}, deps)).toBeUndefined();
  });
});

describe('stagingHyperdriveWiringExit', () => {
  const selection = {
    environment: 'staging' as const,
    stackName: 'staging',
    fullStackRef: 'organization/remote-cache-app-deploy/staging',
    backendUrl: R2_BACKEND_URL,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 0 and prints the wiring guidance when the stack output carries a real id', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { deps } = recordingExec([
      execResult({ stdout: '0af52597-051b-4cba-90c9-e0f6ff6cd5d5\n' }),
    ]);
    expect(stagingHyperdriveWiringExit('remote-cache-app-deploy', selection, {}, deps)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('hyperdrive config id'));
  });

  it('fails loud with a non-zero exit naming the missing target id and the blocked wiring step', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { deps } = recordingExec([execResult({ stdout: `${HYPERDRIVE_PLACEHOLDER_ID}\n` })]);
    expect(stagingHyperdriveWiringExit('remote-cache-app-deploy', selection, {}, deps)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('hyperdriveConfigId'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('env.staging.hyperdrive[0].id'));
    expect(log).not.toHaveBeenCalled();
  });

  it('also fails loud when the stack output read fails outright', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps } = recordingExec([execResult({ status: 1 })]);
    expect(stagingHyperdriveWiringExit('remote-cache-app-deploy', selection, {}, deps)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('hyperdriveConfigId'));
  });
});

describe('ensureStagingStack', () => {
  const selection = {
    environment: 'staging' as const,
    stackName: 'staging',
    fullStackRef: 'organization/remote-cache-app-deploy/staging',
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
      'organization/remote-cache-app-deploy/staging',
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
    const stdout = JSON.stringify({ summary: { resourceChanges: { create: 2, same: 5 } } });
    expect(parseResourceChanges(stdout)).toEqual({ create: 2, same: 5 });
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
    fullStackRef: 'organization/remote-cache-app-deploy/staging',
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
      'organization/remote-cache-app-deploy/staging',
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

describe('STAGING_REMOTE_CACHE_APP_HYPERDRIVE_CONFIG_NAME', () => {
  it('names the per-database staging surface within Hyperdrive naming rules', () => {
    expect(STAGING_REMOTE_CACHE_APP_HYPERDRIVE_CONFIG_NAME).toMatch(
      /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u,
    );
    expect(STAGING_REMOTE_CACHE_APP_HYPERDRIVE_CONFIG_NAME).toContain('staging');
    expect(STAGING_REMOTE_CACHE_APP_HYPERDRIVE_CONFIG_NAME).toContain('db-remote-cache-app');
  });
});
