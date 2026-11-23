import { defineConfig } from 'vitest/config';

/**
 * Config của target `test-integration` — suite app-owned dưới `tests/`
 * (06-testing.md §2, §4: `test-integration` = toàn bộ app-owned suite).
 *
 * ⚠️ Config RIÊNG thay vì path filter trên `vitest.config.mts`: `vitest run
 * <filter>` chỉ chọn được file mà `include` khớp — tách config còn để suite
 * tự sở hữu configuration của chính nó (06-testing.md §1.3).
 *
 * ⚠️ `globalSetup` probe Docker một lần mỗi lần chạy; vắng Docker thì probe
 * NÉM và toàn bộ lần chạy đỏ (fail-loud, 06-testing.md §6) — skip với exit 0
 * không phải kết quả chấp nhận được. Suite này chạy runner migration THẬT
 * (`drizzle-kit migrate` + wrapper) trên PostgreSQL thật.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/databases/llm-gateway-db-integration',
  test: {
    name: 'llm-gateway-db-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integrations/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Không có spec nào khớp include là LỖI, không phải pass: "không test nào
    // chạy" phải đỏ để việc đổi đường dẫn suite không làm target chạy rỗng.
    passWithNoTests: false,
    // Tắt song song hoá giữa các file suite: các test chia sẻ một container và
    // recreate database theo tên hợp đồng — chạy tuần tự là điều kiện đúng.
    fileParallelism: false,
    reporters: ['default'],
    globalSetup: ['./tests/integrations/docker-probe.global-setup.ts'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
