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
  DATABASE_NAME,
  MIGRATOR_PASSWORD_ENV_VAR,
  MIGRATOR_ROLE,
  POSTGRES_HOST,
  RUNTIME_PASSWORD_ENV_VAR,
  RUNTIME_ROLE,
  buildMigrateScript,
  buildMigratorConnectionUrl,
  buildProvisionScript,
} from './scripts.ts';

const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

// Sentinel giống hệt suite integration: giá trị KHÔNG BAO GIỜ được truyền vào
// hàm build — assert dưới chỉ chứng minh text sinh ra không bao giờ chứa nó,
// tức script không thể rò secret kể cả khi ai đó tái nhúng interpolation.
const SENTINEL = `S3nt1n3l-RC-Mig'x1%`;

describe('env var name constants', () => {
  it('declares two distinct, deterministic password env var names', () => {
    expect(MIGRATOR_PASSWORD_ENV_VAR).toBe('REMOTE_CACHE_PW_MIGRATOR');
    expect(RUNTIME_PASSWORD_ENV_VAR).toBe('REMOTE_CACHE_PW_RUNTIME');
    expect(MIGRATOR_PASSWORD_ENV_VAR).not.toBe(RUNTIME_PASSWORD_ENV_VAR);
  });
});

describe('buildProvisionScript', () => {
  const script = buildProvisionScript({ postgresContainerName: 'ecoma-x-postgres' });

  it('reads both role passwords by env var NAME, never by value', () => {
    // Shell dereference lúc gọi hàm — giá trị chỉ nằm trong ô nhớ shell.
    expect(script).toContain(`"$${MIGRATOR_PASSWORD_ENV_VAR}"`);
    expect(script).toContain(`"$${RUNTIME_PASSWORD_ENV_VAR}"`);
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
    expect(alterLines).toHaveLength(2);
    for (const line of alterLines) {
      // Mỗi lời gọi chỉ mang TÊN role + TÊN biến môi trường.
      expect(line).toMatch(/^apply_password ecoma_remote_cache_(migrator|runtime) "\$\w+"$/u);
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

describe('buildMigratorConnectionUrl', () => {
  it('builds the migrator URL for db-remote-cache with percent-encoded password', () => {
    expect(buildMigratorConnectionUrl({ password: 'plain-password' })).toBe(
      `postgresql://${MIGRATOR_ROLE}:plain-password@${POSTGRES_HOST}:5432/${DATABASE_NAME}`,
    );
  });

  it('percent-encodes URL-delimiting, shell and whitespace characters in the password', () => {
    // Ký tự delineator userinfo (`@ : / ? # %`) bắt buộc encode; ký tự shell
    // (`$` backtick `;`) và khoảng trắng cũng phải encode để URL luôn parse
    // đúng một segment password. Nháy đơn `'` nằm trong bộ unreserved của
    // encodeURIComponent nên giữ nguyên — parser userinfo của `pg`/`postgres.js`
    // chấp nhận (delimit là `@`/`:`/`/`), contract được ghim đúng như vậy.
    const url = buildMigratorConnectionUrl({ password: `p@ss:wo/rd?x#y%z$w\`v;s néc'k"q\\r` });
    expect(url).toBe(
      `postgresql://${MIGRATOR_ROLE}:` +
        `p%40ss%3Awo%2Frd%3Fx%23y%25z%24w%60v%3Bs%20n%C3%A9c'k%22q%5Cr` +
        `@${POSTGRES_HOST}:5432/${DATABASE_NAME}`,
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
    expect(script).not.toContain('DATABASE_URL=postgresql://');
    expect(script).not.toContain(SENTINEL);
  });

  it('keeps the canonical runner invocation, mounts and network', () => {
    expect(script).toContain('--network ecoma-x-network');
    expect(script).toContain(`-v '/repo/worktrees/x':/repo:ro`);
    expect(script).toContain(`-v '/repo/worktrees/x'/node_modules:/repo/node_modules`);
    expect(script).toContain('-w /repo/apps/remote-cache-api');
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
