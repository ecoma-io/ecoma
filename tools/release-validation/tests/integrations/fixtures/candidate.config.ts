import { defineConfig } from 'drizzle-kit';

/**
 * Fixture config cho suite integration — journal `candidate-migrations`
 * (entry 0 y hệt baseline + entry 1 thêm `rvl.candidate_probe`): candidate
 * migration chạy TIẾN từ baseline-verified, kit chỉ áp entry có `when` lớn
 * hơn checkpoint đã ghi (§3a.3 checkpoint per-run).
 */
export default defineConfig({
  dialect: 'postgresql',
  out: '../../tools/release-validation/tests/integrations/fixtures/candidate-migrations',
  migrations: {
    table: '__drizzle_migrations',
    schema: 'rvl',
  },
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
