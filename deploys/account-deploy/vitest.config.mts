import { defineConfig } from 'vitest/config';

/**
 * Config của target `test` — spec colocated với subject (06-testing.md §4:
 * `test` = unit/component colocated của project sở hữu). Hiện chỉ có
 * `scripts.spec.ts` (bất biến tĩnh của script text + escaping qua `/bin/sh`
 * thật — không Docker).
 *
 * Suite integration chạy Docker + PostgreSQL thật nằm dưới `tests/integrations/`
 * và chạy qua target `test-integration` với config riêng
 * (`vitest.integration.config.mts`) — include dưới đây KHÔNG phủ `tests/` để
 * target `test` không nhắm nhầm suite đó (06-testing.md §9: spec colocated
 * không boot database thật).
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/deploys/account-deploy',
  test: {
    name: 'account-deploy',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: false,
    reporters: ['default'],
  },
}));
