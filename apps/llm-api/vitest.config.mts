import { defineConfig, defaultExclude } from 'vitest/config';

/**
 * Config cua target `test` — chi spec colocated voi subject (06-testing.md §4:
 * `test` = colocated unit/component cua project so huu). Voi runtime Rust, unit
 * test that su chay qua `cargo test` (spec trong src/); config Vitest nay van
 * duoc giu de colocated TS spec (neu co sau nay) co nha chay — hom nay include
 * khong khop file nao nen `passWithNoTests: true`.
 *
 * Suite integration (PostgreSQL that qua testcontainers) nam duoi
 * `tests/integrations/` + `tests/databases/` va chay qua target
 * `test-integration` voi config rieng (`vitest.integration.config.mts`) —
 * exclude ben duoi dam bao target `test` khong nham suite do.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/llm-api',
  test: {
    name: '@ecoma-io/llm-api',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests,db}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [...defaultExclude, 'tests/integrations/**', 'tests/databases/**'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
