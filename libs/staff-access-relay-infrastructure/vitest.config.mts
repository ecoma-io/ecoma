/// <reference types='vitest' />
import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/staff-access-relay-infrastructure',
  test: {
    name: '@ecoma-io/staff-access-relay-infrastructure',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Không spec nào chưa được viết: true theo pattern staff-access-infrastructure —
    // suite integration thật của relay sống ở apps/staff-access-relay/tests/integrations.
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
