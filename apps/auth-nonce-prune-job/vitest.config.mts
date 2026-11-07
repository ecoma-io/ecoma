import { defineConfig, defaultExclude } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/auth-nonce-prune-job',
  test: {
    name: '@ecoma-io/auth-nonce-prune-job',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // ⚠️ Suite integration nằm ở `tests/integrations/` và chạy qua target
    // `test-integration` với config riêng (`vitest.integration.config.mts`).
    // Include bên dưới phủ `tests/**`, nên phải exclude đúng thư mục mục đích đó —
    // nếu không, suite PostgreSQL thật chạy HAI lần (cả `test` lẫn
    // `test-integration`) và target unit phải có Docker mới xanh (06-testing.md §4).
    exclude: [...defaultExclude, 'tests/integrations/**'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
