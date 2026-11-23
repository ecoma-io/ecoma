import { defineConfig } from 'drizzle-kit';

/**
 * Fixture config cho suite integration — journal `ok-migrations` (hai migration
 * hợp lệ). `out` resolve theo cwd của runner (project root). History schema
 * tường minh, cùng giá trị với config thật của project.
 */
export default defineConfig({
  dialect: 'postgresql',
  out: 'tests/integrations/fixtures/ok-migrations',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'remote_cache',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
