import { defineConfig } from 'vitest/config';

/**
 * Config của target `test-integration` — suite app-owned dưới `tests/`
 * (`tests/integrations/` + `tests/browser/`; `06-testing.md` §2, §4:
 * `test-integration` = toàn bộ app-owned suite của app).
 *
 * ⚠️ Config RIÊNG thay vì dùng lại `vitest.config.mts` kèm path filter:
 * `vitest run <filter>` chỉ chọn được file mà `include` khớp, nên gỡ suite
 * app-owned khỏi include của config unit mà vẫn gọi kèm path filter là 0 test
 * với exit 0 — hỏng im lặng. Tách config cũng để suite tự sở hữu configuration
 * của chính nó (`06-testing.md` §1.3).
 *
 * ⚠️ Khác config unit: environment `node` (suite khởi động workerd và
 * Chromium, không mount component nên không cần jsdom), không `setupFiles`
 * (bridge Nuxt trong `tests/` chỉ phục vụ unit tier). Phụ thuộc cứng thật là
 * binary workerd, Docker và binary Chromium — thiếu workerd thì
 * `createTestHarness().listen()` ném ngay ở `beforeAll`; thiếu Docker thì
 * `globalSetup` probe ĐỎ NGAY (browser suite dựng container PostgreSQL thật);
 * thiếu Chromium là đỏ tại `chromium.launch()` — không có đường skip
 * (06-testing.md §6 — fail-loud).
 *
 * ⚠️ `globalSetup` probe Docker một lần mỗi lần chạy bằng chính container
 * PostgreSQL mà browser suite dùng — xem
 * `tests/browser/docker-probe.global-setup.ts`. Suite `tests/integrations/`
 * cũng dựng container riêng (`roles.spec.ts` qua `startRemoteCacheAppDatabase`,
 * docker CLI), nên probe giữ luật fail-loud thống nhất cho cả target.
 *
 * ⚠️ `hookTimeout` 300s: stack full (container PG → migrations → bootstrap →
 * workerd ×2 → seed) là công việc của phút đầu. `testTimeout` 120s cho từng
 * it() có điều hướng browser.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/remote-cache-app-integration',
  test: {
    name: '@ecoma-io/remote-cache-app-integration',
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
    globalSetup: ['./tests/browser/docker-probe.global-setup.ts'],
    hookTimeout: 300_000,
    testTimeout: 120_000,
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
