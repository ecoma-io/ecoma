/**
 * Grant, ranh giới database và enforcement mức database — ADR-0015, pattern
 * roles.spec của staff-access.
 *
 * Đây là những test **quan trọng nhất** của suite, vì chúng kiểm chứng những thứ
 * mà review không nhìn thấy: một `GRANT` thừa, một `REVOKE` không có tác dụng,
 * hay một trigger tắt đi đều để mọi test khác xanh.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  getApiKeyByTokenHash,
  insertApiKey,
  insertProject,
  revokeApiKey,
  type RemoteCacheQueryable,
} from '@ecoma-io/remote-cache-infrastructure';

import { type RemoteCacheDatabase, startRemoteCacheDatabase } from './harness.ts';

const RUNTIME = 'ecoma_remote_cache_runtime';

/**
 * Grant kỳ vọng của runtime, theo đúng `0002_roles_and_grants.sql`, theo từng
 * bảng — giữ danh sách tường minh, không suy ra từ quy tắc chung:
 *
 * - `tenants`: SELECT + INSERT + UPDATE — skeleton P4.1 có đường seed tenant;
 *   lifecycle change (suspend/delete) là UPDATE status hợp lệ.
 * - `projects`: SELECT + INSERT — skeleton chỉ tạo và đọc project; UPDATE
 *   không nằm trong vòng đời P4.1.
 * - `tenant_members`: chỉ SELECT — membership administration chưa thuộc
 *   skeleton (ADR-0015 §vẫn mở).
 * - `api_keys`: SELECT + INSERT; UPDATE **chỉ ở cấp cột** `revoked_at`.
 *   has_table_privilege bất khả tri cấp cột, sweep tính bằng table-level ACL —
 *   UPDATE cột khác được test riêng dưới đây.
 * - `cache_entries`: SELECT + INSERT — data plane (P4.2) chỉ đọc ghi metadata;
 *   UPDATE/DELETE/REVOKE không có (immutability qua trigger, re-PUT bị 409).
 * - `quota_limits`: chỉ SELECT — data plane (P4.3) đọc quota limit để kiểm tra
 *   ghi; không INSERT/UPDATE/DELETE trên data plane (quota limit được control
 *   plane cấu hình qua migrator credential, không phải runtime).
 * - `usage_counters`: SELECT + INSERT + UPDATE — data plane (P4.3) cập nhật bộ
 *   đếm sau mỗi ghi thành công qua `upsertUsageCounter` (`INSERT ... ON CONFLICT
 *   DO UPDATE`) và `rebuildUsageCounter`; không DELETE (migrator seed ban đầu).
 * - `audit_log`: SELECT + INSERT — data plane (P4.3) chỉ append; `insertAuditLog`
 *   dùng `RETURNING id` cần SELECT; không UPDATE/DELETE trên runtime (append-only, R15).
 */
const EXPECTED_PRIVILEGES: Record<string, readonly string[]> = {
  api_keys: ['INSERT', 'SELECT'],
  audit_log: ['INSERT', 'SELECT'],
  cache_entries: ['INSERT', 'SELECT'],
  projects: ['INSERT', 'SELECT'],
  quota_limits: ['SELECT'],
  tenant_members: ['SELECT'],
  tenants: ['INSERT', 'SELECT', 'UPDATE'],
  usage_counters: ['INSERT', 'SELECT', 'UPDATE'],
};

/** Bỏ comment `--` ra khỏi SQL trước khi quét nội dung (pattern roles.spec). */
function executableSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const marker = line.indexOf('--');
      return marker === -1 ? line : line.slice(0, marker);
    })
    .join('\n');
}

