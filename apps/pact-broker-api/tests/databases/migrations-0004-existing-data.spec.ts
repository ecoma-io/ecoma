/**
 * Migration `0004` chạy trên database đã chạy `0001`–`0003` rồi nhận hàng qua
 * các writer pre-0004 (ADR-0020 quyết định 9: mọi ecoma-internal còn lại được
 * đọc là ecoma).
 *
 * ⚠️ Các case này không chạy được trên database harness dùng chung: container
 * đó áp mọi migration ngay từ đầu, và sau `0004` chính schema chặn hàng chưa
 * phân loại, nên không thể dựng trạng thái pre-0004 ở đó. Vì vậy mỗi test tự
 * chạy một PostgreSQL dùng một lần rồi vứt (cùng chi phí với test "reports
 * zero applied" của `migrations.spec.ts`), áp `0001`–`0003` bằng các helper
 * thứ tự/render của chính runner, chèn các hàng legacy, rồi áp `0004` — file
 * đang xét — theo cách runner thật thực thi một file (một câu query render
 * cho mỗi file). Replay full-runner trên mọi file vẫn do `migrations.spec.ts`
 * đảm nhận.
 *
 * ⚠️ Suite cần Docker: probe hỏng làm cả run đỏ (fail-loud, 06-testing.md §6)
 * — skip với exit 0 không phải kết quả được chấp nhận.
 */

import { describe, expect, it } from 'vitest';

import { listMigrations, renderMigration } from '../../db/migrate.mts';
import { POSTGRES_IMAGE } from '../integrations/harness';

const SUPERUSER = 'ecoma_test_superuser';
const SUPERUSER_PASSWORD = 'ecoma_test_superuser_pw';
const MIGRATOR_ROLE = 'ecoma_pact_broker_migrator';
const MIGRATOR_PASSWORD = 'ecoma_test_role_pw';
const RUNTIME_ROLE = 'ecoma_pact_broker_runtime';
const DATABASE_NAME = 'db-pact-broker';

const PRE_0004_MIGRATIONS = listMigrations().filter((migration) => migration.name < '0004_');
const MIGRATION_0004 = listMigrations().find((migration) => migration.name.startsWith('0004_'));

if (MIGRATION_0004 === undefined) {
  throw new Error('migration 0004 not found in db/migrations');
}

interface LegacyDatabase {
  /** Áp một file migration theo đúng tên, như runner thật thực thi nó. */
  applyMigrationFile(name: string): Promise<void>;
  /** Client để dựng hàng legacy (pre-0004) và assert trạng thái. */
  connect(): Promise<import('pg').Client>;
  stop(): Promise<void>;
}

async function startLegacyDatabase(): Promise<LegacyDatabase> {
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const { Client: PgClient } = await import('pg');

  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase(DATABASE_NAME)
    .withUsername(SUPERUSER)
    .withPassword(SUPERUSER_PASSWORD)
    .withExposedPorts(5432)
    .withStartupTimeout(120_000)
    .start();

  try {
    const host = container.getHost();
    const port = container.getMappedPort(5432);

    const connectAs = async (user: string, password: string): Promise<import('pg').Client> => {
      const client = new PgClient({ host, port, user, password, database: DATABASE_NAME });
      await client.connect();
      return client;
    };

    // Chia provisioning giống harness: role LOGIN và grant CREATE là bước
    // dựng, không phải nội dung migration. Cả hai tên role được tạo sẵn để
    // guard trong migration `0001` nhảy qua nhánh CREATE ROLE — migrator giữ
    // NOCREATEROLE và không tự tạo được chúng.
    const superuser = await connectAs(SUPERUSER, SUPERUSER_PASSWORD);
    try {
      await superuser.query(
        `DO $$ BEGIN
           IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${MIGRATOR_ROLE}') THEN
             CREATE ROLE ${MIGRATOR_ROLE} LOGIN PASSWORD '${MIGRATOR_PASSWORD}'
               NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
           END IF;
           IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${RUNTIME_ROLE}') THEN
             CREATE ROLE ${RUNTIME_ROLE} NOLOGIN
               NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
           END IF;
         END $$;`,
      );
      await superuser.query(
        `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "${DATABASE_NAME}" TO ${MIGRATOR_ROLE}`,
      );
    } finally {
      await superuser.end();
    }

    const migrator = await connectAs(MIGRATOR_ROLE, MIGRATOR_PASSWORD);
    for (const migration of PRE_0004_MIGRATIONS) {
      await migrator.query(renderMigration(migration.sql));
    }

    return {
      applyMigrationFile: async (name: string) => {
        const migration = listMigrations().find((entry) => entry.name === name);
        if (migration === undefined) {
          throw new Error(`migration file not found: ${name}`);
        }
        await migrator.query(renderMigration(migration.sql));
      },
      connect: () => connectAs(SUPERUSER, SUPERUSER_PASSWORD),
      stop: async () => {
        await migrator.end().catch(() => undefined);
        await container.stop();
      },
    };
  } catch (error) {
    await container.stop().catch(() => undefined);
    throw error;
  }
}

async function insertLegacyTenant(
  db: LegacyDatabase,
  name: string,
  ownerSub: string,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query(`INSERT INTO pact.tenants (name, owner_sub) VALUES ($1, $2)`, [
      name,
      ownerSub,
    ]);
  } finally {
    await client.end();
  }
}

