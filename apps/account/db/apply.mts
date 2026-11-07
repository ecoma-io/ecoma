/**
 * `pnpm nx run account:db:migrate` — apply migration của `db-account`.
 *
 * Chạy từ **CI runner** bằng PostgreSQL client kết nối thẳng với credential
 * `_migrator_`, **không** chạy từ trong Worker: Hyperdrive không hỗ trợ advisory
 * lock (`docs/architecture/04-platform-facts.md` HD6), mà bước quan trọng nhất ở đây
 * chính là advisory lock.
 *
 * Biến môi trường:
 *
 * | Biến                  | Bắt buộc | Ý nghĩa                                                   |
 * | --------------------- | -------- | -------------------------------------------------------- |
 * | `DATABASE_URL`        | có       | chuỗi kết nối PostgreSQL của **migrator**                 |
 * | `ECOMA_AUTH_DATABASE` | không    | tên database cần `REVOKE CONNECT`; mặc định `db-auth`      |
 *
 * `DATABASE_URL` không có thì exit code khác 0 và in hướng dẫn; coi im lặng
 * là đã apply là cách làm một lần migration biến mất.
 *
 * ## Một đường code cho việc apply
 *
 * {@link applyAllMigrations} là **thứ tự duy nhất** mà migration được apply:
 * cả CLI (`main` bên dưới) lẫn `harness.applyMigrations` của integration test
 * đều gọi nó. Harness trước đây **tự viết lại vòng apply** — bỏ advisory lock
 * và thoả thuận "apply bằng migrator thật" — nên test "repeatable" chỉ chứng
 * minh cho bản sao, không cho runner production. Một đường code duy nhất thì
 * lock, GUC và thứ tự file được test chính là cái mà CLI chạy.
 *
 * CLI chỉ chạy khi file được gọi là main module (`tsx db/apply.mts`); import
 * từ test không kích hoạt nhánh CLI — nếu không, `process.exit(1)` vì thiếu
 * `DATABASE_URL` sẽ giết cả vitest khi nó import {@link applyAllMigrations}.
 */

import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

import {
  ACCOUNT_DATABASE,
  AUTH_DATABASE,
  AUTH_DATABASE_GUC,
  listMigrations,
  renderMigration,
} from './migrate.mts';

/** Kết quả một lần apply — CLI in ra, test assert. */
export interface ApplyMigrationsResult {
  /** Số file migration đã apply trong lần gọi này. */
  readonly applied: number;
  /** Số bảng (relkind `r`/`p`) trong schema `account` sau khi apply. */
  readonly tablesInAccountSchema: number;
}

/** Tùy chọn của {@link applyAllMigrations}. */
export interface ApplyMigrationsOptions {
  /**
   * Tên database cần `REVOKE CONNECT`; mặc định {@link AUTH_DATABASE}.
   *
   * GUC `ecoma.auth_database` truyền tên này xuống SQL, vì file migration phải
   * đọc được tên thật của instance thay vì hard-code một tên khác.
   */
  readonly authDatabase?: string;
  /** Gọi cho mỗi file apply thành công — CLI dùng để in tiến trình. */
  readonly onApplied?: (migrationName: string) => void;
}

/**
 * Apply toàn bộ file migration, dưới advisory lock, trên client đã cho.
 *
 * ⚠️ Client phải là **migrator** (credential thật, không phải `SET ROLE` từ
 * superuser): quyền `CREATE` trên database là điều kiện để `0001` chạy, và
 * `SET ROLE` không kiểm chứng được quyền kết nối thật — đúng chỗ mà
 * `harness.startAccountDatabase` ghi chú.
 *
 * Thứ tự:
 * 1. `SET ecoma.auth_database` — GUC mà `0002` đọc để biết tên database cần chặn.
 * 2. `pg_advisory_lock(hashtext('db-account'))` — chặn hai runner chạy song
 *    song. Lock session-scoped nên tự nhả khi connection đóng, không để lại
 *    lock trôi nếu runner bị kill giữa chừng. `hashtext` phía server thay vì
 *    hard-code hash trong code — đổi tên database thì khóa đổi theo.
 * 3. Apply từng file theo thứ tự tên. File hỏng dừng ngay và ném lỗi kèm tên
 *    file — expand → compatible rollout → contract, forward-fix, không
 *    down-migration (`03-operations.md` §3.2).
 * 4. Đếm bảng trong schema `account`. Không có bảng ledger riêng: catalog
 *    `pg_class` sau khi apply là nguồn sự thật — đó cũng chính là lý do mọi
 *    câu DDL trong `migrations/` phải idempotent: apply lại là no-op, không
 *    phải lỗi.
 */
export async function applyAllMigrations(
  client: Client,
  options?: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult> {
  const authDatabase = options?.authDatabase ?? AUTH_DATABASE;

  await client.query(`SET ${AUTH_DATABASE_GUC} = '${authDatabase.replaceAll("'", "''")}'`);
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [ACCOUNT_DATABASE]);

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
      WHERE n.nspname = 'account' AND c.relkind IN ('r', 'p')`,
  );

  return { applied, tablesInAccountSchema: Number(rows[0]?.tables ?? '0') };
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  const authDatabase = process.env['ECOMA_AUTH_DATABASE'] ?? AUTH_DATABASE;

  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL chua duoc dat. Migration chay tu CI runner bang role _migrator_, khong chay tu Worker (HD6: Hyperdrive khong ho tro advisory lock).',
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-account-migrate',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Khong ket noi duoc toi database:', (error as Error).message);
    process.exit(1);
  }

  try {
    const result = await applyAllMigrations(client, {
      authDatabase,
      // Dừng ở file hỏng và để nguyên các file trước; applyAllMigrations đã
      // ném kèm tên file.
      onApplied: (name) => {
        console.log(`applied  ${name}`);
      },
    });
    console.log(
      `done     ${result.applied} file(s) applied; ${result.tablesInAccountSchema} tables in schema account`,
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
