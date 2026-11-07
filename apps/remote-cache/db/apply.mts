/**
 * `pnpm nx run remote-cache:db:migrate` — apply migration cua `db-remote-cache`.
 *
 * Chay tu **CI runner** bang PostgreSQL client voi credential migrator,
 * **khong** chay tu Worker: Hyperdrive khong ho tro advisory lock (HD6,
 * `docs/architecture/04-platform-facts.md`), ma advisory lock la buoc quan
 * trong nhat o day.
 *
 * Bien moi truong:
 *
 * | Bien           | Bat buoc | Y nghia                                          |
 * | -------------- | -------- | ------------------------------------------------ |
 * | `DATABASE_URL` | co       | chuoi ket noi PostgreSQL cua **migrator**        |
 *
 * `DATABASE_URL` khong co thi exit code khac 0 va in huong dan; coi im lang
 * la da apply la cach lam mot lan migration bien mat.
 *
 * ## Mot duong code cho viec apply
 *
 * `applyAllMigrations` la **thu tu duy nhat** ma migration duoc apply: ca CLI
 * ben duoi lan integration test deu goi no. Viet vong apply rieng trong test
 * la cach test "repeatable" chung minh cho ban sao, khong cho runner
 * production — pattern `apps/staff-access/db/apply.mts`.
 */

import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

import { REMOTE_CACHE_DATABASE, listMigrations, renderMigration } from './migrate.mts';

/** Ket qua mot lan apply — CLI in ra, test assert. */
export interface ApplyMigrationsResult {
  /** So file migration da apply trong lan goi nay. */
  readonly applied: number;
  /** So bang (relkind `r`/`p`) trong schema `remote_cache` sau khi apply. */
  readonly tablesInRemoteCacheSchema: number;
}

/** Tuy chon cua `applyAllMigrations`. */
export interface ApplyMigrationsOptions {
  /** Goi cho moi file apply thanh cong — CLI dung de in tien trinh. */
  readonly onApplied?: (migrationName: string) => void;
}

/**
 * Apply toan bo file migration, duoi advisory lock, tren client da cho.
 *
 * ⚠️ Client phai la **migrator** (credential that, khong phai `SET ROLE` tu
 * superuser): quyen `CREATE` tren database la dieu kien de `0001` chay, va
 * `SET ROLE` khong kiem chung duoc quyen ket noi that.
 *
 * Thu tu:
 * 1. `pg_advisory_lock(hashtext('db-remote-cache'))` — chan hai runner chay
 *    song song. Lock session-scoped, tu nha khi connection dong; hash tinh
 *    **phia server** theo ten database nen doi ten thi khoa doi theo, va hai
 *    service khong tranh cung mot khoa.
 * 2. Apply tung file theo thu tu ten. File hong dung ngay va nem loi kem ten
 *    file — forward-fix, khong down-migration (ADR-0001/invariant 10).
 * 3. Dem bang trong schema `remote_cache`. Khong co ledger: catalog
 *    `pg_class` sau khi apply la nguon su that, va moi DDL trong `migrations/`
 *    idempotent — apply lai la no-op, khong phai loi.
 */
export async function applyAllMigrations(
  client: Client,
  options?: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult> {
  const { rows: dbRows } = await client.query<{ current_database: string }>(
    `SELECT current_database() AS current_database`,
  );
  const currentDatabase = dbRows[0]?.current_database;
  if (currentDatabase !== REMOTE_CACHE_DATABASE) {
    throw new Error(
      `applyAllMigrations expected database "${REMOTE_CACHE_DATABASE}" but connected to "${currentDatabase ?? '<unknown>'}"; refusing to migrate the wrong database.`,
    );
  }
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [REMOTE_CACHE_DATABASE]);

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
      WHERE n.nspname = 'remote_cache' AND c.relkind IN ('r', 'p')`,
  );

  return { applied, tablesInRemoteCacheSchema: Number(rows[0]?.tables ?? '0') };
}

/** Nhanh CLI — chi chay khi file nay la main module. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL is not set. Migrations run from the CI runner with the migrator role, never from the Worker (HD6: Hyperdrive does not support advisory locks).',
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-remote-cache-migrate',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error(`Could not connect to the database: ${(error as Error).message}`);
    process.exit(1);
  }

  try {
    const result = await applyAllMigrations(client, {
      onApplied: (name) => {
        console.log(`applied  ${name}`);
      },
    });
    console.log(
      `done     ${result.applied} file(s) applied; ${result.tablesInRemoteCacheSchema} tables in schema remote_cache`,
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
