/**
 * `pnpm nx run @ecoma-io/llm-api:db:migrate -- <gateway|tenant|marketplace>` —
 * apply migration cua mot database LLM: `db-llm-gateway`, `db-llm-tenant`
 * hoac `db-llm-marketplace`.
 *
 * Chay tu **CI runner** bang PostgreSQL client voi credential migrator,
 * **khong** chay tu Worker: Hyperdrive khong ho tro advisory lock (HD6,
 * `docs/architecture/04-platform-facts.md`), ma advisory lock la buoc quan
 * trong nhat o day.
 *
 * Bien moi truong:
 *
 * | Bien           | Bat buoc | Y nghia                                              |
 * | -------------- | -------- | ---------------------------------------------------- |
 * | `DATABASE_URL` | co       | chuoi ket noi cua **migrator** cua DB dich (per-DB)  |
 *
 * `DATABASE_URL` khong co hoac target sai thi in huong dan va exit code khac 0;
 * coi im lang la da apply la cach lam mot lan migration bien mat.
 *
 * ## Mot duong code cho viec apply
 *
 * `applyMigrations` la **thu tu duy nhat** ma migration duoc apply: ca CLI
 * ben duoi lan integration test deu di qua cung buoc verify `current_database()`,
 * advisory lock, apply theo thu tu ten file (pattern
 * `apps/remote-cache-api/db/apply.mts`). Viet vong apply rieng trong test la
 * cach test "repeatable" chung minh cho ban sao, khong cho runner production.
 */

import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

import {
  databaseFor,
  listMigrations,
  MIGRATOR_DATABASE_URL_ENV,
  migrationsDirFor,
  type MigrationTarget,
} from './migrate.mts';

/** Ket qua mot lan apply — CLI in ra, test assert. */
export interface ApplyMigrationsResult {
  /** So file migration da apply trong lan goi nay. */
  readonly applied: number;
  /** So bang (relkind `r`/`p`) ngoai cac schema he thong sau khi apply. */
  readonly tablesInDatabase: number;
}

/** Tuy chon cua `applyMigrations`. */
export interface ApplyMigrationsOptions {
  /** Goi cho moi file apply thanh cong — CLI dung de in tien trinh. */
  readonly onApplied?: (migrationName: string) => void;
}

/**
 * Apply toan bo file migration cua mot target, duoi advisory lock, tren client da cho.
 *
 * ⚠️ Client phai la **migrator** (credential that, khong phai `SET ROLE` tu
 * superuser): quyen `CREATE` tren database la dieu kien de `0001` chay, va
 * `SET ROLE` khong kiem chung duoc quyen ket noi that.
 *
 * Thu tu:
 * 1. Verify `current_database()` khop database dich — chay nham credential/
 *    DB khac la dung ngay truoc mot DDL nao cham dich (guard per-DB).
 * 2. `pg_advisory_lock(hashtext('<ten database>'))` — chan hai runner chay
 *    song song. Lock session-scoped, tu nha khi connection dong; hash tinh
 *    **phia server** theo ten database nen doi ten thi khoa doi theo, va hai
 *    database khong tranh cung mot khoa.
 * 3. Apply tung file theo thu tu ten. File hong dung ngay va nem loi kem ten
 *    file — forward-fix, khong down-migration, khong ledger (ADR-0025 §6:
 *    moi truong chua phat hanh, DDL idempotent; `02-delivery.md` §3).
 * 4. `pg_advisory_unlock` nha khoa. Khong co bang lich su: catalog sau khi
 *    apply la nguon su that, va moi DDL trong `migrations/` idempotent —
 *    apply lai la no-op, khong phai loi.
 */
export async function applyMigrations(
  target: MigrationTarget,
  client: Client,
  options?: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult> {
  const database = databaseFor(target);

  const { rows: dbRows } = await client.query<{ current_database: string }>(
    `SELECT current_database() AS current_database`,
  );
  const currentDatabase = dbRows[0]?.current_database;
  if (currentDatabase !== database) {
    throw new Error(
      `applyMigrations expected database "${database}" but connected to "${currentDatabase ?? '<unknown>'}"; refusing to migrate the wrong database.`,
    );
  }
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [database]);

  let applied = 0;
  const migrationsDir = migrationsDirFor(target);
  for (const migration of listMigrations(migrationsDir)) {
    try {
      await client.query(migration.sql);
    } catch (error) {
      throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    options?.onApplied?.(migration.name);
    applied += 1;
  }

  await client.query('SELECT pg_advisory_unlock(hashtext($1))', [database]);

  const { rows } = await client.query<{ tables: string }>(
    `SELECT count(*)::text AS tables
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'p')`,
  );

  return { applied, tablesInDatabase: Number(rows[0]?.tables ?? '0') };
}

/** Nhanh CLI — chi chay khi file nay la main module. */
async function main(): Promise<void> {
  const target = process.argv[2] as MigrationTarget | undefined;

  if (!target || !(target === 'gateway' || target === 'tenant' || target === 'marketplace')) {
    console.error(
      'Usage: npx tsx --tsconfig tsconfig.db.json db/apply.mts <gateway|tenant|marketplace>',
    );
    process.exit(1);
  }

  const databaseUrl = process.env[MIGRATOR_DATABASE_URL_ENV];

  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL is not set. Migrations run from the CI runner with the migrator credential of the target database, never from the Worker (HD6: Hyperdrive does not support advisory locks).',
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-llm-api-migrate',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error(`Could not connect to the database: ${(error as Error).message}`);
    process.exit(1);
  }

  try {
    const result = await applyMigrations(target, client, {
      onApplied: (name) => {
        console.log(`applied  ${name}`);
      },
    });
    console.log(
      `done     ${result.applied} file(s) applied; ${result.tablesInDatabase} table(s) in database ${databaseFor(target)}`,
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