describe('roles and grants on db-remote-cache', () => {
  let db: RemoteCacheDatabase;

  beforeAll(async () => {
    db = await startRemoteCacheDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('ADR-0015: the runtime role holds exactly the intended table privileges', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ table_name: string; privileges: string[] }>(
        `SELECT c.relname AS table_name,
                array_remove(ARRAY[
                  CASE WHEN has_table_privilege($1, c.oid, 'SELECT')     THEN 'SELECT' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'INSERT')     THEN 'INSERT' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'UPDATE')     THEN 'UPDATE' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'DELETE')     THEN 'DELETE' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'TRUNCATE')   THEN 'TRUNCATE' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'TRIGGER')    THEN 'TRIGGER' END,
                  CASE WHEN has_table_privilege($1, c.oid, 'REFERENCES') THEN 'REFERENCES' END
                ], NULL) AS privileges
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'remote_cache' AND c.relkind = 'r'
          ORDER BY c.relname`,
        [RUNTIME],
      );

      const actual = Object.fromEntries(
        rows.map((row) => [row.table_name, [...row.privileges].toSorted()]),
      );

      // So sánh theo từng bảng **và** theo tập bảng: một bảng lạ xuất hiện
      // trong schema cũng phải làm test đỏ, chứ không bị lọc nhầm.
      expect(Object.keys(actual).toSorted()).toEqual(Object.keys(EXPECTED_PRIVILEGES).toSorted());
      expect(actual).toEqual(EXPECTED_PRIVILEGES);

      // api_keys không DELETE: revocation là SET revoked_at, không phải xóa hàng
      // (reconstructible — một key đã revoke phải đọc được lịch sử từ DB state).
      expect(actual['api_keys']).not.toContain('DELETE');
      // api_keys UPDATE phải ở cấp cột revoked_at: has_column_privilege dương
      // cho revoked_at, âm cho token_hash và scopes — hai chiều cùng một câu.
      const { rows: colRows } = await client.query<{
        can_revoked_at: boolean;
        can_token_hash: boolean;
        can_scopes: boolean;
        can_project_id: boolean;
      }>(
        `SELECT has_column_privilege($1, 'remote_cache.api_keys', 'revoked_at', 'UPDATE') AS can_revoked_at,
                has_column_privilege($1, 'remote_cache.api_keys', 'token_hash', 'UPDATE') AS can_token_hash,
                has_column_privilege($1, 'remote_cache.api_keys', 'scopes', 'UPDATE') AS can_scopes,
                has_column_privilege($1, 'remote_cache.api_keys', 'project_id', 'UPDATE') AS can_project_id`,
        [RUNTIME],
      );
      expect(colRows[0]?.can_revoked_at).toBe(true);
      expect(colRows[0]?.can_token_hash).toBe(false);
      expect(colRows[0]?.can_scopes).toBe(false);
      expect(colRows[0]?.can_project_id).toBe(false);

      // cache_entries: `insertCacheEntry` dung `ON CONFLICT DO UPDATE SET
      // expires_at` -> can UPDATE cot expires_at (cap cot, bang-level chi
      // SELECT + INSERT).
      const { rows: cacheColRows } = await client.query<{
        can_expires_at: boolean;
        can_size_bytes: boolean;
      }>(
        `SELECT has_column_privilege($1, 'remote_cache.cache_entries', 'expires_at', 'UPDATE') AS can_expires_at,
                has_column_privilege($1, 'remote_cache.cache_entries', 'size_bytes', 'UPDATE') AS can_size_bytes`,
        [RUNTIME],
      );
      expect(cacheColRows[0]?.can_expires_at).toBe(true);
      expect(cacheColRows[0]?.can_size_bytes).toBe(false);
    } finally {
      await client.end();
    }
  });

  it('ADR-0015: the runtime role cannot create anything in the remote_cache schema', async () => {
    const runtime = await db.asRuntime();
    try {
      await expect(runtime.query('CREATE TABLE remote_cache.extra (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
      await expect(runtime.query('CREATE SCHEMA remote_cache_more')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('ADR-0015: the runtime role cannot write human membership', async () => {
    // Grant sweep (test trên) là catalog; test này là **hành vi** — INSERT thật
    // bằng credential thật phải bị PostgreSQL từ chối.
    const runtime = await db.connectAsRuntime();
    const migrator = await db.asMigrator();
    try {
      const { rows } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name) VALUES ('member-guard-tenant') RETURNING id`,
      );
      const tenantId = rows[0]?.id ?? '';

      await expect(
        runtime.query(
          `INSERT INTO remote_cache.tenant_members (tenant_id, member_sub)
           VALUES ($1, 'sub_' || repeat('a', 32))`,
          [tenantId],
        ),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
      await migrator.end();
    }
  });

  it('SR-008 pattern: the migrator role can do DDL while the runtime role cannot', async () => {
    const migrator = await db.asMigrator();
    try {
      await migrator.query('CREATE TABLE remote_cache.migrator_probe (id int)');

      // Không assert bằng "không ném" — đọc `relkind` để chứng minh bảng thật
      // sự tồn tại sau DDL.
      const client = await db.connect();
      try {
        const { rows } = await client.query<{ relkind: string }>(
          `SELECT c.relkind::text AS relkind
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'remote_cache' AND c.relname = 'migrator_probe'`,
        );
        expect(rows.map((row) => row.relkind)).toEqual(['r']);
      } finally {
        await client.end();
      }
    } finally {
      // Dọn trong `finally`: một bảng sót lại sẽ làm grant sweep đỏ ở lần chạy
      // kế tiếp, và phụ thuộc thứ tự test là kiểu test không nên có.
      await migrator.query('DROP TABLE IF EXISTS remote_cache.migrator_probe');
      await migrator.end();
    }
  });

  it('ADR-0015: the runtime role cannot create a table on the public schema', async () => {
    // `REVOKE ALL ON SCHEMA public FROM PUBLIC` trong `0002` là no-op trên
    // PostgreSQL 15+ — hardening thật đến từ default PG15 rút CREATE khỏi
    // PUBLIC. Test này khóa đúng thuộc tính mà 0002 hy vọng giữ.
    const runtime = await db.connectAsRuntime();
    try {
      await expect(runtime.query('CREATE TABLE public.probe (id int)')).rejects.toThrow(
        /permission denied/iu,
      );
    } finally {
      await runtime.end();
    }
  });

  it('ADR-0015: schema public ACL gives PUBLIC USAGE without CREATE on PostgreSQL 17', async () => {
    // Assertion catalog: entry PUBLIC trong `nspacl` phải là `=U` (USAGE, không
    // CREATE). Ở đây database do testcontainers tạo với owner là superuser test
    // — đúng hình production nơi owner là ecoma_owner.
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ nspacl: string }>(
        `SELECT nspacl::text AS nspacl FROM pg_namespace WHERE nspname = 'public'`,
      );
      const items = (rows[0]?.nspacl ?? '')
        .split(',')
        .filter((item) => item.length > 0)
        .map((item) => item.split('/')[0] ?? '');

      const publicItem = items.find((item) => item.startsWith('='));
      expect(publicItem).toBeDefined();
      expect(publicItem).toMatch(/=U(?![^a-z])/u);
      expect(publicItem).not.toMatch(/=.*C/u);
    } finally {
      await client.end();
    }
  });

  it('ADR-0015: no foreign key points outside the remote_cache schema', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ violations: number }>(
        `SELECT count(*)::int AS violations
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE con.contype = 'f'
            AND n.nspname NOT IN ('remote_cache', 'pg_catalog', 'information_schema')`,
      );
      expect(rows[0]?.violations).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('ADR-0015: no postgres_fdw and no dblink extension is installed', async () => {
    const client = await db.connect();
    try {
      const { rows } = await client.query<{ extname: string }>(
        `SELECT extname FROM pg_extension ORDER BY extname`,
      );
      const installed = rows.map((row) => row.extname);
      expect(installed).not.toContain('postgres_fdw');
      expect(installed).not.toContain('dblink');
      // `0001` không cài extension nào: `gen_random_uuid()` là core từ
      // PostgreSQL 13. Chỉ còn `plpgsql` — extension mặc định của mọi database.
      expect(installed).toEqual(['plpgsql']);
    } finally {
      await client.end();
    }
  });

  it('ADR-0015: no migration executes a foreign data wrapper, dblink, or foreign table', async () => {
    // Query `pg_extension` chỉ thấy extension **đã cài**; một câu bị comment
    // hay một `dblink` trong migration không lộ ở đó — phải đọc file.
    const { listMigrations } = await import('../../db/migrate.mts');
    for (const migration of listMigrations()) {
      const sql = executableSql(migration.sql);
      expect({ file: migration.name, sql }).not.toMatchObject({
        sql: expect.stringMatching(
          /postgres_fdw|dblink|foreign\s+table|foreign\s+data\s+wrapper/iu,
        ),
      });
    }
  });
});

/** Seed tenant + project + key bằng repo thật; trả id và token đã hash. */
async function seedTenantProjectAndKey(
  client: import('pg').Client,
): Promise<{ tenantId: string; projectId: string; apiKeyId: string; tokenHash: string }> {
  const { rows: tenantRows } = await client.query<{ id: string }>(
    `INSERT INTO remote_cache.tenants (name) VALUES ('seed_' || md5(random()::text))
     RETURNING id`,
  );
  const tenantId = tenantRows[0]?.id ?? '';
  const projectId = crypto.randomUUID();
  const apiKeyId = crypto.randomUUID();
  const tokenHash = crypto.randomUUID().replace(/-/gu, '').padEnd(64, '0');

  const db = {
    unsafe: async (sql: string, params?: readonly unknown[]) => {
      const { rows } = await client.query(sql, params as unknown[]);
      return rows;
    },
  } as unknown as RemoteCacheQueryable;

  await insertProject(db, { id: projectId, tenantId, name: 'seed-project' });
  await insertApiKey(db, { id: apiKeyId, projectId, tokenHash, scopes: ['read', 'write'] });
  return { tenantId, projectId, apiKeyId, tokenHash };
}

describe('database enforcement of control-plane invariants', () => {
  let db: RemoteCacheDatabase;

  beforeAll(async () => {
    db = await startRemoteCacheDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('revocation is UPDATE revoked_at, and neither runtime nor trigger can un-revoke', async () => {
    const migrator = await db.asMigrator();
    let apiKeyId = '';
    try {
      ({ apiKeyId } = await seedTenantProjectAndKey(migrator));
    } finally {
      await migrator.end();
    }

    // Revoke bằng repo thật trên credential runtime — đúng đường production.
    const runtime = await db.connectAsRuntime();
    try {
      const queryable = {
        unsafe: async (sql: string, params?: readonly unknown[]) => {
          const { rows } = await runtime.query(sql, params as unknown[]);
          return rows;
        },
      } as unknown as RemoteCacheQueryable;
      const changed = await revokeApiKey(queryable, apiKeyId, new Date().toISOString());
      expect(changed).toBe(1);

      // Revoke lần nữa là no-op đếm được (0 hàng) — không ném, không đổi state.
      const again = await revokeApiKey(queryable, apiKeyId, new Date().toISOString());
      expect(again).toBe(0);

      // Revoke-only guard: SET revoked_at giá trị khác phải chết ở trigger —
      // một key đã revoke không thể quay lại hiệu lực bằng UPDATE im lặng.
      await expect(
        runtime.query('UPDATE remote_cache.api_keys SET revoked_at = NULL WHERE id = $1', [
          apiKeyId,
        ]),
      ).rejects.toThrow(/revoke la terminal|integrity_constraint_violation/iu);
    } finally {
      await runtime.end();
    }
  });

  it('runtime UPDATE is column-level revoked_at only — mutating token_hash or scopes dies at the grant', async () => {
    // Lớp hai độc lập với trigger: grant `UPDATE (revoked_at)` nghĩa là UPDATE
    // cột khác bị PostgreSQL từ chối ngay cả khi trigger bị tắt (defense in
    // depth — hai cơ chế cùng đo được, không dựa vào nhau).
    const migrator = await db.asMigrator();
    let apiKeyId = '';
    try {
      ({ apiKeyId } = await seedTenantProjectAndKey(migrator));
    } finally {
      await migrator.end();
    }
    const runtime = await db.connectAsRuntime();
    try {
      await expect(
        runtime.query('UPDATE remote_cache.api_keys SET token_hash = $1 WHERE id = $2', [
          'b'.repeat(64),
          apiKeyId,
        ]),
      ).rejects.toThrow(/permission denied/iu);
      await expect(
        runtime.query(`UPDATE remote_cache.api_keys SET scopes = 'admin' WHERE id = $1`, [
          apiKeyId,
        ]),
      ).rejects.toThrow(/permission denied/iu);
    } finally {
      await runtime.end();
    }
  });

  it('api_keys: CHECK shapes — scopes vocabulary and revoked_at after created_at', async () => {
    // Trigger exempt ai đó cho đúng nghĩa "migrator giữ full power", nhưng CHECK
    // là hình dạng dữ liệu — áp cho mọi role. Kiểm bằng migrator để tách hai
    // cơ chế: trigger (theo `current_user`) và CHECK (vô điều kiện).
    const migrator = await db.asMigrator();
    try {
      const { projectId } = await seedTenantProjectAndKey(migrator);

      // Scope ngoài vocabulary phải chết ở CHECK — `admin` không thuộc read/write
      // (ADR-0015: không mượn vocabulary nào của staff-access).
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.api_keys (project_id, token_hash, scopes)
           VALUES ($1, repeat('c', 64), 'admin')`,
          [projectId],
        ),
      ).rejects.toThrow(/api_key_scopes_check|violates check constraint/iu);

      // Scope rỗng cũng chết: token không scope nào là vô dụng (R2).
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.api_keys (project_id, token_hash, scopes)
           VALUES ($1, repeat('d', 64), '')`,
          [projectId],
        ),
      ).rejects.toThrow(/api_key_scopes_check|violates check constraint/iu);

      // revoked_at trước created_at là vô nghĩa thời gian — CHECK phải chặn.
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.api_keys (project_id, token_hash, scopes, created_at, revoked_at)
           VALUES ($1, repeat('e', 64), 'read', now(), now() - interval '1 hour')`,
          [projectId],
        ),
      ).rejects.toThrow(/revoked_at_after_created|violates check constraint/iu);
    } finally {
      await migrator.end();
    }
  });

  it('api_keys: token_hash is UNIQUE — two rows cannot carry one credential', async () => {
    const migrator = await db.asMigrator();
    try {
      const { projectId, tokenHash } = await seedTenantProjectAndKey(migrator);
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.api_keys (project_id, token_hash, scopes)
           VALUES ($1, $2, 'read')`,
          [projectId, tokenHash],
        ),
      ).rejects.toThrow(/unique|duplicate key/iu);
    } finally {
      await migrator.end();
    }
  });

  it('projects: name CHECK and tenant-scoped uniqueness hold for any role', async () => {
    const migrator = await db.asMigrator();
    try {
      const { tenantId } = await seedTenantProjectAndKey(migrator);

      // Tên sai hình (uppercase, leading dash) chết ở CHECK.
      await expect(
        migrator.query(`INSERT INTO remote_cache.projects (tenant_id, name) VALUES ($1, 'Bad')`, [
          tenantId,
        ]),
      ).rejects.toThrow(/projects_name_check|violates check constraint/iu);

      // Trùng tên trong cùng tenant chết ở UNIQUE (tenant_id, name).
      await expect(
        migrator.query(
          `INSERT INTO remote_cache.projects (tenant_id, name) VALUES ($1, 'seed-project')`,
          [tenantId],
        ),
      ).rejects.toThrow(/unique|duplicate key/iu);

      // Cùng tên ở tenant khác là hợp lệ — ranh giới theo tenant, không toàn cục.
      const { rows: otherTenant } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.tenants (name) VALUES ('other_' || md5(random()::text))
         RETURNING id`,
      );
      const otherTenantId = otherTenant[0]?.id ?? '';
      const { rows: dupName } = await migrator.query<{ id: string }>(
        `INSERT INTO remote_cache.projects (tenant_id, name) VALUES ($1, 'seed-project')
         RETURNING id`,
        [otherTenantId],
      );
      expect(dupName[0]?.id).not.toBe('');
    } finally {
      await migrator.end();
    }
  });

  it('hash-only lookup: the repository finds the key by token_hash and never needs the raw token', async () => {
    const migrator = await db.asMigrator();
    try {
      const { apiKeyId, tokenHash } = await seedTenantProjectAndKey(migrator);
      const queryable = {
        unsafe: async (sql: string, params?: readonly unknown[]) => {
          const { rows } = await migrator.query(sql, params as unknown[]);
          return rows;
        },
      } as unknown as RemoteCacheQueryable;
      const row = await getApiKeyByTokenHash(queryable, tokenHash);
      expect(row?.id).toBe(apiKeyId);
      expect(row?.revoked_at).toBeNull();
    } finally {
      await migrator.end();
    }
  });
});
