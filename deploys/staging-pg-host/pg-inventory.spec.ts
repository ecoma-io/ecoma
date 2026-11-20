/**
 * Unit test hợp đồng inventory của staging PostgreSQL host (#349) — module
 * thuần `pg-inventory.ts`, không đụng Pulumi runtime lẫn host thật. Các test
 * khẳng định đúng các bất biến cách ly (§4.1.2, invariant 5/25): inventory
 * khớp 11 DB của issue, 22 role duy nhất, SQL idempotent, không `CONNECT`
 * chéo, và script an toàn trong heredoc shell không quote (không `$$`, không
 * ký tự shell mở rộng được).
 */
import { describe, expect, it } from 'vitest';

import {
  STAGING_PG_DATABASES,
  createDatabaseSql,
  createRolesSql,
  grantsSql,
  migratorRoleName,
  runtimeRoleName,
} from './pg-inventory.js';

describe('staging pg database inventory', () => {
  it('matches the eleven databases of the staging inventory exactly', () => {
    expect([...STAGING_PG_DATABASES].toSorted()).toEqual(
      [
        'db-account',
        'db-auth',
        'db-backoffice',
        'db-staff-access',
        'db-llm-gateway',
        'db-llm-tenant',
        'db-llm-marketplace',
        'db-pact-broker',
        'db-pact-broker-app',
        'db-remote-cache',
        'db-remote-cache-app',
      ].toSorted(),
    );
  });

  it('derives unique shell-safe role names for every database', () => {
    const roles = STAGING_PG_DATABASES.flatMap((db) => [runtimeRoleName(db), migratorRoleName(db)]);
    expect(roles).toHaveLength(22);
    expect(new Set(roles).size).toBe(22);
    // Underscore-only: hợp lệ làm PostgreSQL identifier không quote và làm
    // biến shell (`PW_<role>`) ở caller.
    expect(runtimeRoleName('db-account')).toBe('account_runtime');
    expect(migratorRoleName('db-remote-cache')).toBe('remote_cache_migrator');
    expect(runtimeRoleName('db-pact-broker-app')).toBe('pact_broker_app_runtime');
  });
});

describe('createDatabaseSql', () => {
  it('is idempotent and owned by its own migrator role', () => {
    const sql = createDatabaseSql('db-account');
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).toContain("datname = 'db-account'");
    expect(sql).toContain('CREATE DATABASE "db-account" OWNER "account_migrator"');
  });
});

describe('createRolesSql', () => {
  it('guards creation, rotates the password unconditionally, and stays shell-safe', () => {
    const sql = createRolesSql('db-account', '$PW_account_runtime', '$PW_account_migrator');
    expect(sql).toContain(
      `SELECT 'CREATE ROLE "account_runtime" LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'account_runtime')\\gexec`,
    );
    expect(sql).toContain(
      `ALTER ROLE "account_runtime" WITH LOGIN PASSWORD '$PW_account_runtime';`,
    );
    expect(sql).toContain(
      `ALTER ROLE "account_migrator" WITH LOGIN PASSWORD '$PW_account_migrator';`,
    );
    // Shell-safety: script chạy trong heredoc KHÔNG quote — `$$` bị shell mở
    // rộng thành PID, nên builder không được phát ra ký tự đó.
    expect(sql).not.toContain('$$');
  });

  it('escapes single quotes in password values so no literal can break out of the SQL string', () => {
    const sql = createRolesSql('db-auth', "can't-break", 'quo"te-stays');
    // `'` nháy đơn được nhân đôi (chuỗi SQL escape chuẩn) — không đường chèn
    // nào thoát ra ngoài literal.
    expect(sql).toContain(`ALTER ROLE "auth_runtime" WITH LOGIN PASSWORD 'can''t-break';`);
    // `"` bên trong chuỗi nháy đơn là ký tự dữ liệu — giữ nguyên.
    expect(sql).toContain(`ALTER ROLE "auth_migrator" WITH LOGIN PASSWORD 'quo"te-stays';`);
  });
});

describe('grantsSql', () => {
  it('isolates connect per database and grants only its own role pair', () => {
    const sql = grantsSql('db-account');
    expect(sql).toContain(`REVOKE CONNECT ON DATABASE "db-account" FROM PUBLIC;`);
    expect(sql).toContain(`GRANT CONNECT ON DATABASE "db-account" TO "account_runtime";`);
    expect(sql).toContain(`GRANT CONNECT ON DATABASE "db-account" TO "account_migrator";`);
    expect(sql).toContain(`\\c "db-account"`);
    // Không role/database nào của unit khác xuất hiện trong script này.
    expect(sql).not.toMatch(/db-(auth|backoffice|staff-access)/u);
  });

  it('gives the migrator schema ownership and the runtime default DML only', () => {
    const sql = grantsSql('db-remote-cache');
    expect(sql).toContain(`GRANT USAGE, CREATE ON SCHEMA public TO "remote_cache_migrator";`);
    expect(sql).toContain(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "remote_cache_migrator" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "remote_cache_runtime";`,
    );
    expect(sql).toContain(
      `ALTER DEFAULT PRIVILEGES FOR ROLE "remote_cache_migrator" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "remote_cache_runtime";`,
    );
    expect(sql).not.toContain(`CREATE ON SCHEMA public TO "remote_cache_runtime"`);
  });
});
