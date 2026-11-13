import { defineConfig } from 'vitest/config';

/**
 * Config của target `test-integration` — suite app-owned dưới `tests/`
 * (`tests/integrations/`, `tests/browser/`; `06-testing.md` §2, §4:
 * `test-integration` = toàn bộ app-owned suite của app).
 *
 * ⚠️ Config RIÊNG thay vì dùng lại `vitest.config.mts` kèm path filter:
 * `vitest run <filter>` chỉ chọn được file mà `include` khớp, nên gỡ suite
 * app-owned khỏi include của config unit mà vẫn gọi kèm path filter là 0 test
 * với exit 0 — hỏng im lặng. Tách config cũng để suite tự sở hữu configuration
 * của chính nó (`06-testing.md` §1.3).
 *
 * ⚠️ Khác config unit: environment `node` (suite khởi động workerd và Chromium,
 * không mount component nên không cần jsdom), không `setupFiles` (bridge Nuxt
 * trong `tests/` chỉ phục vụ unit tier). Phụ thuộc cứng thật là binary workerd
 * và Docker — thiếu workerd thì `createTestHarness().listen()` ném ngay ở
 * `beforeAll`; thiếu Docker thì `globalSetup` probe ĐỎ NGAY trước khi worker
 * nào kịp báo xanh giả (06-testing.md §6 — fail-loud, không có đường skip).
 *
 * ⚠️ `globalSetup` probe Docker một lần mỗi lần chạy bằng chính container
 * PostgreSQL mà suite dùng — xem `tests/integrations/docker-probe.global-setup.ts`.
 * Target này chứa contract suite + browser suite dựng full stack thật, nên
 * Docker là phụ thuộc cứng của target.
 *
 * ⚠️ `hookTimeout` 300s: một stack full (container PG → migrations → bootstrap
 * → token → workerd ×2 → seed) là công việc của phút đầu, không phải của giây
 * thứ 5 mặc định. `testTimeout` 120s cho từng it() có điều hướng browser.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/pact-broker-app-integration',
  test: {
    name: '@ecoma-io/pact-broker-app-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: [
      'tests/integrations/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'tests/browser/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    ],
    // 0 test khớp include là LỖI, không pass: đổi đường dẫn suite không được
    // biến target thành một lần chạy rỗng xanh.
    passWithNoTests: false,
    // Tắt song song hoá giữa các file trong một process: mỗi file dựng một
    // workerd riêng, và Nx đã cung cấp parallelism ở tầng task — fork thêm
    // theo file là oversubscription nhân.
    fileParallelism: false,
    reporters: ['default'],
    globalSetup: ['./tests/integrations/docker-probe.global-setup.ts'],
    hookTimeout: 300_000,
    testTimeout: 120_000,
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
