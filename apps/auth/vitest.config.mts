import { defineConfig } from 'vitest/config';

/**
 * Config của target `test` — chỉ spec colocated với subject (06-testing.md §4:
 * `test` = colocated unit/component của project sở hữu).
 *
 * ⚠️ Suite integration nằm ở `tests/integrations/` + `tests/databases/` và chạy
 * qua target `test-integration` với config riêng (`vitest.integration.config.mts`).
 * Nhét suite app-owned vào include ở đây là chạy suite đó HAI lần (cả `test` lẫn
 * `test-integration`) hoặc - với app không có `test-integration` - chạy nó ở
 * target sai.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/auth',
  test: {
    name: '@ecoma-io/auth',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
