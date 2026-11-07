/**
 * Apply migration `db-remote-cache` qua **runner canonical** (`db/apply.mts`)
 * trên PostgreSQL thật.
 *
 * ⚠️ Không dùng `describe.skipIf`: suite PG của repo đã đổi sang fail-loud —
 * `globalSetup` probe Docker một lần mỗi lần chạy và vắng Docker là lỗi thật,
 * không phải nửa suite skip với exit 0.
 *
 * ⚠️ Đường code được test là ĐÚNG hàm mà CLI `db:migrate` chạy —
 * `applyAllMigrations` của `db/apply.mts`, gồm advisory lock, assert
 * `current_database()` và đếm bảng sau apply. Runner này không có bảng ledger:
 * tính idempotent của DDL là thứ làm re-apply thành no-op, và catalog sau apply
 * là nguồn sự thật.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAllMigrations } from '../../db/apply.mts';
import { REMOTE_CACHE_DATABASE, listMigrations } from '../../db/migrate.mts';
import { type RemoteCacheDatabase, startRemoteCacheDatabase } from '../integrations/harness.ts';

let db: RemoteCacheDatabase;

beforeAll(async () => {
  db = await startRemoteCacheDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

describe('remote-cache migration runner on a real PostgreSQL', () => {
  it('applies every migration file from an empty database, leaving the catalog as truth', async () => {
    const migrator = await db.connectAsMigrator();
    try {
      const files = listMigrations();
      const result = await applyAllMigrations(migrator);

      expect(result.applied).toBe(files.length);

      // Không có bảng lịch sử để đối chiếu: catalog là nguồn sự thật duy nhất —
      // đếm bảng `CREATE TABLE remote_cache.*` (8 bảng: 5 bảng data P4.1/P4.2 +
      // 3 bảng P4.3 quota_limits, usage_counters, audit_log) qua catalog thật.
      const { rows } = await migrator.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'remote_cache' AND c.relkind IN ('r', 'p')
          ORDER BY c.relname`,
      );
      expect(rows.map((row) => row.relname)).toEqual(
        [
          'api_keys',
          'audit_log',
          'cache_entries',
          'projects',
          'quota_limits',
          'tenant_members',
          'tenants',
          'usage_counters',
        ].toSorted(),
      );
      expect(result.tablesInRemoteCacheSchema).toBe(8);
    } finally {
      await migrator.end();
    }
  });

  it('re-running applies every file again as a no-op (idempotent DDL, no ledger)', async () => {
    // Runner không có ledger — nó chạy LẠI mọi file. Tính idempotent của DDL
    // (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`) là thứ
    // làm lần chạy thứ hai thành công mà không đổi gì: applied = số file,
    // schema vẫn 5 bảng. Một migration mất idempotency lộ ngay ở đây.
    const migrator = await db.connectAsMigrator();
    try {
      const result = await applyAllMigrations(migrator);
      expect(result.applied).toBe(listMigrations().length);
      expect(result.tablesInRemoteCacheSchema).toBe(8);
    } finally {
      await migrator.end();
    }
  });

  it('takes the advisory lock keyed to db-remote-cache, distinct from the db-staff-access key', async () => {
    // Khóa là `hashtext('db-remote-cache')` phía server — test giữ chính khóa
    // đó ở session khác; runner lấy đúng key ⇒ apply bị chặn bởi lock, và
    // `lock_timeout` ngắn biến chỗ bị chặn thành lỗi đo được thay vì treo suite.
    const holder = await db.connect();
    const runner = await db.connectAsMigrator();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', [REMOTE_CACHE_DATABASE]);

      await runner.query(`SET lock_timeout = '500ms'`);
      await expect(applyAllMigrations(runner)).rejects.toThrow(/lock timeout/iu);

      // Khóa đối xứng: hai database khác nhau không tranh cùng một khóa —
      // giữ khóa db-remote-cache xong, khóa db-staff-access vẫn lấy được.
      await holder.query('SELECT pg_advisory_lock(hashtext($1))', ['db-staff-access']);
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', ['db-staff-access']);
    } finally {
      await runner.query('RESET lock_timeout').catch(() => undefined);
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [REMOTE_CACHE_DATABASE]);
      await holder.end();
      await runner.end();
    }
  });

  it('refuses to run against a different database (current_database guard)', async () => {
    // Guard #101 (pattern staff-access): runner pin tên database — `DATABASE_URL`
    // trỏ nhầm database khác phải fail-loud trước khi một DDL nào chạm đích.
    // `postgres` database có sẵn trong mọi image PostgreSQL và KHÔNG phải
    // `db-remote-cache` — đúng hình "URL trỏ sai".
    const pg = (await import('pg')).default;
    const wrongDb = new pg.Client({
      host: db.host,
      port: db.port,
      user: 'ecoma_remote_cache_migrator',
      password: db.rolePassword,
      database: 'postgres',
      application_name: 'ecoma-remote-cache-itest-wrongdb',
    });
    await wrongDb.connect();
    try {
      await expect(applyAllMigrations(wrongDb)).rejects.toThrow(
        /expected database "db-remote-cache"/u,
      );
    } finally {
      await wrongDb.end();
    }
  });

  it('leaves schema remote_cache owned by the migrator', async () => {
    // `CREATE SCHEMA` chạy từ session migrator: owner phải là
    // `ecoma_remote_cache_migrator` — điều kiện để các lần chạy sau của chính
    // runner luôn ghi được DDL mà không cần ai cấp quyền thêm.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ nspowner: string }>(
        `SELECT pg_get_userbyid(n.nspowner) AS nspowner
           FROM pg_namespace n WHERE n.nspname = 'remote_cache'`,
      );
      expect(rows[0]?.nspowner).toBe('ecoma_remote_cache_migrator');
    } finally {
      await client.end();
    }
  });

  it('keeps tenant CHECK vocabularies closed to the ADR-0015 lifecycle labels', async () => {
    const client = await db.connect();
    try {
      const { rows: constraintRows } = await client.query<{ conname: string }>(
        `SELECT con.conname
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = 'remote_cache' AND con.contype = 'c'
          ORDER BY con.conname`,
      );
      const constraints = constraintRows.map((row) => row.conname);
      // CHECK định nghĩa khả năng của schema — tập đầy đủ phải khớp đúng
      // migration, CHECK lạ xuất hiện cũng phải đỏ như CHECK thiếu.
      expect(constraints).toEqual(
        [
          'api_key_revoked_at_after_created_check',
          'api_key_scopes_check',
          'audit_log_action_check',
          'audit_log_outcome_check',
          'cache_entries_size_positive',
          'projects_name_check',
          'quota_limits_nonnegative',
          'tenants_name_check',
          'tenants_status_check',
          'tenant_members_role_check',
          'usage_counters_nonnegative',
        ].toSorted(),
      );

      // Status tenant: đúng ba nhãn lifecycle của ADR-0015 — chèn nhãn lạ phải
      // chết ở CHECK, không phải ở lỗi type hay thứ tự cột.
      await expect(
        client.query(
          `INSERT INTO remote_cache.tenants (name, status) VALUES ('check-tenant', 'terminated')`,
        ),
      ).rejects.toThrow(/tenants_status_check|violates check constraint/iu);
      await expect(
        client.query(
          `INSERT INTO remote_cache.tenants (name, status) VALUES ('check tenant', 'active')`,
        ),
      ).rejects.toThrow(/tenants_name_check|violates check constraint/iu);
    } finally {
      await client.end();
    }
  });
});
