/**
 * `pnpm nx run @ecoma-io/backoffice:db:migrate` — apply migration của `db-backoffice`.
 *
 * Chạy từ **CI runner** bằng PostgreSQL client kết nối thẳng với credential
 * `_migrator_`, **không** chạy từ trong Worker — cùng vừa tính chất với
 * `apps/account/db/apply.mts`: Hyperdrive không hỗ trợ advisory lock
 * (`docs/architecture/04-platform-facts.md` HD6), mà advisory lock là cơ chế chính
 * chặn hai runner chạy song song.
 *
 * ## Biến môi trường
 *
 * | Biến           | Bắt buộc | Ý nghĩa                                                       |
 * | -------------- | -------- | ------------------------------------------------------------- |
 * | `DATABASE_URL` | có       | chuỗi kết nối PostgreSQL bằng credential **migrator**         |
 *
 * `DATABASE_URL` không có thì exit code khác 0 và in hướng dẫn; coi im lặng
 * là đã apply là cách làm một lần migration biến mất.
 *
 * ## Một đường code cho việc apply
 *
 * {@link applyAllMigrations} là **thứ tự duy nhất** mà migration được apply:
 * cả CLI (`main` bên dưới) lẫn harness integration
 * `apps/backoffice/tests/integrations/harness.ts` đều gọi nó — đúng hình thức
 * `apps/account` đã dùng. Viết lại vòng apply bên harness là tạo runner thứ hai
 * không có advisory lock: test "apply hai lần no-op" chỉ chứng minh bản sao
 * của nó trong khi runner production kém hơn.
 *
 * CLI chỉ chạy khi file được gọi là main module (`tsx db/apply.mts`); import
 * từ test không kích hoạt nhánh CLI — nếu không, `process.exit(1)` vì thiếu
 * `DATABASE_URL` sẽ giết cả vitest mỗi khi nó import {@link applyAllMigrations}.
 */

import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

import { BACKOFFICE_DATABASE, listMigrations, renderMigration } from './migrate.mts';

/** Kết quả một lần apply — CLI in ra, test assert. */
export interface ApplyMigrationsResult {
  /** Số file migration đã apply trong lần gọi này. */
  readonly applied: number;
  /** Số bảng (relkind `r`/`p`) trong schema `backoffice` sau khi apply. */
  readonly tablesInBackofficeSchema: number;
}

/**
 * Biến môi trường truyền vào {@link applyAllMigrations} từ harness — **hiện
 * chưa được dùng** bởi migration nào. Giữ tên hằng để khi (nếu) migration sau
 * đọc GUC, test không phải đổi cách import.
 */
export const RESERVED_GUC_PREFIX = 'ecoma.backoffice_database';

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
 * `SET ROLE` không kiểm chứng được quyền kết nối thật — đúng chỗ mà
 * `provision()` của integration harness ghi chú.
 *
 * Thứ tự:
 * 1. Assert `current_database()` = {@link BACKOFFICE_DATABASE} (F3, issue
 *    #101) — TRƯỚC advisory lock. Một `DATABASE_URL` trỏ nhầm database (vd
 *    `db-account` cùng cluster) mà không assert này sẽ migrate thành công:
 *    schema `backoffice` rơi vào database sai, trọn bộ guard CONNECT/role của
 *    ranh giới không có tác dụng, và mọi migration sau đó chạy trên một
 *    database không thuộc sở hữu của service. Assert này biến cấu hình sai
 *    thành lỗi tường minh ở lần chạy đầu thay vì một database nửa-thế-giới.
 * 2. `pg_advisory_lock(hashtext('db-backoffice'))` — chặn hai runner chạy song
 *    song. Lock session-scoped nên tự nhả khi connection đóng. `hashtext`
 *    phía server thay vì hard-code hash trong code — đổi tên database thì
 *    khóa đổi theo.
 * 3. Apply từng file theo thứ tự tên. File hỏng dừng ngay và ném lỗi kèm tên
 *    file — expand → compatible rollout → contract, forward-fix, không
 *    down-migration.
 * 4. Đếm bảng trong schema `backoffice`. Không có bảng ledger riêng: catalog
 *    `pg_class` là nguồn sự thật — mọi câu DDL trong `migrations/` phải là
 *    idempotent, apply lại là no-op.
 */
export async function applyAllMigrations(
  client: Client,
  options?: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult> {
  const { rows: currentDbRows } = await client.query<{ db: string }>(
    'SELECT current_database() AS db',
  );
  const currentDb = currentDbRows[0]?.db;
  if (currentDb !== BACKOFFICE_DATABASE) {
    throw new Error(
      `migration runner is connected to "${currentDb ?? 'unknown'}", expected "${BACKOFFICE_DATABASE}" ` +
        `— DATABASE_URL must point at ${BACKOFFICE_DATABASE} (ADR-0001), refusing to migrate a foreign database`,
    );
  }

  await client.query('SELECT pg_advisory_lock(hashtext($1))', [BACKOFFICE_DATABASE]);

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
      WHERE n.nspname = 'backoffice' AND c.relkind IN ('r', 'p')`,
  );

  return { applied, tablesInBackofficeSchema: Number(rows[0]?.tables ?? '0') };
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
    application_name: 'ecoma-backoffice-migrate',
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
      `done     ${result.applied} file(s) applied; ${result.tablesInBackofficeSchema} tables in schema backoffice`,
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
