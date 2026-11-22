/**
 * Unit tests PER-UNIT của `staging-run.ts` — phần riêng của unit `llm-api`
 * (#359: BA database trên MỘT unit): classify lane, naming config/output là
 * HÀM của target, wrapper origin per-target và wrapper reader per-target. Các
 * test dùng chung của engine (inventory env, ensureStack, parsers, evidence,
 * runStagingPhase…) đã dồn về `libs/deployment/src/staging-run.spec.ts` (#543).
 */

import { describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import { DATABASES, dbName, runtimeRole } from './scripts.js';
import {
  HYPERDRIVE_PLACEHOLDER_ID,
  classifyLlmApiDeployStack,
  isProvisionedHyperdriveConfigId,
  readHyperdriveConfigId,
  resolveStagingHyperdriveOrigin,
  stagingHyperdriveConfigName,
  stagingHyperdriveOutputName,
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

describe('classifyLlmApiDeployStack', () => {
  it('local namespace slug routes to the local lane', () => {
    expect(classifyLlmApiDeployStack('organization/llm-api-deploy/local-john')).toBe('local');
  });

  it('staging and staging-candidate slugs route to the staging lane', () => {
    expect(classifyLlmApiDeployStack('organization/llm-api-deploy/staging')).toBe('staging');
    expect(classifyLlmApiDeployStack('organization/llm-api-deploy/staging-candidate')).toBe(
      'staging',
    );
  });

  it('a bare local word without the local- prefix is unknown', () => {
    expect(classifyLlmApiDeployStack('organization/llm-api-deploy/local')).toBe('unknown');
  });

  it('any other slug is unknown and must fail closed', () => {
    expect(classifyLlmApiDeployStack('organization/llm-api-deploy/prod')).toBe('unknown');
    expect(classifyLlmApiDeployStack('johndoe')).toBe('unknown');
  });
});

describe('resolveStagingHyperdriveOrigin', () => {
  it('fails closed naming every missing origin key and issue #349 when the tunnel is not provisioned', () => {
    expect(() =>
      resolveStagingHyperdriveOrigin(
        {
          originHost: undefined,
          originPort: undefined,
          originPassword: undefined,
        },
        'gateway',
      ),
    ).toThrow(/namespace:originHost.*namespace:originPassword[\s\S]*#349/su);
  });

  it('an empty host counts as missing, not as a value', () => {
    expect(() =>
      resolveStagingHyperdriveOrigin(
        {
          originHost: '  ',
          originPort: undefined,
          originPassword: 'pw',
        },
        'gateway',
      ),
    ).toThrow(/namespace:originHost/su);
  });

  it('defaults a missing port to 5432 and keeps the per-database identity constants for every target', () => {
    for (const target of DATABASES) {
      const origin = resolveStagingHyperdriveOrigin(
        {
          originHost: 'pg-staging.ecoma.internal',
          originPort: undefined,
          originPassword: 'origin-password-sentinel',
        },
        target,
      );
      expect(origin.host).toBe('pg-staging.ecoma.internal');
      expect(origin.port).toBe(5432);
      expect(origin.database).toBe(dbName(target));
      expect(origin.user).toBe(runtimeRole(target));
      expect(origin.scheme).toBe('postgres');
      expect(origin.password).toBe('origin-password-sentinel');
    }
    // Ba database là BA logical DB rời nhau trên cùng origin host — không
    // config nào dùng chung database/user (§4.2 cấm config dùng chung).
    const databases = DATABASES.map(
      (target) =>
        resolveStagingHyperdriveOrigin(
          { originHost: 'h', originPort: undefined, originPassword: 'pw' },
          target,
        ).database,
    );
    expect(new Set(databases).size).toBe(DATABASES.length);
  });

  it('accepts an explicit port and refuses a non-numeric or out-of-range one', () => {
    expect(
      resolveStagingHyperdriveOrigin(
        {
          originHost: 'h',
          originPort: ' 6543 ',
          originPassword: 'pw',
        },
        'gateway',
      ).port,
    ).toBe(6543);
    expect(() =>
      resolveStagingHyperdriveOrigin(
        {
          originHost: 'h',
          originPort: 'postgres',
          originPassword: 'pw',
        },
        'gateway',
      ),
    ).toThrow(/origin port/su);
    expect(() =>
      resolveStagingHyperdriveOrigin(
        {
          originHost: 'h',
          originPort: '70000',
          originPassword: 'pw',
        },
        'gateway',
      ),
    ).toThrow(/origin port/su);
  });

  it('an empty or whitespace-only password counts as missing, same as the host', () => {
    expect(() =>
      resolveStagingHyperdriveOrigin(
        {
          originHost: 'h',
          originPort: undefined,
          originPassword: '   ',
        },
        'gateway',
      ),
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
    fullStackRef: 'organization/llm-api-deploy/staging',
    backendUrl: R2_BACKEND_URL,
  };

  it('reads stack output <target>HyperdriveConfigId by full stack ref and returns a real id', () => {
    const { deps, calls } = recordingExec([
      execResult({ stdout: '0af52597-051b-4cba-90c9-e0f6ff6cd5d5\n' }),
    ]);
    expect(readHyperdriveConfigId('/tmp/pd', selection, {}, 'tenant', deps)).toBe(
      '0af52597-051b-4cba-90c9-e0f6ff6cd5d5',
    );
    expect(calls[0]?.args).toEqual([
      'stack',
      'output',
      'tenantHyperdriveConfigId',
      '--stack',
      'organization/llm-api-deploy/staging',
    ]);
  });

  it('each target reads its own output name and never another target id', () => {
    // UUID thật-sửa (đuôi mark hex-target) — chỉ để phân biệt id giữa các
    // target, shape phải qua được `isProvisionedHyperdriveConfigId`.
    const fakeIdByTarget: Record<string, string> = {
      gateway: 'aaaaaaaa-051b-4cba-90c9-e0f6ff6cd5d5',
      tenant: 'bbbbbbbb-051b-4cba-90c9-e0f6ff6cd5d5',
      marketplace: 'cccccccc-051b-4cba-90c9-e0f6ff6cd5d5',
    };
    for (const target of DATABASES) {
      const { deps, calls } = recordingExec([
        execResult({ stdout: `${fakeIdByTarget[target]}\n` }),
      ]);
      const id = readHyperdriveConfigId('/tmp/pd', selection, {}, target, deps);
      expect(id).toBe(fakeIdByTarget[target]);
      expect(calls[0]?.args).toContain(`${target}HyperdriveConfigId`);
    }
  });

  it('a failing read yields undefined instead of failing a succeeded provision', () => {
    expect(
      readHyperdriveConfigId(
        '/tmp/pd',
        selection,
        {},
        'gateway',
        recordingExec([execResult({ status: 1 })]).deps,
      ),
    ).toBeUndefined();
  });

  it('a placeholder-shaped output (all zeros) is refused as undefined, never surfaced as an id', () => {
    const { deps } = recordingExec([execResult({ stdout: `${HYPERDRIVE_PLACEHOLDER_ID}\n` })]);
    expect(readHyperdriveConfigId('/tmp/pd', selection, {}, 'gateway', deps)).toBeUndefined();
  });

  it('a malformed output yields undefined instead of a fabricated id', () => {
    const { deps } = recordingExec([execResult({ stdout: 'junk' })]);
    expect(readHyperdriveConfigId('/tmp/pd', selection, {}, 'gateway', deps)).toBeUndefined();
  });
});

describe('stagingHyperdriveConfigName and stagingHyperdriveOutputName', () => {
  it('names the per-database staging surface within Hyperdrive naming rules', () => {
    for (const target of DATABASES) {
      const name = stagingHyperdriveConfigName(target);
      expect(name).toMatch(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u);
      expect(name).toContain('staging');
      expect(name).toContain(dbName(target));
    }
  });

  it('config names stay distinct across the three databases on one Cloudflare account', () => {
    const names = DATABASES.map(stagingHyperdriveConfigName);
    expect(new Set(names).size).toBe(DATABASES.length);
  });

  it('derives the stack output name from the target so both sides cannot drift', () => {
    expect(stagingHyperdriveOutputName('gateway')).toBe('gatewayHyperdriveConfigId');
    expect(stagingHyperdriveOutputName('tenant')).toBe('tenantHyperdriveConfigId');
    expect(stagingHyperdriveOutputName('marketplace')).toBe('marketplaceHyperdriveConfigId');
  });
});
