import { defineConfig } from 'vitest/config';

/**
 * Config của target `test-integration` — suite app-owned dưới `tests/`
 * (`tests/integrations/`; `06-testing.md` §2, §4: `test-integration` = toàn bộ
 * app-owned suite của app).
 *
 * ⚠️ Config RIÊNG thay vì dùng lại `vitest.config.mts` kèm path filter:
 * `vitest run <filter>` chỉ chọn được file mà `include` khớp, nên gỡ suite
 * app-owned khỏi include của config unit mà vẫn gọi kèm path filter là 0 test
 * với exit 0 — hỏng im lặng. Tách config cũng để suite tự sở hữu configuration
 * của chính nó (`06-testing.md` §1.3).
 *
 * ⚠️ Khác config unit: environment `node` (suite khởi động workerd, không mount
 * component nên không cần jsdom), không `setupFiles` (bridge Nuxt trong
 * `tests/` chỉ phục vụ unit tier), và không `globalSetup` probe Docker — suite
 * này chạy workerd in-process từ devDependency `wrangler`, không container nào,
 * nên không có phụ thuộc Docker để probe. Phụ thuộc cứng thật là binary workerd,
 * và thiếu nó thì `createTestHarness().listen()` ném ngay ở `beforeAll`.
 */
export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/llm-console-integration',
  test: {
    name: '@ecoma-io/llm-console-integration',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['tests/integrations/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // 0 test khớp include là LỖI, không pass: đổi đường dẫn suite không được
    // biến target thành một lần chạy rỗng xanh.
    passWithNoTests: false,
    // Tắt song song hoá giữa các file trong một process: mỗi file dựng một
    // workerd riêng, và Nx đã cung cấp parallelism ở tầng task — fork thêm theo
    // file là oversubscription nhân.
    fileParallelism: false,
    reporters: ['default'],
    coverage: {
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
