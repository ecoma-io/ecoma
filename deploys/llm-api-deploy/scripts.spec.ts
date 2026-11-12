/**
 * Spec unit của hàm build script (`scripts.ts`) — colocated với subject, chạy
 * target `test` (không Docker, không PostgreSQL).
 *
 * Phạm vi: TEXT của script không chứa giá trị secret nào và chỉ đọc mật khẩu/
 * chuỗi kết nối qua TÊN biến môi trường. Bằng chứng "không argv khi CHẠY
 * THẬT" (shim docker ghi argv + sweep proc-cmdline + PostgreSQL thật) nằm ở
 * suite integration `tests/integrations/argv-hygiene.spec.ts` — target
 * `test-integration`; spec này chỉ khoá bất biến tĩnh của text để một sửa
 * đổi vô tình tái nhúng giá trị vào script bị bắt ngay ở tầng unit.
 */
import { describe, expect, it } from 'vitest';

import {
  DATABASES,
  BOOTSTRAP_CONSUMER_TENANT_ENV_VARS,
  BOOTSTRAP_GOVERNANCE_ENV_VARS,
  BOOTSTRAP_MARKETPLACE_ENV_VARS,
  bootstrapScriptName,
  buildBootstrapScript,
  buildMigrateScript,
  buildProvisionScript,
  dbName,
  extractEligibilityVerdict,
  migratorRole,
  passwordEnvVar,
  runtimeRole,
} from './scripts.ts';

const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

// Sentinel giống hệt suite integration: giá trị KHÔNG BAO GIỜ được truyền vào
// hàm build — assert dưới chỉ chứng minh text sinh ra không bao giờ chứa nó,
// tức script không thể rò secret kể cả khi ai đó tái nhúng interpolation.
const SENTINEL = `S3nt1n3l-Gw-Mig'x1`;

describe('passwordEnvVar', () => {
  it('maps every target and role to a distinct, deterministic env var name', () => {
    const names = DATABASES.flatMap((target) => [
      passwordEnvVar(target, 'migrator'),
      passwordEnvVar(target, 'runtime'),
    ]);
    expect(new Set(names).size).toBe(6);
    expect(names).toEqual([
      'LLM_PW_GATEWAY_MIGRATOR',
      'LLM_PW_GATEWAY_RUNTIME',
      'LLM_PW_TENANT_MIGRATOR',
      'LLM_PW_TENANT_RUNTIME',
      'LLM_PW_MARKETPLACE_MIGRATOR',
      'LLM_PW_MARKETPLACE_RUNTIME',
    ]);
  });
});

