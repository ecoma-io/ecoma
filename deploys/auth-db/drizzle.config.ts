import { defineConfig } from 'drizzle-kit';

/**
 * Config Drizzle Kit của migration authority `db-auth` (§3a.2, §3a.3).
 *
 * SQL-first: KHÔNG có `schema` TS ở đây — canonical schema là SQL trong
 * `migrations/` + `meta/_journal.json`. `out` là thư mục layout phẳng của kit
 * 0.31.11: mỗi entry journal `<idx>_<name>` ứng file `migrations/<idx>_<name>.sql`
 * (`readMigrationFiles` của drizzle-orm đọc `${out}/${tag}.sql`).
 *
 * History table thuộc Drizzle Kit (§3a.3), nhưng schema được chọn TƯỜNG MINH —
 * schema riêng của database (`auth`), không bao giờ `public` hay
 * `drizzle` ngầm. Kit bỏ qua field này nếu thiếu, dẫn tới default `drizzle` của
 * orm — nên giá trị phải luôn có mặt trong file này.
 *
 * `DATABASE_URL` là credential của role `_migrator` (contract §3.1) — kết nối
 * thẳng PostgreSQL, không qua Hyperdrive (HD6). `db-generate`/`db-check` không
 * cần database thật; chỉ `db-migrate`/`stamp` đọc URL.
 */
export default defineConfig({
  dialect: 'postgresql',
  out: 'migrations',
  // Kit bắt buộc `schema` cho cả `generate --custom`; thư mục `schema/` giữ
  // chỗ có chủ đích (chỉ .gitkeep — một schema TS suy ra từ SQL là bổ sung
  // sau theo §3a.2, không phải điều kiện cutover).
  schema: './schema',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'auth',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