interface LegacyTenantRow {
  id: string;
  name: string;
  status: string;
  owner_sub: string;
}

/**
 * Hàng tenant qua đúng các cột pre-0004 — hợp lệ cả trước lẫn sau `0004`
 * (các cột classification/plan không tồn tại trên database nơi `0004`
 * fail-closed và rollback).
 */
async function queryAllTenants(db: LegacyDatabase): Promise<LegacyTenantRow[]> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<LegacyTenantRow>(
      `SELECT id, name, status, owner_sub FROM pact.tenants ORDER BY name`,
    );
    return rows;
  } finally {
    await client.end();
  }
}

/** Classification + plan của một tenant — chỉ đọc được sau khi `0004` đã áp. */
async function queryTenantClassification(
  db: LegacyDatabase,
  name: string,
): Promise<{ classification: string; plan: string | null }> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ classification: string; plan: string | null }>(
      `SELECT classification, plan FROM pact.tenants WHERE name = $1`,
      [name],
    );
    if (rows[0] === undefined) {
      throw new Error(`tenant ${name} not found after migration 0004`);
    }
    return rows[0];
  } finally {
    await client.end();
  }
}

async function classificationColumnExists(db: LegacyDatabase): Promise<boolean> {
  const client = await db.connect();
  try {
    const { rows } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM information_schema.columns
        WHERE table_schema = 'pact' AND table_name = 'tenants' AND column_name = 'classification'`,
    );
    return rows[0]?.c === '1';
  } finally {
    await client.end();
  }
}

describe(`${DATABASE_NAME} migration 0004 over pre-0004 data`, () => {
  // Mỗi test có một container dùng một lần (trạng thái pre-0004 không dựng
  // được trên database đã áp 0004), start và stop trong thân test qua
  // try/finally.

  it(
    'renames a legacy ecoma-internal row to ecoma as first_party',
    { timeout: 180_000 },
    async () => {
      const db = await startLegacyDatabase();
      try {
        await insertLegacyTenant(db, 'ecoma-internal', 'sub-owner-legacy');

        await db.applyMigrationFile(MIGRATION_0004.name);

        const tenants = await queryAllTenants(db);
        expect(tenants).toHaveLength(1);
        expect(tenants[0]?.name).toBe('ecoma');
        expect(tenants[0]?.status).toBe('active');
        expect(tenants[0]?.owner_sub).toBe('sub-owner-legacy');
        expect(await queryTenantClassification(db, 'ecoma')).toEqual({
          classification: 'first_party',
          plan: null,
        });

        // Replay (runner thật chạy lại mọi file): idempotent, không đổi.
        await db.applyMigrationFile(MIGRATION_0004.name);
        expect(await queryAllTenants(db)).toEqual(tenants);
        expect(await queryTenantClassification(db, 'ecoma')).toEqual({
          classification: 'first_party',
          plan: null,
        });
      } finally {
        await db.stop();
      }
    },
  );

  it('backfills a pre-existing ecoma row as first_party', { timeout: 180_000 }, async () => {
    const db = await startLegacyDatabase();
    try {
      await insertLegacyTenant(db, 'ecoma', 'sub-owner-canonical');

      await db.applyMigrationFile(MIGRATION_0004.name);

      const tenants = await queryAllTenants(db);
      expect(tenants).toHaveLength(1);
      expect(tenants[0]?.name).toBe('ecoma');
      expect(tenants[0]?.owner_sub).toBe('sub-owner-canonical');
      expect(await queryTenantClassification(db, 'ecoma')).toEqual({
        classification: 'first_party',
        plan: null,
      });
    } finally {
      await db.stop();
    }
  });

  it(
    'fails closed when a legacy row has no classification, naming it and the recovery',
    { timeout: 180_000 },
    async () => {
      const db = await startLegacyDatabase();
      try {
        await insertLegacyTenant(db, 'local', 'sub-owner-local');

        await expect(db.applyMigrationFile(MIGRATION_0004.name)).rejects.toThrow(
          /migration 0004.*local.*local-down.*local-up/su,
        );

        // Migration lỗi rollback hoàn toàn: không tồn tại cột classification
        // và hàng legacy không bị đụng tới.
        expect(await classificationColumnExists(db)).toBe(false);
        const tenants = await queryAllTenants(db);
        expect(tenants).toHaveLength(1);
        expect(tenants[0]?.name).toBe('local');
      } finally {
        await db.stop();
      }
    },
  );

  it(
    'fails closed when both ecoma and ecoma-internal rows exist',
    { timeout: 180_000 },
    async () => {
      const db = await startLegacyDatabase();
      try {
        await insertLegacyTenant(db, 'ecoma', 'sub-owner-canonical');
        await insertLegacyTenant(db, 'ecoma-internal', 'sub-owner-legacy');

        await expect(db.applyMigrationFile(MIGRATION_0004.name)).rejects.toThrow(/ambiguous/u);

        // Không đổi tên gì, không phân loại gì: transaction đã rollback.
        expect(await classificationColumnExists(db)).toBe(false);
        expect((await queryAllTenants(db)).map((row) => row.name)).toEqual([
          'ecoma',
          'ecoma-internal',
        ]);
      } finally {
        await db.stop();
      }
    },
  );
});
