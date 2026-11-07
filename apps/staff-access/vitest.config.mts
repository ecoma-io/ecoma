import { defineConfig, defaultExclude } from 'vitest/config';

/**
 * Config cua target `test` — chi spec colocated voi subject (06-testing.md §4:
 * `test` = colocated unit/component cua project so huu).
 *
 * ⚠️ Suite integration (PostgreSQL that qua testcontainers) thuoc Milestone B
 * (`tests/integrations/` + `tests/databases/` va target `test-integration` voi
 * config rieng) — hien chua ton tai; include ben duoi da phu `tests/**` de
 * suite tuong lai khong phai sua config, nhung hien khong co file nao khop.
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
