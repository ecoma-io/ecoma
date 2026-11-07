import { defineConfig } from 'vitest/config';

/**
 * Config của target `test-integration` — suite app-owned dưới `tests/` phân loại
 * theo thư mục mục đích (`tests/integrations/`, `tests/databases/`; 06-testing.md
 * §2, §4: `test-integration` = toàn bộ app-owned suite).
 *
 * ⚠️ Cần file config RIÊNG thay vì dùng lại `vitest.config.mts` kèm path filter:
 * `vitest run <filter>` chỉ chọn được file mà `include` khớp, nên gỡ suite
 * app-owned khỏi include của config unit mà vẫn gọi kèm path filter là 0 test
 * với exit 0 - hỏng im lặng. Tách config còn giúp suite tự sở hữu configuration
 * của chính nó (06-testing.md §1.3).
 *
 * ⚠️ Khác config unit: environment `node` (suite tự dựng app h3, không mount
 * component nên không cần jsdom), không `setupFiles` (bridge Nuxt của `tests/`
 * phục vụ unit tier), và có `globalSetup` probe Docker một lần mỗi lần chạy -
 * vắng Docker là probe NÉM, toàn bộ lần chạy đỏ (fail-loud, 06-testing.md §6).
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/backoffice',
  test: {
    name: '@ecoma-io/backoffice-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: [
      'tests/integrations/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'tests/databases/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    ],
    // Không có spec nào khớp include là LỖI, không phải pass: "không test nào
    // chạy" phải đỏ để việc đổi đường dẫn suite không làm target chạy rỗng.
    passWithNoTests: false,
    // ⚠️ Tắt song song hoá giữa các file suite trong MỘT process vitest: Nx đã
    // cung cấp parallelism ở tầng task (nhiều project chạy đồng thời), để
    // vitest fork thêm theo file là oversubscription NHÂN — runner 16 vCPU
    // với 6 task nx chạy cùng lúc là tới ~96 process fork giành CPU. Suite
    // integration còn có file full-flow (provider thật + PostgreSQL thật) cần
    // nguyên một core, không phải một phần sáu mười sáu.
    fileParallelism: false,
    reporters: ['default'],
    globalSetup: ['./tests/integrations/docker-probe.global-setup.ts'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
