/**
 * Integration test cho migration `0008_role_identity_and_assignment_uniqueness.sql`
 * trên PostgreSQL thật, tập trung vào Deliverable C (section 2 xác thực index từ
 * catalog, section 4 khóa seal catalog).
 *
 * Mỗi trường hợp sabotage DDL bằng superuser client, rồi re-apply qua
 * `applyAllMigrations` với credential migrator thật (đúng runner production).
 * Sau mỗi trường hợp, drop index sai và khôi phục index đúng để các test sau
 * không bị ảnh hưởng.
 *
 * Comment bằng tiếng Việt; test title bằng tiếng Anh; mọi chuỗi runtime
 * (RAISE EXCEPTION message) là tiếng Anh.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAllMigrations } from '../../db/apply.mts';
import { type StaffAccessDatabase, startStaffAccessDatabase } from './harness.ts';
import { CANONICAL_ROLE_NAME } from '../../db/bootstrap.mts';

let db: StaffAccessDatabase;

beforeAll(async () => {
  db = await startStaffAccessDatabase();
}, 180_000);

afterAll(async () => {
  await db?.stop();
});

/** Tất cả thuộc tính bắt buộc của index `role_assignments_active_unique_idx`. */
const REQUIRED_INDEX_NAME = 'role_assignments_active_unique_idx';
const REQUIRED_TABLE = 'role_assignments';
const REQUIRED_SCHEMA = 'staff_access';
const REQUIRED_AM = 'btree';
const REQUIRED_PREDICATE_NORMALIZED = 'revoked_at is null';

/** Lấy toàn bộ thuộc tính index từ catalog PostgreSQL. */
async function getIndexProperties(client: Parameters<typeof applyAllMigrations>[0]): Promise<{
  tableName: string;
  indexName: string;
  amName: string;
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  indnkeyatts: number;
  indnatts: number;
  keyColumns: string[];
  indexprsIsNull: boolean;
  predicateNormalized: string;
} | null> {
  const { rows } = await client.query<{
    table_name: string;
    index_name: string;
    am_name: string;
    is_unique: boolean;
    is_valid: boolean;
    is_ready: boolean;
    indnkeyatts: string;
    indnatts: string;
    key_columns: string;
    indexprs_is_null: boolean;
    predicate: string;
  }>(
    `SELECT
       tc.relname AS table_name,
       ic.relname AS index_name,
       am.amname AS am_name,
       i.indisunique AS is_unique,
       i.indisvalid AS is_valid,
       i.indisready AS is_ready,
       i.indnkeyatts::text AS indnkeyatts,
       i.indnatts::text AS indnatts,
       COALESCE((
         SELECT array_agg(a.attname ORDER BY k.ord)::text
         FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       ), '{}') AS key_columns,
       (pg_get_expr(i.indexprs, i.indrelid) IS NULL) AS indexprs_is_null,
       pg_get_expr(i.indpred, i.indrelid) AS predicate
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = ic.relnamespace
     JOIN pg_class tc ON tc.oid = i.indrelid
     JOIN pg_am am ON am.oid = ic.relam
    WHERE n.nspname = $1 AND ic.relname = $2`,
    [REQUIRED_SCHEMA, REQUIRED_INDEX_NAME],
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    tableName: row.table_name,
    indexName: row.index_name,
    amName: row.am_name,
    isUnique: row.is_unique,
    isValid: row.is_valid,
    isReady: row.is_ready,
    indnkeyatts: Number(row.indnkeyatts),
    indnatts: Number(row.indnatts),
    keyColumns: row.key_columns === '{}' ? [] : row.key_columns.slice(1, -1).split(','),
    indexprsIsNull: Boolean(row.indexprs_is_null),
    predicateNormalized: normalizePredicate(row.predicate ?? ''),
  };
}

/** Chuẩn hoá predicate từ pg_get_expr về dạng canonical so sánh. */
function normalizePredicate(raw: string): string {
  return raw.toLowerCase().replace(/[()]/gu, '').replace(/\s+/gu, ' ').trim();
}

/** Assert rằng index có tất cả thuộc tính bắt buộc. */
function expectIndexProperties(props: {
  tableName: string;
  indexName: string;
  amName: string;
  isUnique: boolean;
  isValid: boolean;
  isReady: boolean;
  indnkeyatts: number;
  indnatts: number;
  keyColumns: string[];
  indexprsIsNull: boolean;
  predicateNormalized: string;
}): void {
  expect(props.tableName).toBe(REQUIRED_TABLE);
  expect(props.indexName).toBe(REQUIRED_INDEX_NAME);
  expect(props.amName).toBe(REQUIRED_AM);
  expect(props.isUnique).toBe(true);
  expect(props.isValid).toBe(true);
  expect(props.isReady).toBe(true);
  expect(props.indnkeyatts).toBe(2);
  expect(props.indnatts).toBe(2);
  expect(props.keyColumns).toEqual(['staff_id', 'role_id']);
  expect(props.indexprsIsNull).toBe(true);
  expect(props.predicateNormalized).toBe(REQUIRED_PREDICATE_NORMALIZED);
}

