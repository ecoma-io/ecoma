/**
 * Spec unit của hàm build script (`scripts.ts`) — colocated với subject, chạy
 * target `test` (không Docker, không PostgreSQL).
 *
 * Phạm vi: TEXT của script không chứa giá trị secret nào và chỉ đọc mật khẩu/
 * chuỗi kết nối qua TÊN biến môi trường; hàm `sql_quote` TRONG script text thật
 * được chạy bằng POSIX shell thật (`/bin/sh`) để chứng minh escaping giữ nguyên
 * ngữ nghĩa quoting SQL cho mật khẩu chứa ký tự đặc biệt; các guard fail-closed
 * (phép gán kết quả kiểm tra vào biến) và vòng chặn chéo `for TARGET` của
 * baseline được bảo toàn nguyên văn. Bằng chứng "không argv khi CHẠY THẬT"
 * (shim docker ghi argv + sweep proc-cmdline + PostgreSQL thật) nằm ở suite
 * integration `tests/integrations/argv-hygiene.spec.ts` — target
 * `test-integration`; spec này khoá bất biến tĩnh của text để một sửa đổi vô
 * tình tái nhúng giá trị vào script bị bắt ngay ở tầng unit.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  MIGRATOR_PASSWORD_ENV_VAR,
  RUNTIME_PASSWORD_ENV_VAR,
  buildMigrateScript,
  buildProvisionScript,
} from './scripts.ts';

const NODE_IMAGE =
  'node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5';

// Sentinel giống hệt suite integration: giá trị KHÔNG BAO GIỜ được truyền vào
// hàm build — assert dưới chỉ chứng minh text sinh ra không bao giờ chứa nó,
// tức script không thể rò secret kể cả khi ai đó tái nhúng interpolation.
const SENTINEL = `S3nt1n3l-St'x1%@:/?#`;

/** Tên role và TÊN biến môi trường tương ứng — cặp không thể lệch giữa hai phía. */
const PASSWORD_ROLES: ReadonlyArray<readonly [string, string]> = [
  ['ecoma_staff_access_migrator', MIGRATOR_PASSWORD_ENV_VAR],
  ['ecoma_staff_access_runtime', RUNTIME_PASSWORD_ENV_VAR],
];

describe('password env var names', () => {
  it('are two distinct, deterministic, stable names and never cover a shared owner role', () => {
    const names = PASSWORD_ROLES.map(([, envVar]) => envVar);
    expect(names).toEqual(['STAFF_PW_MIGRATOR', 'STAFF_PW_RUNTIME']);
    // Bounded context này KHÔNG có owner role dùng chung (ADR-0020 Quyết định
    // 11): không được xuất hiện biến môi trường mật khẩu nào khác, và script
    // không ALTER password role nào ngoài hai role của db-staff-access. Mọi
    // ALTER đều đi qua apply_password (`ALTER ROLE $1 ...` — thân hàm generic,
    // call sites đã được khoá đúng hai role bởi assert `apply_password`), nên
    // KHÔNG được có dòng nào ALTER một TÊN role literal.
    expect(literalRoleAlterLines()).toEqual([]);
  });
});

/** Script provision dùng cho các assert phía dưới. */
const provisionScript = buildProvisionScript({ postgresContainerName: 'ecoma-x-postgres' });

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
    // `$PSQL -c '<ALTER ROLE ... PASSWORD ...>'` với giá trị nội suy vào argv.
    expect(
      provisionScript
        .split('\n')
        .filter((line) => line.includes('$PSQL -c') && line.includes('PASSWORD')),
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

  it('keeps the fail-closed existence checks assigned to variables, verbatim', () => {
    // Baseline: 'set -e' không áp dụng cho điều kiện của 'if', nên một lần psql
    // lỗi phải dừng script qua phép gán — guard rơi vào dạng if mà không gán
    // là một regression fail-open.
    for (const role of ['ecoma_staff_access_migrator', 'ecoma_staff_access_runtime']) {
      const variable =
        role === 'ecoma_staff_access_migrator' ? 'MIGRATOR_EXISTS' : 'RUNTIME_EXISTS';
      expect(provisionScript).toContain(
        `${variable}=$($PSQL -tAc "SELECT 1 FROM pg_roles WHERE rolname='${role}'")`,
      );
      expect(provisionScript).toContain(`if [ "$${variable}" != "1" ]`);
    }
    expect(provisionScript).toContain(`DATABASE_EXISTS=$($PSQL -tAc`);
    expect(provisionScript).toContain(`if [ "$DATABASE_EXISTS" != "1" ]`);
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
      `pct%@colon:slash/slash?q#hash`, // ký tự dành riêng của URL — đường percent-encode
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

  it('keeps idempotent guard-create, grants, the cross-revoke loop and public hardening', () => {
    for (const [role] of PASSWORD_ROLES) {
      expect(provisionScript).toContain(`CREATE ROLE ${role} LOGIN NOSUPERUSER`);
    }
    expect(provisionScript).toContain(`CREATE DATABASE "db-staff-access"`);
    expect(provisionScript).toContain(
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "db-staff-access"`,
    );
    expect(provisionScript).toContain(`GRANT CONNECT ON DATABASE "db-staff-access"`);
    // Vòng chặn chéo chiều RA — baseline giữ nguyên cả danh sách database đích.
    expect(provisionScript).toContain(`for TARGET in db-account db-auth db-backoffice; do`);
    expect(provisionScript).toContain(
      `REVOKE CONNECT ON DATABASE \\"$TARGET\\" FROM ecoma_staff_access_migrator`,
    );
    expect(provisionScript).toContain(
      `REVOKE CONNECT ON DATABASE \\"$TARGET\\" FROM ecoma_staff_access_runtime`,
    );
    expect(provisionScript).toContain(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  });

  it('is deterministic for the same inputs', () => {
    expect(buildProvisionScript({ postgresContainerName: 'ecoma-x-postgres' })).toBe(
      provisionScript,
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
    expect(script).toContain('-w /repo/apps/staff-access');
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
