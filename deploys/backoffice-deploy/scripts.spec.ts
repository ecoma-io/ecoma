/**
 * Spec unit của hàm build script (`scripts.ts`) — colocated với subject, chạy
 * target `test` (không Docker, không PostgreSQL).
 *
 * Phạm vi: TEXT của script không chứa giá trị secret nào và chỉ đọc mật khẩu
 * qua TÊN biến môi trường; hàm `sql_quote` TRONG script text thật được chạy
 * bằng POSIX shell thật (`/bin/sh`) để chứng minh escaping giữ nguyên ngữ nghĩa
 * quoting SQL cho mật khẩu chứa ký tự đặc biệt; các guard idempotent và pipe
 * migration (advisory lock + shellQuote worktree) của baseline được bảo toàn
 * nguyên văn. Bằng chứng "không argv khi CHẠY THẬT" (shim docker ghi argv +
 * sweep proc-cmdline + PostgreSQL thật) nằm ở suite integration
 * `tests/integrations/argv-hygiene.spec.ts` — target `test-integration`; spec
 * này khoá bất biến tĩnh của text để một sửa đổi vô tình tái nhúng giá trị vào
 * script bị bắt ngay ở tầng unit.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  MIGRATOR_PASSWORD_ENV_VAR,
  RUNTIME_PASSWORD_ENV_VAR,
  buildProvisionScript,
} from './scripts.ts';

// Sentinel giống hệt suite integration: giá trị KHÔNG BAO GIỜ được truyền vào
// hàm build — assert dưới chỉ chứng minh text sinh ra không bao giờ chứa nó,
// tức script không thể rò secret kể cả khi ai đó tái nhúng interpolation.
const SENTINEL = `S3nt1n3l-Bo'x1%@:/?#`;

/** Tên role và TÊN biến môi trường tương ứng — cặp không thể lệch giữa hai phía. */
const PASSWORD_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['ecoma_backoffice_migrator', MIGRATOR_PASSWORD_ENV_VAR],
  ['ecoma_backoffice_runtime', RUNTIME_PASSWORD_ENV_VAR],
];

describe('password env var names', () => {
  it('are two distinct, deterministic, stable names and never ALTER a literal role name', () => {
    const names = PASSWORD_ROLES.map(([, envVar]) => envVar);
    expect(names).toEqual(['BACKOFFICE_PW_MIGRATOR', 'BACKOFFICE_PW_RUNTIME']);
    // Mọi ALTER đều đi qua apply_password (`ALTER ROLE $1 ...` — thân hàm
    // generic, call sites được khoá đúng hai role bởi assert `apply_password`
    // ở dưới), nên KHÔNG được có dòng nào ALTER một TÊN role literal.
    expect(literalRoleAlterLines()).toEqual([]);
  });
});

/** Script provision dùng cho các assert phía dưới. */
const provisionScript = buildProvisionScript({
  postgresContainerName: 'ecoma-x-postgres',
  worktreeRoot: '/repo/worktrees/x',
});

function literalRoleAlterLines(): string[] {
  return provisionScript
    .split('\n')
    .filter((line) => /ALTER ROLE ecoma_\w+ WITH PASSWORD/u.test(line));
}

