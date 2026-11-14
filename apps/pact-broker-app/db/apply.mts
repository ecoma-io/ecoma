/**
 * `pnpm nx run @ecoma-io/pact-broker-app:db:migrate` — apply migration của
 * `db-pact-broker-app`.
 *
 * Chạy từ **CI runner** bằng PostgreSQL client kết nối thẳng với credential
 * `_migrator_`, **không** chạy từ trong Worker — Hyperdrive không hỗ trợ
 * advisory lock (`04-platform-facts.md` HD6), mà advisory lock là cơ chế chính
 * chặn hai runner chạy song song. Cùng đường code `apps/backoffice/db/apply.mts`
 * (deliberate duplication giữa hai deploy unit — module boundary cấm import chéo).
 *
 * ## Biến môi trường
 *
 * | Biến           | Bắt buộc | Ý nghĩa                                               |
 * | -------------- | -------- | ----------------------------------------------------- |
 * | `DATABASE_URL` | có       | chuỗi kết nối PostgreSQL bằng credential **migrator** |
 *
 * CLI chỉ chạy khi file được gọi là main module (`tsx db/apply.mts`); import
 * từ test không kích hoạt nhánh CLI.
 */

import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

import { listMigrations, PACT_BROKER_APP_DATABASE, renderMigration } from './migrate.mts';

/** Kết quả một lần apply — CLI in ra, test assert. */
export interface ApplyMigrationsResult {
  /** Số file migration đã apply trong lần gọi này. */
  readonly applied: number;
  /** Số bảng (relkind `r`/`p`) trong schema `pact_broker_app` sau khi apply. */
  readonly tablesInPactBrokerAppSchema: number;
}

/**
 * Apply toàn bộ file migration, dưới advisory lock, trên client đã cho.
 *
 * ⚠️ Client phải là **migrator** (credential thật, không phải `SET ROLE` từ
 * superuser): quyền `CREATE` trên database là điều kiện để `0001` chạy.
 *
 * Thứ tự:
 * 1. Assert `current_database()` = `db-pact-broker-app` — TRƯỚC advisory lock.
 *    `DATABASE_URL` trỏ nhầm database mà không assert này sẽ migrate thành
 *    công vào database của service khác; assert biến cấu hình sai thành lỗi
 *    tường minh ở lần chạy đầu.
 * 2. `pg_advisory_lock(hashtext('db-pact-broker-app'))` — chặn hai runner chạy
 *    song song; session-scoped, tự nhả khi connection đóng.
 * 3. Apply từng file theo thứ tự tên. File hỏng dừng ngay — expand →
 *    compatible rollout → contract, forward-fix, không down-migration.
 * 4. Đếm bảng trong schema `pact_broker_app` — catalog `pg_class` là nguồn sự
 *    thật; mọi DDL trong `migrations/` phải idempotent.
 */
export async function applyAllMigrations(
  client: Client,
  options?: { readonly onApplied?: (migrationName: string) => void },
): Promise<ApplyMigrationsResult> {
  const { rows: currentDbRows } = await client.query<{ db: string }>(
    'SELECT current_database() AS db',
  );
  const currentDb = currentDbRows[0]?.db;
  if (currentDb !== PACT_BROKER_APP_DATABASE) {
    throw new Error(
      `migration runner is connected to "${currentDb ?? 'unknown'}", expected "${PACT_BROKER_APP_DATABASE}" ` +
        `— DATABASE_URL must point at ${PACT_BROKER_APP_DATABASE}, refusing to migrate a foreign database`,
    );
  }

  await client.query('SELECT pg_advisory_lock(hashtext($1))', [PACT_BROKER_APP_DATABASE]);

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
      WHERE n.nspname = 'pact_broker_app' AND c.relkind IN ('r', 'p')`,
  );

  return { applied, tablesInPactBrokerAppSchema: Number(rows[0]?.tables ?? '0') };
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL chua duoc dat. Migration chay tu CI runner bang role _migrator_, khong chay tu Worker (HD6: Hyperdrive khong ho tro advisory lock).',
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-pact-broker-app-migrate',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Khong ket noi duoc toi database:', (error as Error).message);
    process.exit(1);
  }

  try {
    const result = await applyAllMigrations(client, {
      onApplied: (name) => {
        console.log(`applied  ${name}`);
      },
    });
    console.log(
      `done     ${result.applied} file(s) applied; ${result.tablesInPactBrokerAppSchema} tables in schema pact_broker_app`,
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
