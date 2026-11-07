/**
 * `pnpm nx run @ecoma-io/auth:db:migrate` — apply migration của `db-auth`.
 *
 * Chạy từ **CI runner** bằng PostgreSQL client kết nối thẳng với credential
 * `ecoma_auth_migrator`, **không** chạy từ trong Worker: Hyperdrive không hỗ trợ
 * advisory lock (`docs/architecture/04-platform-facts.md` HD6), mà bước quan trọng
 * nhất ở đây chính là advisory lock. Đây là runner canonical mà
 * `apps/auth/migrations/README.md` §"Cách áp dụng" mô tả — protocol (history
 * table, checksum, thứ tự tên file) được hiện thực hoá tại một nơi duy nhất;
 * deploy program (`deploys/auth-deploy`) chỉ gọi đường này, không tự viết lại
 * vòng apply.
 *
 * Biến môi trường:
 *
 * | Biến           | Bắt buộc | Ý nghĩa                                              |
 * | -------------- | -------- | ---------------------------------------------------- |
 * | `DATABASE_URL` | có       | chuỗi kết nối PostgreSQL của **migrator** vào `db-auth` |
 *
 * `DATABASE_URL` không có thì exit code khác 0 và in hướng dẫn tiếng Anh; coi
 * im lặng là đã apply là cách làm một lần migration biến mất. (CLI output là
 * tiếng Anh theo quy ước repo — khác với chuỗi tiếng Việt không dấu của runner
 * `account` đời đầu, vốn không được sửa lại trong PR này.)
 *
 * ## Một đường code cho việc apply
 *
 * {@link applyAllMigrations} là **thứ tự duy nhất** mà migration được apply:
 * cả CLI (`main` bên dưới) lẫn integration test đều gọi nó. Test không dựng một
 * runner thứ hai — nếu vậy thì test "repeatable" chỉ chứng minh cho bản sao,
 * không cho runner production. Một đường code duy nhất thì lock, history,
 * checksum và thứ tự file được test chính là cái mà CLI chạy.
 *
 * CLI chỉ chạy khi file được gọi là main module (`tsx db/apply.mts`); import
 * từ test không kích hoạt nhánh CLI — nếu không, `process.exit(1)` vì thiếu
 * `DATABASE_URL` sẽ giết cả vitest khi nó import {@link applyAllMigrations}.
 */

import { Client } from 'pg';
import { pathToFileURL } from 'node:url';

import { AUTH_DATABASE, checksumMigration, listMigrations } from './migrate.mts';

/** Kết quả một lần apply — CLI in ra, test assert. */
export interface ApplyMigrationsResult {
  /** Số file migration đã apply trong lần gọi này. */
  readonly applied: number;
  /** Số file bỏ qua vì đã có trong lịch sử (checksum khớp). */
  readonly skipped: number;
  /** Số bảng (relkind `r`/`p`) trong schema `auth` sau khi apply. */
  readonly tablesInAuthSchema: number;
}

/** Tùy chọn của {@link applyAllMigrations}. */
export interface ApplyMigrationsOptions {
  /**
   * Thư mục migration; mặc định {@link MIGRATIONS_DIR} của app.
   *
   * Test drift dùng tuỳ chọn này để trỏ sang bản sao trong tmp dir với một file
   * bị sửa — sửa file thật trong repo là đụng tài nguyên dùng chung.
   */
  readonly migrationsDir?: string;
  /** Gọi cho mỗi file apply thành công — CLI dùng để in tiến trình. */
  readonly onApplied?: (migrationName: string) => void;
}

/**
 * Bảo đảm history table do **runner sở hữu** tồn tại: schema `auth` và bảng
 * `auth.schema_migrations`.
 *
 * Schema `auth` thuộc về migrator (`AUTHORIZATION ecoma_auth_migrator` — cùng
 *.AUTHORIZATION mà file `0001` dùng), nên migrator tự tạo được nó nếu chưa có,
 * không cần quyền nào ngoài `CREATE` trên database mà provisioning đã cấp.
 * Tạo trước vòng apply nghĩa là file `0001` của migration và runner cùng nhìn
 * thấy một schema — không phân biệt ai đến trước (runbook operator ghi chú cả
 * hai đường đều dùng đúng `AUTHORIZATION`, ai tới trước cũng vậy).
 */
