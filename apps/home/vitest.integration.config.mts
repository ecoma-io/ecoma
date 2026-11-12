import { defineConfig } from 'vitest/config';
/**
 * Config của target `test-integration` — suite app-owned dưới `tests/` phân loại
 * theo thư mục mục đích (`tests/integrations/`; 06-testing.md §2, §4:
 * `test-integration` = toàn bộ app-owned suite).
 *
 * ⚠️ Cần file config RIÊNG thay vì dùng lại `vitest.config.mts` kèm path filter:
 * `vitest run <filter>` chỉ chọn được file mà `include` khớp, nên gỡ suite
 * app-owned khỏi include của config unit mà vẫn gọi kèm path filter là 0 test
 * với exit 0 - hỏng im lặng. Tách config còn giúp suite tự sở hữu configuration
 * của chính nó (06-testing.md §1.3).
 *
 * ⚠️ Khác config unit: environment `node` — hai suite đọc artifact build thật
 * trên filesystem (`static-output` đọc `.output/public` prerender + Worker
 * bundle + `wrangler.jsonc`, `design-tokens` đọc CSS đã build), không mount
 * component nên không cần jsdom. Target `test-integration` khai `dependsOn`
 * `build` trong `package.json` để `.output/` tồn tại trước khi suite chạy.
 *
 * Không có Docker probe globalSetup: không suite nào của app dùng dependency
 * Docker/PostgreSQL (06-testing.md §6 chỉ bắt buộc probe khi suite phụ thuộc
 * Docker).
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/home',
  test: {
    name: '@ecoma-io/home-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integrations/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Không có spec nào khớp include là LỖI, không phải pass: "không test nào
    // chạy" phải đỏ để việc đổi đường dẫn suite không làm target chạy rỗng.
    passWithNoTests: false,
    // Nx đã cung cấp parallelism ở tầng task (nhiều project chạy đồng thời);
    // tắt song song hoá giữa các file suite trong MỘT process vitest để tránh
    // oversubscription nhân — cùng cấu hình với `apps/backoffice`.
    fileParallelism: false,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
