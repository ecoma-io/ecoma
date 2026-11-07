import { defineConfig } from 'vitest/config';

/**
 * Config của target `test-integration` — suite app-owned dưới `tests/integrations/`
 * (06-testing.md §2, §4: `test-integration` = toàn bộ suite app-owned).
 *
 * ⚠️ File config RIÊNG thay vì dùng lại `vitest.config.mts` kèm path filter —
 * cùng lý do với `apps/auth-nonce-prune-job` (path filter trên include unit là
 * 0 test với exit 0 - hỏng im lặng).
 *
 * ⚠️ `globalSetup` probe Docker một lần mỗi lần chạy; vắng Docker thì probe NÉM
 * và toàn bộ lần chạy đỏ (fail-loud, 06-testing.md §6).
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/staff-access-relay',
  test: {
    name: '@ecoma-io/staff-access-relay-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integrations/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: false,
    // Tắt song song hoá giữa các file suite: mỗi file dựng container PostgreSQL
    // riêng — hai container song song là hai lần provision migration (Nx đã cung
    // cấp parallelism ở tầng task).
    fileParallelism: false,
    reporters: ['default'],
    globalSetup: ['./tests/integrations/docker-probe.global-setup.ts'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
