import { defineConfig } from 'drizzle-kit';

/**
 * Fixture config cho suite integration — journal `baseline-migrations`
 * (một entry: schema `rvl` + bảng baseline_probe). State "previous release"
 * mà suite capture làm baseline.
 *
 * ⚠️ `out` resolve theo cwd của runner (project `databases/remote-cache-db`) —
 * đường dẫn tương đối chéo cây là chủ ý: runner thật phải chạy với cwd đúng
 * project authority của nó, fixture không copy runner sang chỗ khác.
 */
export default defineConfig({
  dialect: 'postgresql',
  out: '../../tools/release-validation/tests/integrations/fixtures/baseline-migrations',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'rvl',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
