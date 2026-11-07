import { defineConfig, defaultExclude } from 'vitest/config';

/**
 * Config cua target `test` — chi spec colocated voi subject (06-testing.md §4:
 * `test` = colocated unit/component cua project so huu).
 *
 * Suite integration (PostgreSQL that qua testcontainers) nam duoi
 * `tests/integrations/` + `tests/databases/` va chay qua target
 * `test-integration` voi config rieng (`vitest.integration.config.mts`) —
 * exclude ben duoi dam bao target `test` khong nham suite do.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/remote-cache',
  test: {
    name: '@ecoma-io/remote-cache',
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
