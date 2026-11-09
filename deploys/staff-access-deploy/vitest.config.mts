import { defineConfig } from 'vitest/config';

/**
 * Config của target `test` của deploy unit — chỉ spec colocated với subject
 * (`bundle-hash.spec.ts`). `index.ts`/`local.ts` là chương trình/entry CLI,
 * không import được từ spec (đánh giá ngay khi import), nên không có spec cho
 * chúng ở đây.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/deploys/staff-access-deploy',
  test: {
    name: 'staff-access-deploy',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['./**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