/** Tạo lại index đúng (idempotent) sau khi sabotage test xong. */
async function restoreCorrectIndex(
  superuserClient: Awaited<ReturnType<StaffAccessDatabase['connect']>>,
): Promise<void> {
  await superuserClient.query(
    `DROP INDEX IF EXISTS staff_access.role_assignments_active_unique_idx`,
  );
  await superuserClient.query(
    `CREATE UNIQUE INDEX role_assignments_active_unique_idx
     ON staff_access.role_assignments (staff_id, role_id)
     WHERE revoked_at IS NULL`,
  );
}

describe('migration 0008 index and catalog validation', () => {
  let superuser: Awaited<ReturnType<StaffAccessDatabase['connect']>>;

  beforeAll(async () => {
    superuser = await db.connect();
  });

  afterAll(async () => {
    await superuser.end();
  });

  it('fresh apply succeeds and the index exists with exactly the required properties', async () => {
    const migrator = await db.connectAsMigrator();
    try {
      const properties = await getIndexProperties(migrator);
      expect(properties).not.toBeNull();
      if (properties) {
        expectIndexProperties(properties);
      }

      // `audit.read` đã có trong catalog (seed của `0007`) và role canonical (section 3)
      const { rows: permRows } = await migrator.query<{ id: string }>(
        `SELECT id FROM staff_access.permissions WHERE id = 'audit.read'`,
      );
      expect(permRows).toHaveLength(1);

      const { rows: roleRows } = await migrator.query<{
        id: string;
        name: string;
        kind: string;
        status: string;
      }>(`SELECT id, name, kind, status FROM staff_access.roles WHERE name = $1`, [
        CANONICAL_ROLE_NAME,
      ]);
      expect(roleRows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await migrator.end();
    }
  });

  it('re-applying all migrations is idempotent (no ledger, DDL is no-op)', async () => {
    const migrator = await db.connectAsMigrator();
    try {
      const result = await applyAllMigrations(migrator);
      expect(result.applied).toBeGreaterThan(0);

      const properties = await getIndexProperties(migrator);
      expect(properties).not.toBeNull();
      if (properties) {
        expectIndexProperties(properties);
      }
    } finally {
      await migrator.end();
    }
  });

  it('same-name index with swapped key columns is rejected by apply', async () => {
    await superuser.query(`DROP INDEX IF EXISTS staff_access.role_assignments_active_unique_idx`);
    await superuser.query(
      `CREATE UNIQUE INDEX role_assignments_active_unique_idx
       ON staff_access.role_assignments (role_id, staff_id)
       WHERE revoked_at IS NULL`,
    );

    const migrator = await db.connectAsMigrator();
    try {
      await expect(applyAllMigrations(migrator)).rejects.toThrow(
        /key columns|staff_id.*role_id|role_id.*staff_id/iu,
      );
    } finally {
      await migrator.end();
      await restoreCorrectIndex(superuser);
    }
  });

  it('same-name non-unique index is rejected by apply', async () => {
    await superuser.query(`DROP INDEX IF EXISTS staff_access.role_assignments_active_unique_idx`);
    await superuser.query(
      `CREATE INDEX role_assignments_active_unique_idx
       ON staff_access.role_assignments (staff_id, role_id)
       WHERE revoked_at IS NULL`,
    );

    const migrator = await db.connectAsMigrator();
    try {
      await expect(applyAllMigrations(migrator)).rejects.toThrow(/indisunique/iu);
    } finally {
      await migrator.end();
      await restoreCorrectIndex(superuser);
    }
  });

  it('same-name index without the revoked_at IS NULL predicate is rejected by apply', async () => {
    await superuser.query(`DROP INDEX IF EXISTS staff_access.role_assignments_active_unique_idx`);
    await superuser.query(
      `CREATE UNIQUE INDEX role_assignments_active_unique_idx
       ON staff_access.role_assignments (staff_id, role_id)`,
    );

    const migrator = await db.connectAsMigrator();
    try {
      await expect(applyAllMigrations(migrator)).rejects.toThrow(/predicate|revoked_at is null/iu);
    } finally {
      await migrator.end();
      await restoreCorrectIndex(superuser);
    }
  });

  it('same-name index with a different predicate is rejected by apply', async () => {
    await superuser.query(`DROP INDEX IF EXISTS staff_access.role_assignments_active_unique_idx`);
    await superuser.query(
      `CREATE UNIQUE INDEX role_assignments_active_unique_idx
       ON staff_access.role_assignments (staff_id, role_id)
       WHERE revoked_at IS NOT NULL`,
    );

    const migrator = await db.connectAsMigrator();
    try {
      await expect(applyAllMigrations(migrator)).rejects.toThrow(/predicate/iu);
    } finally {
      await migrator.end();
      await restoreCorrectIndex(superuser);
    }
  });

  it('same-name index with an extra included column (indnatts 3) is rejected by apply', async () => {
    await superuser.query(`DROP INDEX IF EXISTS staff_access.role_assignments_active_unique_idx`);
    await superuser.query(
      `CREATE UNIQUE INDEX role_assignments_active_unique_idx
       ON staff_access.role_assignments (staff_id, role_id)
       INCLUDE (granted_by)
       WHERE revoked_at IS NULL`,
    );

    const migrator = await db.connectAsMigrator();
    try {
      await expect(applyAllMigrations(migrator)).rejects.toThrow(/indnatts/iu);
    } finally {
      await migrator.end();
      await restoreCorrectIndex(superuser);
    }
  });
});
