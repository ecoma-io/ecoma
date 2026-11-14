/**
 * `tsx db/apply.mts` — apply migration của `db-remote-cache-app`.
 *
 * Deliberate duplication của `apps/pact-broker-app/db/apply.mts` (import chéo
 * deploy unit bị cấm — 05-code-architecture.md §7). Chạy từ CI runner bằng
 * PostgreSQL client kết nối thẳng với credential `_migrator_`, **không** chạy
 * từ Worker — Hyperdrive không hỗ trợ advisory lock (platform facts HD6).
 *
 * ## Biến môi trường
 *
 * | Biến           | Bắt buộc | Ý nghĩa                                               |
 * | -------------- | -------- | ----------------------------------------------------- |
 * | `DATABASE_URL` | có       | chuỗi kết nối PostgreSQL bằng credential **migrator** |
 *
 * CLI chỉ chạy khi file được gọi là main module (`tsx db/apply.mts`); import
 * từ test không kích hoạt nhánh CLI. Runtime strings là English (language
 * policy: mọi chuỗi chương trình phát ra).
 */

import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

import { listMigrations, REMOTE_CACHE_APP_DATABASE, renderMigration } from './migrate.mts';

/** Kết quả một lần apply — CLI in ra, test assert. */
export interface ApplyMigrationsResult {
  /** Số file migration đã apply trong lần gọi này. */
  readonly applied: number;
  /** Số bảng (relkind `r`/`p`) trong schema `remote_cache_app` sau khi apply. */
  readonly tablesInRemoteCacheAppSchema: number;
}

/**
 * Apply toàn bộ file migration, dưới advisory lock, trên client đã cho.
 *
 * ⚠️ Client phải là **migrator** (credential thật, không phải `SET ROLE` từ
 * superuser): quyền `CREATE` trên database là điều kiện để `0001` chạy.
 */
export async function applyAllMigrations(
  client: Client,
  options?: { readonly onApplied?: (migrationName: string) => void },
): Promise<ApplyMigrationsResult> {
  const { rows: currentDbRows } = await client.query<{ db: string }>(
    'SELECT current_database() AS db',
  );
  const currentDb = currentDbRows[0]?.db;
  if (currentDb !== REMOTE_CACHE_APP_DATABASE) {
    throw new Error(
      `migration runner is connected to "${currentDb ?? 'unknown'}", expected "${REMOTE_CACHE_APP_DATABASE}" ` +
        `— DATABASE_URL must point at ${REMOTE_CACHE_APP_DATABASE}, refusing to migrate a foreign database`,
    );
  }

  await client.query('SELECT pg_advisory_lock(hashtext($1))', [REMOTE_CACHE_APP_DATABASE]);

  let applied = 0;
  for (const migration of listMigrations()) {
    try {
      await client.query(renderMigration(migration.sql));
    } catch (error) {
      throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    options?.onApplied?.(migration.name);
    applied += 1;
  }

  const { rows } = await client.query<{ tables: string }>(
    `SELECT count(*)::text AS tables
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'remote_cache_app' AND c.relkind IN ('r', 'p')`,
  );

  return { applied, tablesInRemoteCacheAppSchema: Number(rows[0]?.tables ?? '0') };
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL is not set. The migration runs from a CI runner with the _migrator_ role, never from a Worker (HD6: Hyperdrive does not support advisory locks).',
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-remote-cache-app-migrate',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Could not connect to the database:', (error as Error).message);
    process.exit(1);
  }

  try {
    const result = await applyAllMigrations(client, {
      onApplied: (name) => {
        console.log(`applied  ${name}`);
      },
    });
    console.log(
      `done     ${result.applied} file(s) applied; ${result.tablesInRemoteCacheAppSchema} tables in schema remote_cache_app`,
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
