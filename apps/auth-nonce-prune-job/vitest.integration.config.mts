import { defineConfig } from 'vitest/config';

/**
 * Config của target `test-integration` — suite app-owned dưới `tests/integrations/`
 * (06-testing.md §2, §4: `test-integration` = toàn bộ app-owned suite).
 *
 * ⚠️ Cần file config RIÊNG thay vì dùng lại `vitest.config.mts` kèm path filter:
 * `vitest run <filter>` chỉ chọn được file mà `include` khớp, nên gỡ suite app-owned
 * khỏi include của config unit mà vẫn gọi kèm path filter là 0 test với exit 0 - hỏng
 * im lặng. Tách config còn giúp suite tự sở hữu configuration của chính nó
 * (06-testing.md §1.3).
 *
 * ⚠️ `globalSetup` probe Docker một lần mỗi lần chạy; vắng Docker thì probe NÉM và
 * toàn bộ lần chạy đỏ (fail-loud, 06-testing.md §6) - skip với exit 0 không phải kết
 * quả chấp nhận được. Xem `tests/integrations/docker-probe.global-setup.ts`.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/auth-nonce-prune-job',
  test: {
    name: '@ecoma-io/auth-nonce-prune-job-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integrations/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Không có spec nào khớp include là LỖI, không phải pass: "không test nào chạy"
    // phải đỏ để việc đổi đường dẫn suite không làm target chạy rỗng.
    passWithNoTests: false,
    // ⚠️ Tắt song song hoá giữa các file suite trong MỘT process vitest: Nx đã cung
    // cấp parallelism ở tầng task (nhiều project chạy đồng thời), để vitest fork thêm
    // theo file là oversubscription NHÂN. Mỗi file suite ở đây còn dựng container
    // PostgreSQL riêng — hai container song song là hai lần provision 14 migration.
    fileParallelism: false,
    reporters: ['default'],
    globalSetup: ['./tests/integrations/docker-probe.global-setup.ts'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
