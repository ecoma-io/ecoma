/**
 * Spec unit của hàm build script (`scripts.ts`) — colocated với subject, chạy
 * target `test` (không Docker, không PostgreSQL).
 *
 * Phạm vi: TEXT của script không chứa giá trị secret nào và chỉ đọc mật khẩu/
 * chuỗi kết nối/token máy qua TÊN biến môi trường. Bằng chứng "không argv khi
 * CHẠY THẬT" (shim docker ghi argv + sweep proc-cmdline + PostgreSQL thật)
 * nằm ở suite integration `tests/integrations/argv-hygiene.spec.ts` — target
 * `test-integration`; spec này chỉ khoá bất biến tĩnh của text để một sửa đổi
 * vô tình tái nhúng giá trị vào script bị bắt ngay ở tầng unit.
 */
import { describe, expect, it } from 'vitest';

import { shellQuote } from '@ecoma-io/deployment';

import {
  DATABASE_NAME,
  MACHINE_TOKEN_PLAINTEXT_ENV_VAR,
  MIGRATOR_PASSWORD_ENV_VAR,
  MIGRATOR_ROLE,
  POSTGRES_HOST,
  RUNTIME_PASSWORD_ENV_VAR,
  RUNTIME_ROLE,
  buildBootstrapTenantScript,
  buildMachineTokenProvisionScript,
  buildMigrateScript,
  buildMigratorConnectionUrl,
  buildProvisionScript,
  buildRuntimeConnectionUrl,
} from './scripts.ts';

const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

// Sentinel giống hệt suite integration: giá trị KHÔNG BAO GIỜ được truyền vào
// hàm build — assert dưới chỉ chứng minh text sinh ra không bao giờ chứa nó,
// tức script không thể rò secret kể cả khi ai đó tái nhúng interpolation.
const PASSWORD_SENTINEL = `S3nt1n3l-Pact-Mig'x1%`;
const TOKEN_SENTINEL = `S3nt1n3l-Pact-Tok'x9;`;

describe('env var name constants', () => {
  it('declares distinct, deterministic env var names for both role passwords and the token', () => {
    expect(MIGRATOR_PASSWORD_ENV_VAR).toBe('PACT_PW_MIGRATOR');
    expect(RUNTIME_PASSWORD_ENV_VAR).toBe('PACT_PW_RUNTIME');
    expect(MACHINE_TOKEN_PLAINTEXT_ENV_VAR).toBe('PACT_MACHINE_TOKEN_PLAINTEXT');
    expect(MIGRATOR_PASSWORD_ENV_VAR).not.toBe(RUNTIME_PASSWORD_ENV_VAR);
  });
});

