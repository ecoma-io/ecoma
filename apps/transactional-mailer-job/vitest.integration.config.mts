import { defineConfig } from 'vitest/config';

/**
 * Config của target `test-integration` — suite app-owned dưới `tests/integrations/`
 * phân loại theo thư mục mục đích (06-testing.md §2, §4: `test-integration` = toàn bộ
 * app-owned suite).
 *
 * ⚠️ Cần file config RIÊNG thay vì dùng lại `vitest.config.mts` kèm path filter:
 * `vitest run <filter>` chỉ chọn được file mà `include` khớp, nên gỡ suite
 * app-owned khỏi include của config unit mà vẫn gọi kèm path filter là 0 test
 * với exit 0 - hỏng im lặng. Tách config còn giúp suite tự sở hữu configuration
 * của chính nó (06-testing.md §1.3).
 *
 * ⚠️ KHÔNG có `globalSetup` probe Docker: suite D1 của app này chạy workerd
 * in-process qua devDependency `wrangler`, không container nào được tạo — phụ thuộc
 * cứng thật của suite là binary workerd, và thiếu nó thì `getPlatformProxy` ném ngay
 * ở `beforeAll` (đỏ, không skip). 06-testing.md §6 chỉ bắt buộc fail-loud probe cho
 * suite **có** phụ thuộc Docker (PostgreSQL testcontainers của account/auth/backoffice).
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/transactional-mailer-job',
  test: {
    name: '@ecoma-io/transactional-mailer-job-integration',
    watch: false,
    globals: true,
    environment: 'node',
    // Chỉ `tests/integrations/`: app này là D1 (SQLite trên workerd), không có
    // migration SQL riêng để đo trong `tests/databases/` — include thêm vế
    // không tồn tại làm arch-check từ chối target (invalid-target-ref). Khi
    // app có databases suite thật, thêm vế include kèm thư mục.
    include: ['tests/integrations/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // Không có spec nào khớp include là LỖI, không phải pass: "không test nào
    // chạy" phải đỏ để việc đổi đường dẫn suite không làm target chạy rỗng.
    passWithNoTests: false,
    // ⚠️ Tắt song song hoá giữa các file suite trong MỘT process vitest: Nx đã
    // cung cấp parallelism ở tầng task (nhiều project chạy đồng thời). Suite D1
    // khởi động workerd in-process và spawn wrangler CLI để apply migration —
    // mỗi file đã nặng một process workerd + một subprocess CLI, để vitest fork
    // thêm theo file là oversubscription NHÂN.
    fileParallelism: false,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
