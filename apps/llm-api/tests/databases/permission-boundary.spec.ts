/**
 * Ranh giới quyền runtime/migrator trên ba database LLM — hợp đồng đóng băng của
 * PR #113 (Issue #22): migrator có DDL trong DB của mình, runtime chỉ CONNECT +
 * DML qua default privileges, chặn chéo CONNECT cross-database cho PUBLIC lẫn
 * role, migrator không tạo role được.
 *
 * Đây là những test **quan trọng nhất** của suite, vì chúng kiểm chứng những thứ
 * mà review không nhìn thấy: một `GRANT` thừa hay một `REVOKE` không có tác dụng
 * đều để mọi test khác xanh. Mọi kết nối tiêu cực đều dùng **credential thật**,
 * không `SET ROLE` — ranh giới phải đo được ở tầng kết nối.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  databaseName,
  type LlmApiDatabase,
  type LlmDatabaseKey,
  migratorRole,
  runtimeRole,
  startLlmApiDatabase,
} from '../integrations/harness.ts';

const ALL_KEYS: readonly LlmDatabaseKey[] = ['gateway', 'tenant', 'marketplace'];

describe('runtime/migrator permission boundary on the llm-api databases', () => {
  let db: LlmApiDatabase;

  beforeAll(async () => {
    db = await startLlmApiDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('denies the runtime role CREATE TABLE in its own schema', async () => {
    const runtime = await db.connectAsRuntime('gateway');
    try {
      // Runtime chỉ có USAGE trên schema llm_financial; CREATE là quyền schema
      // của migrator (owner). DML runtime đến từ default privileges, không từ CREATE.
      await expect(
        runtime.query('CREATE TABLE llm_financial.runtime_probe (id int)'),
      ).rejects.toThrow(/permission denied/iu);
      await expect(runtime.query('CREATE SCHEMA llm_runtime_probe')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('lets the runtime role run full DML on a table the migrator created (default privileges)', async () => {
    // Hợp đồng `ALTER DEFAULT PRIVILEGES FOR ROLE <migrator>`: bảng migrator tạo
    // SAU 0001 tự mang grant SELECT/INSERT/UPDATE/DELETE cho runtime. Bảng fixture
    // là hàng thật — DML đủ bốn hành động bằng credential thật của runtime.
    const migrator = await db.connectAsMigrator('gateway');
    try {
      await migrator.query('CREATE TABLE llm_financial.dml_fixture (id int, note text)');
    } finally {
      await migrator.end();
    }

    const runtime = await db.connectAsRuntime('gateway');
    try {
      await runtime.query(
        `INSERT INTO llm_financial.dml_fixture (id, note) VALUES (1, 'runtime-writes')`,
      );
      const { rows: selected } = await runtime.query<{ id: number; note: string }>(
        `SELECT id, note FROM llm_financial.dml_fixture WHERE id = 1`,
      );
      expect(selected[0]?.note).toBe('runtime-writes');
      await runtime.query(
        `UPDATE llm_financial.dml_fixture SET note = 'runtime-updates' WHERE id = 1`,
      );
      const { rows: updated } = await runtime.query<{ note: string }>(
        `SELECT note FROM llm_financial.dml_fixture WHERE id = 1`,
      );
      expect(updated[0]?.note).toBe('runtime-updates');
      await runtime.query(`DELETE FROM llm_financial.dml_fixture WHERE id = 1`);
      const { rows: afterDelete } = await runtime.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM llm_financial.dml_fixture`,
      );
      expect(afterDelete[0]?.count).toBe('0');
    } finally {
      await runtime.end();
      const cleanup = await db.connectAsMigrator('gateway');
      try {
        await cleanup.query('DROP TABLE IF EXISTS llm_financial.dml_fixture');
      } finally {
        await cleanup.end();
      }
    }
  });

  it('denies a migrator credential a connection to another database of the unit', async () => {
    // Chặn chéo cross-DB: ecoma_llm_gateway_migrator chỉ có CONNECT, CREATE, TEMP
    // trên db-llm-gateway; db-llm-tenant không grant gì cho nó (provisioning step 1).
    await expect(
      db.openWithCredentials({
        user: migratorRole('gateway'),
        password: db.rolePassword,
        database: 'db-llm-tenant',
      }),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('denies a runtime credential a connection to another database of the unit', async () => {
    // Runtime chỉ CONNECT trên DB của mình; DB khác của unit phải chặn ở tầng kết nối.
    await expect(
      db.openWithCredentials({
        user: runtimeRole('gateway'),
        password: db.rolePassword,
        database: 'db-llm-tenant',
      }),
    ).rejects.toThrow(/permission denied/iu);
  });

  it('lets each runtime credential connect to its own database', async () => {
    // Mặt dương của cùng ranh giới: CONNECT của runtime là đủ để mở phiên —
    // đúng hình production nơi Worker kết nối Hyperdrive bằng credential này.
    for (const key of ALL_KEYS) {
      const runtime = await db.connectAsRuntime(key);
      try {
        const { rows } = await runtime.query<{ current_database: string }>(
          `SELECT current_database() AS current_database`,
        );
        expect(rows[0]?.current_database).toBe(databaseName(key));
      } finally {
        await runtime.end();
      }
    }
  });

  it('leaves PUBLIC without CONNECT on all three databases', async () => {
    // `REVOKE CONNECT ... FROM PUBLIC` của provisioning step 1: không role nào
    // ngoài danh sách được kết nối kể cả khi chưa GRANT riêng — đọc `pg_database.datacl`
    // của từng DB (PUBLIC không phải tên role, nên `has_database_privilege('PUBLIC')`
    // không dùng được; pattern so sánh với entry `=` của `nspacl` ở remote-cache roles.spec).
    const client = await db.connect();
    try {
      for (const key of ALL_KEYS) {
        const { rows } = await client.query<{ datacl: string[] | string }>(
          `SELECT d.datacl AS datacl
             FROM pg_database d
            WHERE d.datname = $1`,
          [databaseName(key)],
        );
        // `aclitem[]` không có parser trong pg nên về dạng chuỗi `{"=Tc/owner",...}`
        // (không phải mảng JS) — tự tách dấu ngoặc và dấu phẩy.
        const rawAcl = rows[0]?.datacl;
        const entriesList: string[] = Array.isArray(rawAcl)
          ? rawAcl
          : String(rawAcl ?? '')
              .replace(/^[{]/u, '')
              .replace(/[}]$/u, '')
              .split(',');
        const entries = entriesList.filter((item) => item.length > 0);
        // Mỗi ACL item là `grantee=privileges/grantor`; grantee rỗng (`=` đầu chuỗi) là PUBLIC.
        const publicPrivileges = entries
          .map((item) => item.split('='))
          .find(([grantee]) => grantee === '')?.[1]
          ?.split('/')[0];
        expect(publicPrivileges).toBeDefined();
        // ACL letter của CONNECT là `c` viết thường (`C` hoa là CREATE — quyền khác).
        expect(publicPrivileges).not.toContain('c');
      }
    } finally {
      await client.end();
    }
  });

  it('denies the migrator role role creation', async () => {
    // Migrator là NOCREATEROLE/NOCREATEREDB: nó không tự tạo thêm role — việc
    // tạo role thuộc provisioning step 1 của admin/owner, không thuộc migration.
    const migrator = await db.connectAsMigrator('gateway');
    try {
      await expect(
        migrator.query(`CREATE ROLE llm_api_probe_login LOGIN PASSWORD 'probe'`),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await migrator.end();
    }
  });
});
