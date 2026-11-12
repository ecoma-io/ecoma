import { defineConfig } from 'vitest/config';

/**
 * Config của target `test` — spec colocated với subject (06-testing.md §4:
 * `test` = unit/component colocated của project sở hữu). Spec colocated:
 * `scripts.spec.ts` (bất biến tĩnh của script text — không Docker),
 * `superadmin-resolver.spec.ts`.
 *
 * Suite integration chạy Docker + PostgreSQL thật nằm dưới `tests/integrations/`
 * và chạy qua target `test-integration` với config riêng
 * (`vitest.integration.config.mts`) — include chỉ ở cấp gốc package đảm bảo
 * target `test` không nhắm nhầm suite đó (06-testing.md §9: spec colocated
 * không boot database thật).
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/deploys/pact-broker-api-deploy',
  test: {
    name: 'pact-broker-api-deploy',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: false,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
