import { defineConfig } from 'drizzle-kit';

/**
 * Config Drizzle Kit của migration authority `db-llm-gateway` (§3a.2, §3a.3).
 *
 * SQL-first: KHÔNG có `schema` TS ở đây — canonical schema là SQL trong
 * `migrations/` + `meta/_journal.json`. `out` là thư mục layout phẳng của kit
 * 0.31.11: mỗi entry journal `<idx>_<name>` ứng file `migrations/<idx>_<name>.sql`
 * (`readMigrationFiles` của drizzle-orm đọc `${out}/${tag}.sql`).
 *
 * History table thuộc Drizzle Kit (§3a.3), nhưng schema được chọn TƯỜNG MINH —
 * schema riêng của database (`llm_gateway`), không bao giờ `public` hay
 * `drizzle` ngầm. Kit bỏ qua field này nếu thiếu, dẫn tới default `drizzle` của
 * orm — nên giá trị phải luôn có mặt trong file này.
 *
 * `DATABASE_URL` là credential của role `_migrator` (contract §3.1) — kết nối
 * thẳng PostgreSQL, không qua Hyperdrive (HD6). `db-generate`/`db-check` không
 * cần database thật; chỉ `db-migrate`/`stamp` đọc URL.
 */

/**
 * Guard fail-fast #496: lệnh kit chạm database thật cần DATABASE_URL có mặt
 * ngay khi config được evaluate — thiếu/rỗng là throw với message tường minh
 * thay vì `?? ''` cho kit fail mờ ở bước kết nối khó đọc. `generate`, `check`,
 * `up`, `drop`, `export` thuần file (offline) giữ nguyên hành vi cũ — đường CI
 * `db-generate`/`db-check` không secret vẫn chạy. Runner.mts (đường chính thức)
 * đã validate DATABASE_URL trước khi spawn `drizzle-kit migrate` (§3a); guard
 * này là lớp trong cùng cho lệnh kit gọi tay.
 */
const DATABASE_COMMANDS = new Set(['migrate', 'push', 'pull', 'introspect', 'studio']);
const kitCommand = process.argv[2];
if (kitCommand !== undefined && DATABASE_COMMANDS.has(kitCommand) && !process.env.DATABASE_URL) {
  throw new Error(
    `DATABASE_URL is required for "drizzle-kit ${kitCommand}" - this command connects to ` +
      'the database; set the _migrator connection URL first (contract 02-delivery.md section 3.1). ' +
      'Offline commands (generate, check) do not need it.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  out: 'migrations',
  // Kit bắt buộc `schema` cho cả `generate --custom`; thư mục `schema/` giữ
  // chỗ có chủ đích (chỉ .gitkeep — một schema TS suy ra từ SQL là bổ sung
  // sau theo §3a.2, không phải điều kiện cutover).
  schema: './schema',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'llm_gateway',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