describe('buildProvisionScript', () => {
  const script = buildProvisionScript({ postgresContainerName: 'ecoma-x-postgres' });

  it('reads all six passwords by env var NAME, never by value', () => {
    for (const target of DATABASES) {
      // Shell dereference lúc gọi hàm — giá trị chỉ nằm trong ô nhớ shell.
      expect(script).toContain(`"$${passwordEnvVar(target, 'migrator')}"`);
      expect(script).toContain(`"$${passwordEnvVar(target, 'runtime')}"`);
    }
    expect(script).not.toContain(SENTINEL);
  });

  it('feeds ALTER ROLE password SQL to psql via STDIN, not via -c', () => {
    expect(script).toContain('docker exec -i $PG psql');
    expect(script).toContain('| $PSQL_STDIN');
    // Không còn dòng nào áp password qua `-c`: pattern của baseline cũ là
    // `$PSQL -c '<ALTER ROLE ... PASSWORD ...>'` với giá trị nội suy vào argv.
    expect(
      script.split('\n').filter((line) => line.includes('$PSQL -c') && line.includes('PASSWORD')),
    ).toEqual([]);
    const alterLines = script.split('\n').filter((line) => line.startsWith('apply_password '));
    expect(alterLines).toHaveLength(6);
    for (const line of alterLines) {
      // Mỗi lời gọi chỉ mang TÊN role + TÊN biến môi trường.
      expect(line).toMatch(/^apply_password ecoma_llm_[a-z]+_(migrator|runtime) "\$\w+"$/u);
    }
  });

  it('SQL-quotes the password in-shell through sed stdin, without bashisms', () => {
    expect(script).toContain(`printf '%s' "$1" | sed "s/'/''/g"`);
    // Provider chạy `/bin/sh -c` (dash): script phải POSIX — cấm bashism phổ biến.
    expect(script).not.toMatch(/\$\{!\w/u); // indirect expansion ${!var}
    expect(script).not.toMatch(/\$\{\w+\/\//u); // ${var//pattern/repl}
    expect(script).not.toMatch(/\blocal \w+/u); // `local` (extension phổ biến)
    expect(script).not.toMatch(/\bdeclare\b|\barray\b/u);
  });

  it('keeps idempotent guard-create, cross-revokes, grants and public hardening', () => {
    expect(script).toContain("SELECT 1 FROM pg_roles WHERE rolname='ecoma_owner'");
    for (const target of DATABASES) {
      expect(script).toContain(`CREATE DATABASE "${dbName(target)}"`);
      expect(script).toContain(`ALTER DATABASE "${dbName(target)}" OWNER TO ecoma_owner`);
      expect(script).toContain(`GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${dbName(target)}"`);
      expect(script).toContain(`GRANT CONNECT ON DATABASE "${dbName(target)}"`);
      expect(script).toContain(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
      for (const other of DATABASES) {
        if (other === target) continue;
        expect(script).toContain(
          `REVOKE CONNECT ON DATABASE "${dbName(other)}" FROM ${runtimeRole(target)}`,
        );
      }
    }
  });

  it('is deterministic for the same inputs', () => {
    expect(buildProvisionScript({ postgresContainerName: 'ecoma-x-postgres' })).toBe(script);
  });
});

describe('buildMigrateScript', () => {
  const script = buildMigrateScript({
    networkName: 'ecoma-x-network',
    worktreeRoot: '/repo/worktrees/x',
    target: 'gateway',
    nodeImage: NODE_IMAGE,
  });

  it('passes DATABASE_URL to docker run by NAME only, never as a value', () => {
    expect(script).toContain('-e DATABASE_URL \\');
    expect(script).not.toContain('DATABASE_URL=postgresql://');
    expect(script).not.toContain(SENTINEL);
  });

  it('keeps the canonical runner invocation, mounts and network', () => {
    expect(script).toContain('--network ecoma-x-network');
    expect(script).toContain(`-v '/repo/worktrees/x':/repo:ro`);
    expect(script).toContain(`-v '/repo/worktrees/x'/node_modules:/repo/node_modules`);
    expect(script).toContain('-w /repo/apps/llm-api');
    expect(script).toContain(NODE_IMAGE);
    expect(script).toContain('npx tsx --tsconfig tsconfig.db.json db/apply.mts gateway');
  });

  it('is deterministic for the same inputs', () => {
    expect(
      buildMigrateScript({
        networkName: 'ecoma-x-network',
        worktreeRoot: '/repo/worktrees/x',
        target: 'gateway',
        nodeImage: NODE_IMAGE,
      }),
    ).toBe(script);
  });
});

describe('role and database naming', () => {
  it('follows the db-llm / ecoma_llm conventions', () => {
    expect(dbName('gateway')).toBe('db-llm-gateway');
    expect(migratorRole('tenant')).toBe('ecoma_llm_tenant_migrator');
    expect(runtimeRole('marketplace')).toBe('ecoma_llm_marketplace_runtime');
  });
});

describe('buildBootstrapScript', () => {
  const envVars = ['ECOMA_GOVERNANCE_ACTOR', 'ECOMA_SELLER_TENANT_OWNER_SUB'];
  const script = buildBootstrapScript({
    networkName: 'ecoma-x-network',
    worktreeRoot: '/repo/worktrees/x',
    step: 'seller-governance',
    nodeImage: NODE_IMAGE,
    envVarNames: envVars,
  });

  it('passes DATABASE_URL and every bootstrap env var to docker run by NAME only', () => {
    expect(script).toContain('-e DATABASE_URL \\');
    for (const name of envVars) {
      expect(script).toContain(`-e ${name} \\`);
    }
    // Không `-e TÊN=giá trị` nào: argv docker chỉ mang tên biến.
    expect(script).not.toMatch(/-e \w+=/u);
    expect(script).not.toContain(SENTINEL);
  });

  it('keeps the canonical runner invocation for the requested bootstrap step', () => {
    expect(script).toContain('--network ecoma-x-network');
    expect(script).toContain(`-v '/repo/worktrees/x':/repo:ro`);
    expect(script).toContain('-w /repo/apps/llm-api');
    expect(script).toContain(NODE_IMAGE);
    expect(script).toContain(
      `npx tsx --tsconfig tsconfig.db.json ${bootstrapScriptName('seller-governance')}`,
    );
    expect(bootstrapScriptName('marketplace')).toBe('db/bootstrap-marketplace.mts');
    expect(bootstrapScriptName('consumer-tenant')).toBe('db/bootstrap-consumer-tenant.mts');
  });

  it('is deterministic for the same inputs', () => {
    expect(
      buildBootstrapScript({
        networkName: 'ecoma-x-network',
        worktreeRoot: '/repo/worktrees/x',
        step: 'seller-governance',
        nodeImage: NODE_IMAGE,
        envVarNames: envVars,
      }),
    ).toBe(script);
  });

  it('emits the two step-9 database URL names instead of DATABASE_URL, by NAME only', () => {
    // Bước 9 kết nối hai database trong một lần chạy: script phải pass-through
    // đúng hai biến URL ECOMA_* và KHÔNG còn `-e DATABASE_URL` (runner bước 9
    // không đọc biến đó). Mọi `-e` vẫn chỉ mang TÊN biến, không `=giá trị`.
    const step9 = buildBootstrapScript({
      networkName: 'ecoma-x-network',
      worktreeRoot: '/repo/worktrees/x',
      step: 'consumer-tenant',
      nodeImage: NODE_IMAGE,
      envVarNames: [...BOOTSTRAP_CONSUMER_TENANT_ENV_VARS],
      databaseUrlEnvNames: ['ECOMA_TENANT_DATABASE_URL', 'ECOMA_GATEWAY_DATABASE_URL'],
    });
    expect(step9).toContain('-e ECOMA_TENANT_DATABASE_URL \\');
    expect(step9).toContain('-e ECOMA_GATEWAY_DATABASE_URL \\');
    expect(step9).not.toContain('-e DATABASE_URL \\');
    for (const name of BOOTSTRAP_CONSUMER_TENANT_ENV_VARS) {
      expect(step9).toContain(`-e ${name} \\`);
    }
    expect(step9).not.toMatch(/-e \w+=/u);
    expect(step9).not.toContain(SENTINEL);
    expect(step9).toContain(
      `npx tsx --tsconfig tsconfig.db.json ${bootstrapScriptName('consumer-tenant')}`,
    );
  });

  it('declares the exact env var surface each runner reads (index wiring cannot drift)', () => {
    expect(BOOTSTRAP_GOVERNANCE_ENV_VARS).toContain('ECOMA_SELLER_TENANT_OWNER_SUB');
    expect(BOOTSTRAP_GOVERNANCE_ENV_VARS).not.toContain('SELLER_ELIGIBILITY_VERDICT');
    expect(BOOTSTRAP_MARKETPLACE_ENV_VARS).toContain('LLM_UPSTREAM_CREDENTIAL_PLAINTEXT');
    expect(BOOTSTRAP_MARKETPLACE_ENV_VARS).toContain('SELLER_ELIGIBILITY_VERDICT');
    expect(new Set(BOOTSTRAP_MARKETPLACE_ENV_VARS).size).toBe(
      BOOTSTRAP_MARKETPLACE_ENV_VARS.length,
    );
    expect(new Set(BOOTSTRAP_GOVERNANCE_ENV_VARS).size).toBe(BOOTSTRAP_GOVERNANCE_ENV_VARS.length);
    // Bước 9: đúng hai biến — actor + owner sub; các URL database không nằm
    // ở đây (chúng đi qua `databaseUrlEnvNames` của buildBootstrapScript).
    expect(BOOTSTRAP_CONSUMER_TENANT_ENV_VARS).toEqual([
      'ECOMA_GOVERNANCE_ACTOR',
      'ECOMA_CONSUMER_TENANT_OWNER_SUB',
    ]);
  });
});

describe('extractEligibilityVerdict', () => {
  it('returns the value of the SELLER_ELIGIBILITY_VERDICT machine line', () => {
    const stdout =
      'SELLER_ELIGIBILITY_VERDICT={"tenantId":"seller-tenant-dronie","eligible":true}\n';
    expect(extractEligibilityVerdict(stdout)).toBe(
      '{"tenantId":"seller-tenant-dronie","eligible":true}',
    );
  });

  it('fails loudly when the stdout contract is broken', () => {
    expect(() => extractEligibilityVerdict('[bootstrap] done\n')).toThrow(
      /SELLER_ELIGIBILITY_VERDICT/u,
    );
  });
});
