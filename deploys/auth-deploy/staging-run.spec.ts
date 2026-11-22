/**
 * Unit tests PER-UNIT của `staging-run.ts` — phần riêng của unit
 * `auth-deploy`: classify lane, wrapper origin gắn sẵn identity database/role,
 * wrapper reader output và hằng naming. Các test dùng chung của engine
 * (inventory env, ensureStack, parsers, evidence, runStagingPhase…) đã dồn về
 * `libs/deployment/src/staging-run.spec.ts` (#543).
 */

import { describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  HYPERDRIVE_PLACEHOLDER_ID,
  STAGING_AUTH_DATABASE,
  STAGING_AUTH_HYPERDRIVE_CONFIG_NAME,
  STAGING_AUTH_RUNTIME_ROLE,
  classifyAuthDeployStack,
  isProvisionedHyperdriveConfigId,
  readHyperdriveConfigId,
  resolveStagingHyperdriveOrigin,
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

describe('classifyAuthDeployStack', () => {
  it('local namespace slug routes to the local lane', () => {
    expect(classifyAuthDeployStack('organization/auth-deploy/local-john')).toBe('local');
  });

  it('staging and staging-candidate slugs route to the staging lane', () => {
    expect(classifyAuthDeployStack('organization/auth-deploy/staging')).toBe('staging');
    expect(classifyAuthDeployStack('organization/auth-deploy/staging-candidate')).toBe('staging');
  });

  it('a bare local word without the local- prefix is unknown', () => {
    expect(classifyAuthDeployStack('organization/auth-deploy/local')).toBe('unknown');
  });

  it('any other slug is unknown and must fail closed', () => {
    expect(classifyAuthDeployStack('organization/auth-deploy/prod')).toBe('unknown');
    expect(classifyAuthDeployStack('johndoe')).toBe('unknown');
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
      originHost: 'db-auth-staging.ecoma.internal',
      originPort: undefined,
      originPassword: 'origin-password-sentinel',
    });
    expect(origin.host).toBe('db-auth-staging.ecoma.internal');
    expect(origin.port).toBe(5432);
    expect(origin.database).toBe(STAGING_AUTH_DATABASE);
    expect(origin.user).toBe(STAGING_AUTH_RUNTIME_ROLE);
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

  it('an empty or whitespace-only password counts as missing, same as the host', () => {
    expect(() =>
      resolveStagingHyperdriveOrigin({
        originHost: 'h',
        originPort: undefined,
        originPassword: '   ',
      }),
    ).toThrow(/namespace:originPassword/su);
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
    fullStackRef: 'organization/auth-deploy/staging',
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
      'organization/auth-deploy/staging',
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

describe('STAGING_AUTH_HYPERDRIVE_CONFIG_NAME', () => {
  it('names the per-database staging surface within Hyperdrive naming rules', () => {
    expect(STAGING_AUTH_HYPERDRIVE_CONFIG_NAME).toMatch(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u);
    expect(STAGING_AUTH_HYPERDRIVE_CONFIG_NAME).toContain('staging');
    expect(STAGING_AUTH_HYPERDRIVE_CONFIG_NAME).toContain('db-auth');
  });
});
