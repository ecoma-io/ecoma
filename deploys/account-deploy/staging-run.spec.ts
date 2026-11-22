/**
 * Unit tests PER-UNIT của `staging-run.ts` — phần riêng của unit
 * `account-deploy`: classify lane, wrapper origin gắn sẵn identity
 * database/role, wrapper reader output, hằng naming và hợp đồng lane guard của
 * `index.ts`. Các test dùng chung của engine (inventory env, ensureStack,
 * parsers, evidence, runStagingPhase…) đã dồn về
 * `libs/deployment/src/staging-run.spec.ts` (#543) và KHÔNG lặp lại ở đây.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ExecResult } from '@ecoma-io/deployment';

import {
  HYPERDRIVE_PLACEHOLDER_ID,
  STAGING_ACCOUNT_DATABASE,
  STAGING_ACCOUNT_HYPERDRIVE_CONFIG_NAME,
  STAGING_ACCOUNT_RUNTIME_ROLE,
  classifyAccountDeployStack,
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

describe('classifyAccountDeployStack', () => {
  it('local namespace slug routes to the local lane', () => {
    expect(classifyAccountDeployStack('organization/account-deploy/local-john')).toBe('local');
  });

  it('staging and staging-candidate slugs route to the staging lane', () => {
    expect(classifyAccountDeployStack('organization/account-deploy/staging')).toBe('staging');
    expect(classifyAccountDeployStack('organization/account-deploy/staging-candidate')).toBe(
      'staging',
    );
  });

  it('a bare local word without the local- prefix is unknown', () => {
    expect(classifyAccountDeployStack('organization/account-deploy/local')).toBe('unknown');
  });

  it('any other slug is unknown and must fail closed', () => {
    expect(classifyAccountDeployStack('organization/account-deploy/prod')).toBe('unknown');
    expect(classifyAccountDeployStack('johndoe')).toBe('unknown');
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
      originHost: 'db-account-staging.ecoma.internal',
      originPort: undefined,
      originPassword: 'origin-password-sentinel',
    });
    expect(origin.host).toBe('db-account-staging.ecoma.internal');
    expect(origin.port).toBe(5432);
    expect(origin.database).toBe(STAGING_ACCOUNT_DATABASE);
    expect(origin.user).toBe(STAGING_ACCOUNT_RUNTIME_ROLE);
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
    fullStackRef: 'organization/account-deploy/staging',
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
      'organization/account-deploy/staging',
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

describe('STAGING_ACCOUNT_HYPERDRIVE_CONFIG_NAME', () => {
  it('names the per-database staging surface within Hyperdrive naming rules', () => {
    expect(STAGING_ACCOUNT_HYPERDRIVE_CONFIG_NAME).toMatch(/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/u);
    expect(STAGING_ACCOUNT_HYPERDRIVE_CONFIG_NAME).toContain('staging');
    expect(STAGING_ACCOUNT_HYPERDRIVE_CONFIG_NAME).toContain('db-account');
  });
});

describe('lane guard entry contract (index.ts)', () => {
  const repoRoot = resolve(import.meta.dirname, '../..');

  it('the lane program bodies never gain a default export (host unwraps it and the local outputs disappear)', () => {
    // OCR round 3: entry forwards `(mod as { default?: unknown }).default ?? mod`
    // — một `export default` của lane local sẽ bị language host lấy làm program
    // result thay vì namespace outputs (`pulumi stack output
    // provisionCommandName` biến mất). Contract: local-program chỉ named
    // exports; staging-program có default export là outputs.
    for (const file of ['local-program.ts', 'staging-program.ts']) {
      const source = readFileSync(join(repoRoot, 'deploys/account-deploy', file), 'utf8');
      const stripped = source
        .replace(
          /^\/\*[\s\S]*?\*\/\s*/gmu, // block comments
          '',
        )
        .replace(/^\s*\/\/.*$/gmu, ''); // line comments
      expect(
        /export\s+default/u.test(stripped),
        `${file} must not declare a default export (entry-forwarding contract)`,
      ).toBe(file === 'staging-program.ts');
    }
  });

  it('the entry statically imports only the stack classifier, never a lane body', () => {
    // OCR round 3: classifier phải load được NGAY CẢ khi một thân lane lỗi
    // load — guard phân loại phải đứng trước và không kéo thân qua static
    // import; thân chỉ được nạp bằng `await import()` sau khi lane đã phân loại.
    const source = readFileSync(join(repoRoot, 'deploys/account-deploy/index.ts'), 'utf8');
    const staticImports = [...source.matchAll(/^import[\s\S]*?from\s+'([^']+)';/gmu)].map(
      (m) => m[1] ?? '',
    );
    expect(staticImports).toContain('./staging-run.js');
    for (const body of ['./staging-program.js', './local-program.js']) {
      expect(staticImports, `index.ts must not statically import lane body ${body}`).not.toContain(
        body,
      );
      expect(
        source.replaceAll('\\', '/'),
        `lane body ${body} must be loaded via await import()`,
      ).toContain(`await import('${body}')`);
    }
  });
});
