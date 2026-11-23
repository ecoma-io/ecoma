import { defineConfig } from 'vitest/config';

/**
 * Config của target `test-integration` — suite dưới `tests/integrations`
 * (06-testing.md §2, §4: `test-integration` = toàn bộ app-owned suite).
 *
 * ⚠️ Config RIÊNG thay vì path filter trên `vitest.config.mts`: `vitest run
 * <filter>` chỉ chọn được file mà `include` khớp — tách config còn để suite
 * tự sở hữu configuration của chính nó (06-testing.md §1.3).
 *
 * ⚠️ `globalSetup` probe Docker một lần mỗi lần chạy; vắng Docker thì probe
 * NÉM và toàn bộ lần chạy đỏ (fail-loud, 06-testing.md §6) — skip với exit 0
 * không phải kết quả chấp nhận được. Suite này chạy pg_dump/psql thật của
 * container postgres:17-alpine (docker CLI) + runner migration thật của
 * `databases/remote-cache-db` trên PostgreSQL thật.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/tools/release-validation-integration',
  test: {
    name: 'release-validation-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integrations/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Không có spec nào khớp include là LỖI, không phải pass: "không test nào
    // chạy" phải đỏ để việc đổi đường dẫn suite không làm target chạy rỗng.
    passWithNoTests: false,
    // Tắt song song hoá giữa các file suite: test dựng container Docker theo
    // prefix chung và recreate database hợp đồng — chạy tuần tự là điều kiện đúng.
    fileParallelism: false,
    reporters: ['default'],
    globalSetup: ['./tests/integrations/docker-probe.global-setup.ts'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
