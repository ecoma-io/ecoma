import { defineConfig, defaultExclude } from 'vitest/config';

/**
 * Config cua target `test` — chi spec colocated voi subject (06-testing.md §4:
 * `test` = colocated unit/component cua project so huu).
 *
 * ⚠️ Suite integration (PostgreSQL that qua testcontainers) nam o
 * `tests/integrations/` + `tests/databases/` va chay bang target
 * `test-integration` voi config rieng (`vitest.integration.config.mts`).
 * Include `tests/**` o day khong keo chung vao target `test` — config
 * integration loai tru cac thu muc do khoi target nay.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/staff-access',
  test: {
    name: '@ecoma-io/staff-access',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [...defaultExclude, 'tests/integrations/**', 'tests/databases/**'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
