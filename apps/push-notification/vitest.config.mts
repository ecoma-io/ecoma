import { defineConfig, defaultExclude } from 'vitest/config';

/**
 * Config của target `test` — chỉ spec colocated với subject (06-testing.md §4:
 * `test` = colocated unit/component của project sở hữu).
 *
 * ⚠️ Suite integration nằm ở `tests/integrations/` và chạy qua target `test-integration`
 * với config riêng (`vitest.integration.config.mts`). Nhét suite app-owned vào include ở
 * đây là chạy suite đó hai lần (cả `test` lẫn `test-integration`).
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/push-notification',
  test: {
    name: '@ecoma-io/push-notification',
    watch: false,
    globals: true,
    environment: 'node',
    // ⚠️ Suite integration nằm ở `tests/integrations/` và chạy qua target `test-integration`
    // với config riêng (`vitest.integration.config.mts`). Include bên dưới phủ `tests/**`,
    // nên phải exclude đúng thư mục mục đích đó — nếu không, mọi suite integration chạy
    // HAI lần (cả `test` lẫn `test-integration`) (06-testing.md §4).
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [...defaultExclude, 'tests/integrations/**'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
