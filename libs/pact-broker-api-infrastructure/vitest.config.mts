import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/pact-broker-api-infrastructure',
  test: {
    name: '@ecoma-io/pact-broker-api-infrastructure',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: true,
    // Legitimately zero unit tests today: real suites live in the owning app's
    // integration tier (tests/integrations/ of the owning app). passWithNoTests:
    // true is deliberate until the first unit spec lands; delete this flag then.
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