describe('buildProvisionScript', () => {
  it('reads both passwords by env var NAME, never by value', () => {
    for (const [, envVar] of PASSWORD_ROLES) {
      // Shell dereference lúc gọi hàm — giá trị chỉ nằm trong ô nhớ shell.
      expect(provisionScript).toContain(`"$${envVar}"`);
    }
    expect(provisionScript).not.toContain(SENTINEL);
  });

  it('feeds ALTER ROLE password SQL to psql via STDIN, not via -c', () => {
    expect(provisionScript).toContain('docker exec -i $PG psql');
    expect(provisionScript).toContain('| $PSQL_STDIN');
    // Không còn dòng nào áp password qua `-c`: pattern của baseline cũ là
    // `psql ... -c '<ALTER ROLE ... PASSWORD ...>'` với giá trị nội suy vào argv.
    expect(
      provisionScript
        .split('\n')
        .filter(
          (line) => line.includes('psql') && line.includes('-c') && line.includes('PASSWORD'),
        ),
    ).toEqual([]);
    const alterLines = provisionScript
      .split('\n')
      .filter((line) => line.startsWith('apply_password '));
    // Mỗi lời gọi chỉ mang TÊN role + TÊN biến môi trường, đúng thứ tự khai
    // báo của PASSWORD_ROLES (2 phần tử — chính là độ dài mong đợi).
    expect(alterLines).toEqual(
      PASSWORD_ROLES.map(([role, envVar]) => `apply_password ${role} "$${envVar}"`),
    );
  });

  it('keeps the idempotent shell guards for database and both roles, verbatim', () => {
    expect(provisionScript).toContain(
      `SELECT 1 FROM pg_database WHERE datname='db-backoffice'" | grep -q 1`,
    );
    for (const [role] of PASSWORD_ROLES) {
      expect(provisionScript).toContain(
        `SELECT 1 FROM pg_roles WHERE rolname='${role}'" | grep -q 1`,
      );
      expect(provisionScript).toContain(`CREATE ROLE ${role} LOGIN NOSUPERUSER`);
    }
    expect(provisionScript).toContain(`CREATE DATABASE "db-backoffice"`);
  });

  it('SQL-quotes the password in-shell through sed stdin, without bashisms', () => {
    expect(provisionScript).toContain(`printf '%s' "$1" | sed "s/'/''/g"`);
    // Provider chạy `/bin/sh -c` (dash): script phải POSIX — cấm bashism phổ biến.
    expect(provisionScript).not.toMatch(/\$\{!\w/u); // indirect expansion ${!var}
    expect(provisionScript).not.toMatch(/\$\{\w+\/\//u); // ${var//pattern/repl}
    expect(provisionScript).not.toMatch(/\blocal \w+/u); // `local` (extension phổ biến)
    expect(provisionScript).not.toMatch(/\bdeclare\b|\barray\b/u);
  });

  it('escapes special-character passwords exactly like the shared sqlQuote (real /bin/sh)', () => {
    // Trích ĐÚNG định nghĩa `sql_quote` từ script text đã render (không copy
    // tay) rồi chạy bằng POSIX shell thật: mật khẩu vào bằng biến môi trường
    // (không argv), output phải là literal SQL chuẩn — nháy đơn bị nhân đôi,
    // mọi ký tự khác giữ nguyên byte-for-byte.
    const match = /^sql_quote\(\) \{\n([\s\S]*?)\n\}$/mu.exec(provisionScript);
    if (match === null) {
      throw new Error('sql_quote definition not found in rendered provision script text');
    }
    const sqlQuoteFn = match[0];
    const specialPasswords = [
      `it's-a-pass`, // nháy đơn — nhân đôi
      `dq"back\\slash`, // nháy kép + backslash — literal dưới standard_conforming_strings
      `dollar$;semi\`tick;`, // $ ` ; — phải giữ nguyên (không expansion)
      `pct%@colon:slash/slash?q#hash`, // ký tự dành riêng của URL — đường STDIN phải giữ nguyên
      `uniâ space x`, // unicode + khoảng trắng
    ];
    for (const password of specialPasswords) {
      const probe = `${sqlQuoteFn}\nprintf '%s' "$(sql_quote "$PW")"\n`;
      const run = spawnSync('/bin/sh', ['-c', probe], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PW: password },
      });
      expect(run.status).toBe(0);
      // Ngữ nghĩa quoting SQL của sql_quote: nháy đơn → hai nháy đơn, mọi ký
      // tự khác nguyên (ngoặc `'...'` bọc ngoài là việc của apply_password).
      expect(run.stdout).toBe(password.replace(/'/gu, "''"));
    }
  });

  it('keeps the migrator grant, public hardening and the inline migration pipe, verbatim', () => {
    expect(provisionScript).toContain(
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "db-backoffice" TO ecoma_backoffice_migrator;`,
    );
    expect(provisionScript).toContain(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    // Pipe migration — baseline giữ nguyên: advisory lock bao quanh, cat toàn
    // bộ file SQL qua shellQuote(worktreeRoot), ON_ERROR_STOP dừng.
    expect(provisionScript).toContain(`SELECT pg_advisory_lock(hashtext('db-backoffice'));`);
    expect(provisionScript).toContain(`SELECT pg_advisory_unlock(hashtext('db-backoffice'));`);
    expect(provisionScript).toContain(`'/repo/worktrees/x'/apps/backoffice/db/migrations/*.sql`);
    expect(provisionScript).toContain(
      `| docker exec -i "$PG" psql -U ecoma_backoffice_migrator -d db-backoffice -v ON_ERROR_STOP=1`,
    );
    // Pipe mang đúng TÊN role migrator — không giá trị mật khẩu nào trong nó.
    expect(provisionScript).not.toMatch(/PGPASSWORD/u);
  });

  it('is deterministic for the same inputs', () => {
    expect(
      buildProvisionScript({
        postgresContainerName: 'ecoma-x-postgres',
        worktreeRoot: '/repo/worktrees/x',
      }),
    ).toBe(provisionScript);
  });
});