async function ensureHistoryTable(client: Client): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION ecoma_auth_migrator');
  await client.query(`CREATE TABLE IF NOT EXISTS auth.schema_migrations (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

/**
 * Apply toàn bộ file migration, dưới advisory lock, trên client đã cho.
 *
 * ⚠️ Client phải là **migrator** (credential thật, không phải `SET ROLE` từ
 * superuser): quyền `CREATE` trên database là điều kiện để `0001` và history
 * table chạy được, và `SET ROLE` không kiểm chứng được quyền kết nối thật —
 * chạy bằng superuser thì mọi test về grant có ý nghĩa sai.
 *
 * Thứ tự:
 * 1. History table (xem {@link ensureHistoryTable}).
 * 2. `pg_advisory_lock(hashtext('db-auth'))` — chặn hai runner chạy song song.
 *    Session-scoped nên tự nhả khi connection đóng, không để lại lock trôi nếu
 *    runner bị kill giữa chừng. Key lấy bằng `hashtext` phía server theo chính
 *    tên database (`AUTH_DATABASE`) — khác khóa của `db-account`, hai deploy
 *    unit rollout độc lập không tranh khóa của nhau (`README.md` §"Cách áp
 *    dụng" bước 2).
 * 3. Đọc lịch sử vào map. Với mỗi file theo thứ tự tên: có trong lịch sử → bỏ
 *    qua; checksum lệch lịch sử → ném lỗi drift ngay (không tự "sửa" bằng DDL
 *    trùng — `README.md` §"Cách áp dụng" bước 5); chưa có → apply và ghi dòng
 *    lịch sử.
 * 4. Transactionality từng file: các file `0011`–`0014` **tự bọc**
 *    `BEGIN;…COMMIT;` (mỗi file ghi rõ yêu cầu đó trong phần đầu), nên chúng
 *    được gửi nguyên vẹn như một batch đơn — PostgreSQL 17 không có nested
 *    transaction top-level, và một `BEGIN` mới giữa transaction chỉ in warning
 *    rồi tiếp tục, tức là bọc thêm `BEGIN` ngoài sẽ phá chính tính rollback
 *    toàn phần mà file yêu cầu. Các file còn lại (không tự bọc) được bọc
 *    `BEGIN` → file → history INSERT → `COMMIT`, lỗi thì `ROLLBACK` — file dở
 *    giữa chừng hỏng đồng đều, không để lại trạng thái "bảng đã tạo xong, bảng
 *    chưa tạo".
 *
 *    ⚠️ Biên đã biết, cả hai protocol đều có (protocol `psql -1` của README
 *    cũng vậy): file tự bọc COMMIT **trước** khi dòng lịch sử được ghi; process
 *    chết đúng giữa hai bước thì file đã áp mà lịch sử không có — lần apply
 *    sau sẽ nạp lại và (vì phần lớn DDL không idempotent) chết với
 *    `already exists` = drift abort ồn ào, KHÔNG BAO GIỜ là apply lại âm thầm.
 *    Người chạy can thiệp bằng tay theo runbook; runner không tự đoán.
 * 5. Đếm bảng trong schema `auth`. Catalog `pg_class` sau khi apply là nguồn sự
 *    thật về schema đang chạy — độc lập với bảng lịch sử, lệch nào giữa hai
 *    bên cũng lộ qua test.
 */
export async function applyAllMigrations(
  client: Client,
  options?: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult> {
  await ensureHistoryTable(client);
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [AUTH_DATABASE]);

  const { rows: historyRows } = await client.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM auth.schema_migrations',
  );
  const applied = new Map(historyRows.map((row) => [row.filename, row.checksum]));

  let appliedCount = 0;
  let skippedCount = 0;
  for (const migration of listMigrations(options?.migrationsDir)) {
    const knownChecksum = applied.get(migration.name);
    if (knownChecksum !== undefined) {
      if (knownChecksum !== checksumMigration(migration.sql)) {
        throw new Error(
          `migration ${migration.name} has drifted: applied checksum ${knownChecksum} ` +
            `does not match current file ${checksumMigration(migration.sql)} — ` +
            'never re-edit an applied migration, add a new forward-fix file instead',
        );
      }
      skippedCount += 1;
      continue;
    }

    await applyOneMigration(client, migration);
    options?.onApplied?.(migration.name);
    appliedCount += 1;
  }

  const { rows } = await client.query<{ tables: string }>(
    `SELECT count(*)::text AS tables
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p')`,
  );

  return {
    applied: appliedCount,
    skipped: skippedCount,
    tablesInAuthSchema: Number(rows[0]?.tables ?? '0'),
  };
}

/** Nội dung SQL của một file tự bọc transaction (`BEGIN;…COMMIT;` trong file). */
const SELF_TRANSACTIONAL = /^\s*BEGIN\b/mu;

/**
 * Apply đúng một file kèm dòng lịch sử của nó, theo quy tắc transactionality
 * ở JSDoc của {@link applyAllMigrations}.
 */
async function applyOneMigration(
  client: Client,
  migration: { readonly name: string; readonly sql: string },
): Promise<void> {
  const selfTransactional = SELF_TRANSACTIONAL.test(migration.sql);
  const checksum = checksumMigration(migration.sql);
  const insertHistory = 'INSERT INTO auth.schema_migrations (filename, checksum) VALUES ($1, $2)';

  try {
    if (selfTransactional) {
      // File tự bọc: gửi nguyên vẹn như một batch đơn. Batch đơn của `pg` chạy
      // trong implicit transaction của simple query protocol — `BEGIN`/`COMMIT`
      // của file điều khiển đúng transaction đó; mọi điểm hỏng rollback toàn
      // phần theo đúng thiết kế của file.
      await client.query(migration.sql);
      await client.query(insertHistory, [migration.name, checksum]);
    } else {
      // File không tự bọc: runner bọc file + dòng lịch sử trong MỘT transaction
      // — file áp xong mà lịch sử không ghi được thì cả hai rollback cùng nhau.
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(insertHistory, [migration.name, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  } catch (error) {
    throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

/** Nhánh CLI — chỉ chạy khi file này là main module. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];

  if (databaseUrl === undefined || databaseUrl === '') {
    console.error(
      'DATABASE_URL is not set. Auth migrations run from a CI runner with the _migrator_ ' +
        'credential, never from inside a Worker (HD6: Hyperdrive does not support advisory locks).',
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'ecoma-auth-migrate',
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to connect to the database:', (error as Error).message);
    process.exit(1);
  }

  try {
    const result = await applyAllMigrations(client, {
      // Dừng ở file hỏng và để nguyên các file trước; applyAllMigrations đã
      // ném kèm tên file.
      onApplied: (name) => {
        console.log(`applied  ${name}`);
      },
    });
    console.log(
      `done     ${result.applied} file(s) applied, ${result.skipped} skipped; ` +
        `${result.tablesInAuthSchema} tables in schema auth`,
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