describe('buildProvisionScript', () => {
  const script = buildProvisionScript({ postgresContainerName: 'ecoma-x-postgres' });

  it('reads both role passwords by env var NAME, never by value', () => {
    // Shell dereference lúc gọi hàm — giá trị chỉ nằm trong ô nhớ shell.
    expect(script).toContain(`"$${MIGRATOR_PASSWORD_ENV_VAR}"`);
    expect(script).toContain(`"$${RUNTIME_PASSWORD_ENV_VAR}"`);
    expect(script).not.toContain(PASSWORD_SENTINEL);
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
    expect(alterLines).toHaveLength(2);
    for (const line of alterLines) {
      // Mỗi lời gọi chỉ mang TÊN role + TÊN biến môi trường.
      expect(line).toMatch(/^apply_password ecoma_pact_broker_(migrator|runtime) "\$\w+"$/u);
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

  it('keeps idempotent guard-create, grants and public hardening', () => {
    expect(script).toContain(`CREATE ROLE ${MIGRATOR_ROLE} LOGIN`);
    expect(script).toContain(`CREATE ROLE ${RUNTIME_ROLE} LOGIN`);
    expect(script).toContain(`CREATE DATABASE "${DATABASE_NAME}"`);
    expect(script).toContain(`REVOKE CONNECT ON DATABASE "${DATABASE_NAME}" FROM PUBLIC`);
    expect(script).toContain(
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${DATABASE_NAME}" TO ${MIGRATOR_ROLE}`,
    );
    expect(script).toContain(`GRANT CONNECT ON DATABASE "${DATABASE_NAME}" TO ${RUNTIME_ROLE}`);
    expect(script).toContain(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  });

  it('is deterministic for the same inputs', () => {
    expect(buildProvisionScript({ postgresContainerName: 'ecoma-x-postgres' })).toBe(script);
  });
});

describe('connection url builders', () => {
  it('builds the migrator URL with percent-encoded password', () => {
    expect(buildMigratorConnectionUrl({ password: 'plain-password' })).toBe(
      `postgresql://${MIGRATOR_ROLE}:plain-password@${POSTGRES_HOST}:5432/${DATABASE_NAME}`,
    );
  });

  it('builds the runtime URL for the same database with its own role', () => {
    expect(buildRuntimeConnectionUrl({ password: 'plain-password' })).toBe(
      `postgresql://${RUNTIME_ROLE}:plain-password@${POSTGRES_HOST}:5432/${DATABASE_NAME}`,
    );
  });

  it('percent-encodes URL-delimiting, shell and whitespace characters in the password', () => {
    // Ký tự delineator userinfo (`@ : / ? # %`) bắt buộc encode; ký tự shell
    // (`$` backtick `;`) và khoảng trắng cũng phải encode để URL luôn parse
    // đúng một segment password. Nháy đơn `'` nằm trong bộ unreserved của
    // encodeURIComponent nên giữ nguyên — parser userinfo của `pg` chấp nhận
    // (delimit là `@`/`:`/`/`), contract được ghim đúng như vậy.
    const raw = `p@ss:wo/rd?x#y%z$w\`v;s néc'k"q\\r`;
    const encoded = `p%40ss%3Awo%2Frd%3Fx%23y%25z%24w%60v%3Bs%20n%C3%A9c'k%22q%5Cr`;
    expect(buildMigratorConnectionUrl({ password: raw })).toBe(
      `postgresql://${MIGRATOR_ROLE}:${encoded}@${POSTGRES_HOST}:5432/${DATABASE_NAME}`,
    );
    expect(buildRuntimeConnectionUrl({ password: raw })).toBe(
      `postgresql://${RUNTIME_ROLE}:${encoded}@${POSTGRES_HOST}:5432/${DATABASE_NAME}`,
    );
  });
});

describe('buildMigrateScript', () => {
  const script = buildMigrateScript({
    networkName: 'ecoma-x-network',
    worktreeRoot: '/repo/worktrees/x',
    nodeImage: NODE_IMAGE,
  });

  it('passes DATABASE_URL to docker run by NAME only, never as a value', () => {
    expect(script).toContain('-e DATABASE_URL \\');
    expect(script).not.toMatch(/-e DATABASE_URL=/u);
    expect(script).not.toContain('DATABASE_URL=postgresql://');
    expect(script).not.toContain(PASSWORD_SENTINEL);
  });

  it('keeps the canonical runner invocation, mounts and network', () => {
    expect(script).toContain('--network ecoma-x-network');
    expect(script).toContain(`-v '/repo/worktrees/x':/repo:ro`);
    expect(script).toContain(`-v '/repo/worktrees/x'/node_modules:/repo/node_modules`);
    expect(script).toContain('-w /repo/apps/pact-broker-api');
    expect(script).toContain(NODE_IMAGE);
    expect(script).toContain(
      '/repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/apply.mts',
    );
  });

  it('is deterministic for the same inputs', () => {
    expect(
      buildMigrateScript({
        networkName: 'ecoma-x-network',
        worktreeRoot: '/repo/worktrees/x',
        nodeImage: NODE_IMAGE,
      }),
    ).toBe(script);
  });
});

describe('buildBootstrapTenantScript', () => {
  const script = buildBootstrapTenantScript({
    networkName: 'ecoma-x-network',
    worktreeRoot: '/repo/worktrees/x',
    nodeImage: NODE_IMAGE,
    tenantOwnerSub: 'sub-integration-owner',
  });

  it('passes DATABASE_URL to docker run by NAME only, never as a value', () => {
    expect(script).toContain('-e DATABASE_URL \\');
    expect(script).not.toMatch(/-e DATABASE_URL=/u);
    expect(script).not.toMatch(/-e \w+=postgresql/u);
    expect(script).not.toContain(PASSWORD_SENTINEL);
  });

  it('keeps the tenant owner sub inline as a quoted identifier, not a secret channel', () => {
    // sub là ĐỊNH DANH (id của Account service), không phải credential — giữ
    // nội suy giá trị đã shellQuote trong argv `-e VAR=giá trị`.
    expect(script).toContain(`-e CANONICAL_TENANT_OWNER_SUB='sub-integration-owner'`);
  });

  it('keeps the canonical runner invocation, mounts and network', () => {
    expect(script).toContain('--network ecoma-x-network');
    expect(script).toContain(`-v '/repo/worktrees/x':/repo:ro`);
    expect(script).toContain('-w /repo/apps/pact-broker-api');
    expect(script).toContain(
      '/repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/bootstrap-tenant.mts',
    );
  });

  it('is deterministic for the same inputs', () => {
    expect(
      buildBootstrapTenantScript({
        networkName: 'ecoma-x-network',
        worktreeRoot: '/repo/worktrees/x',
        nodeImage: NODE_IMAGE,
        tenantOwnerSub: 'sub-integration-owner',
      }),
    ).toBe(script);
  });
});

describe('buildMachineTokenProvisionScript', () => {
  const script = buildMachineTokenProvisionScript({
    networkName: 'ecoma-x-network',
    worktreeRoot: '/repo/worktrees/x',
    nodeImage: NODE_IMAGE,
    tokenName: 'pact-broker-app-bff',
    tokenScopes: 'admin',
  });

  it('passes DATABASE_URL and the token plaintext to docker run by NAME only', () => {
    expect(script).toContain('-e DATABASE_URL \\');
    expect(script).toContain(`-e ${MACHINE_TOKEN_PLAINTEXT_ENV_VAR} \\`);
    // Không dạng `-e TÊN=giá trị` nào cho DATABASE_URL hay plaintext token —
    // cả hai chỉ được phép xuất hiện ở dạng name-only (có `\` nối dòng).
    expect(script).not.toMatch(/-e DATABASE_URL=/u);
    expect(script).not.toMatch(new RegExp(`-e ${MACHINE_TOKEN_PLAINTEXT_ENV_VAR}=`, 'u'));
    expect(script).not.toMatch(/-e \w+=postgresql/u);
    expect(script).not.toContain(PASSWORD_SENTINEL);
    expect(script).not.toContain(TOKEN_SENTINEL);
  });

  it('keeps token name and scopes inline as quoted non-secret values', () => {
    expect(script).toContain(`-e PACT_MACHINE_TOKEN_NAME=${shellQuote('pact-broker-app-bff')}`);
    expect(script).toContain(`-e PACT_MACHINE_TOKEN_SCOPES=${shellQuote('admin')}`);
  });

  it('shell-quotes hostile token name and scopes inside the builder', () => {
    // Giá trị chứa nháy đơn/semicolon/space phải ở dưới dạng đã shellQuote:
    // shell parse ra nguyên giá trị gốc thành MỘT argument env — không tách
    // từ, không chạy lệnh. Nội suy trần (lỗi bị ghim ở đây) không được quay lại.
    const hostileName = `pact"tok'en;x y`;
    const hostileScopes = `admin 'extra;scope`;
    const hostile = buildMachineTokenProvisionScript({
      networkName: 'ecoma-x-network',
      worktreeRoot: '/repo/worktrees/x',
      nodeImage: NODE_IMAGE,
      tokenName: hostileName,
      tokenScopes: hostileScopes,
    });
    expect(hostile).toContain(`-e PACT_MACHINE_TOKEN_NAME=${shellQuote(hostileName)}`);
    expect(hostile).toContain(`-e PACT_MACHINE_TOKEN_SCOPES=${shellQuote(hostileScopes)}`);
    expect(hostile).not.toContain(`-e PACT_MACHINE_TOKEN_NAME=${hostileName}`);
    expect(hostile).not.toContain(`-e PACT_MACHINE_TOKEN_SCOPES=${hostileScopes}`);
  });

  it('keeps the canonical runner invocation, mounts and network', () => {
    expect(script).toContain('--network ecoma-x-network');
    expect(script).toContain(`-v '/repo/worktrees/x':/repo:ro`);
    expect(script).toContain('-w /repo/apps/pact-broker-api');
    expect(script).toContain(
      '/repo/node_modules/.bin/tsx --tsconfig tsconfig.db.json db/provision-machine-token.mts',
    );
  });

  it('is deterministic for the same inputs', () => {
    expect(
      buildMachineTokenProvisionScript({
        networkName: 'ecoma-x-network',
        worktreeRoot: '/repo/worktrees/x',
        nodeImage: NODE_IMAGE,
        tokenName: 'pact-broker-app-bff',
        tokenScopes: 'admin',
      }),
    ).toBe(script);
  });
});
