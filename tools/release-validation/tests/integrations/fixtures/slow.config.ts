import { defineConfig } from 'drizzle-kit';

/**
 * Fixture config cho suite integration — journal `slow-migrations` (entry 1
 * chứa `pg_sleep(5)`): dùng cho test interrupted-migration — kill -9 giữa
 * chừng, transaction của kit rollback toàn bộ entry chưa commit (§3a.5),
 * để lại state = baseline đã restore.
 */
export default defineConfig({
  dialect: 'postgresql',
  out: '../../tools/release-validation/tests/integrations/fixtures/slow-migrations',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'rvl',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
