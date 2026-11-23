import { defineConfig } from 'drizzle-kit';

/**
 * Fixture config cho suite integration — journal `fail-migrations` (entry cuối
 * ném lỗi giữa batch). Dùng cho test interrupted-migration: kit atomic per-run
 * nên toàn bộ lần chạy rollback, không để lại state một phần.
 */
export default defineConfig({
  dialect: 'postgresql',
  out: 'tests/integrations/fixtures/fail-migrations',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'account',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
