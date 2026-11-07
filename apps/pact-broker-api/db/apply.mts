/**
 * `pnpm nx run pact-broker-api:db:migrate` — apply migration của `db-pact-broker`.
 *
 * Chạy từ **CI runner** bằng PostgreSQL client với credential migrator,
 * **không** chạy từ Worker: Hyperdrive không hỗ trợ advisory lock (HD6,
 * `docs/architecture/04-platform-facts.md`), mà advisory lock là bước quan trọng
 * nhất ở đây.
 *
 * Biến môi trường:
 *
 * | Biến           | Bắt buộc | Ý nghĩa                                          |
 * | -------------- | -------- | ------------------------------------------------ |
 * | `DATABASE_URL` | có       | chuỗi kết nối PostgreSQL của **migrator**        |
 *
 * `DATABASE_URL` không có thì exit code khác 0 và in hướng dẫn; coi im lặng
 * là đã apply là cách làm một lần migration biến mất.
 *
 * ## Một đường code cho việc apply
 *
 * {@link applyAllMigrations} là **thứ tự duy nhất** mà migration được apply:
 * cả CLI (`main` bên dưới) lẫn integration test đều gọi nó. Viết vòng apply
 * riêng trong test là cách test "repeatable" chứng minh cho bản sao, không
 * cho runner production — lỗi đã từng xảy ra ở `apps/account` và được ghi rõ
 * trong JSDoc của `apps/account/db/apply.mts`; runner này giữ một đường duy
 * nhất từ đầu.
 */

import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

import { PACT_BROKER_DATABASE, listMigrations, renderMigration } from './migrate.mts';

/** Kết quả một lần apply — CLI in ra, test assert. */
export interface ApplyMigrationsResult {
  /** Số file migration đã apply trong lần gọi này. */
  readonly applied: number;
  /** Số bảng (relkind `r`/`p`) trong schema `pact` sau khi apply. */
  readonly tablesInPactSchema: number;
}

/** Tùy chọn của {@link applyAllMigrations}. */
export interface ApplyMigrationsOptions {
  /** Gọi cho mỗi file apply thành công — CLI dùng để in tiến trình. */
  readonly onApplied?: (migrationName: string) => void;
}

/**
 * Apply toàn bộ file migration, dưới advisory lock, trên client đã cho.
 *
 * ⚠️ Client phải là **migrator** (credential thật, không phải `SET ROLE` từ
 * superuser): quyền `CREATE` trên database là điều kiện để `0001` chạy, và
 * `SET ROLE` không kiểm chứng được quyền kết nối thật.
 *
 * Thứ tự:
 * 1. `pg_advisory_lock(hashtext('db-pact-broker'))` — chặn hai runner chạy
 *    song song. Lock session-scoped, tự nhả khi connection đóng; hash tính
 *    **phía server** theo tên database nên đổi tên thì khóa đổi theo, và hai
 *    service không tranh cùng một khóa.
 * 2. Apply từng file theo thứ tự tên. File hỏng dừng ngay và ném lỗi kèm tên
 *    file — forward-fix, không down-migration (`03-operations.md`).
 * 3. Đếm bảng trong schema `pact`. Không có ledger: catalog `pg_class` sau khi
 *    apply là nguồn sự thật, và mọi DDL trong `migrations/` idempotent — apply
 *    lại là no-op, không phải lỗi.
 */
export async function applyAllMigrations(
  client: Client,
  options?: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult> {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [PACT_BROKER_DATABASE]);

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
      WHERE n.nspname = 'pact' AND c.relkind IN ('r', 'p')`,
  );

  return { applied, tablesInPactSchema: Number(rows[0]?.tables ?? '0') };
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL chua duoc dat. Migration chay tu CI runner bang role migrator, khong chay tu Worker (HD6: Hyperdrive khong ho tro advisory lock).',
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-pact-broker-migrate',
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
      `done     ${result.applied} file(s) applied; ${result.tablesInPactSchema} tables in schema pact`,
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
