/**
 * Migration `0004` applied over a database that ran `0001`–`0003` and then
 * received rows through the pre-0004 writers (ADR-0020 decision 9: every
 * remaining ecoma-internal reads as ecoma).
 *
 * ⚠️ These cases cannot run on the shared harness database: that container
 * applies every migration up front, and after `0004` the schema itself
 * rejects unclassified rows, so pre-0004 state cannot be staged there. Each
 * test therefore starts its own throwaway PostgreSQL (same cost as the
 * "reports zero applied" test of `migrations.spec.ts`), applies
 * `0001`–`0003` using the runner's own ordering/rendering helpers, inserts
 * the legacy rows, and then applies `0004` — the file under test — the way
 * the real runner executes a file (one rendered query per file). The
 * full-runner replay across all files stays covered by `migrations.spec.ts`.
 *
 * ⚠️ Suite requires Docker: a broken probe makes the run go red (fail-loud,
 * 06-testing.md §6) — skipping with exit 0 is not an accepted result.
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
  /** Applies one migration file by exact name, as the real runner executes it. */
  applyMigrationFile(name: string): Promise<void>;
  /** Client for legacy-row setup (pre-0004) and state assertions. */
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

    // Same provisioning split as the harness: LOGIN roles and the CREATE
    // grant are setup steps, not migration content. Both role names are
    // pre-created so the guards inside migration `0001` skip their
    // CREATE ROLE branches — the migrator holds NOCREATEROLE and cannot
    // create them itself.
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
 * Tenant rows through pre-0004 columns only — valid both before and after
 * `0004` (the classification/plan columns do not exist on a database where
 * `0004` failed closed and rolled back).
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

/** Classification + plan of one tenant — readable only once `0004` has applied. */
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
  // Each test owns one throwaway container (pre-0004 state cannot be staged
  // on a database that already applied 0004), started and stopped inside the
  // test body via try/finally.

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

        // Replay (the real runner re-runs every file): idempotent, no change.
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

        // The failed migration rolled back completely: no classification
        // column exists and the legacy row is untouched.
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

        // Nothing renamed, nothing classified: the transaction rolled back.
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
