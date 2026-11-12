import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tools/llm-upstream-mock',
  test: {
    name: '@ecoma-io/llm-upstream-mock',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    // Suite timeout scenario giữ socket treo có chủ ý rồi destroy — cần biên độ
    // trên tổng thời gian mọi case, không phải default 5s từng test.
    testTimeout: 30_000,
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
