import { defineConfig, devices } from '@playwright/test';

/**
 * Cấu hình Playwright cho **lane unavailable** của backoffice.
 *
 * Chạy Nuxt dev với `NITRO_PUBLIC_BACKOFFICE_DATA_MODE=disabled` để backoffice
 * vào trạng thái "không khả dụng" (fail-closed): không banner dữ liệu mẫu,
 * không dữ liệu fixture, và các trang đọc-dữ liệu hiển thị trạng thái lỗi
 * thay vì bảng. Chạy test trong `e2e/unavailable-mode.spec.ts`.
 *
 * Lane này là **không cùng server** với lane prototype (`playwright.config.ts`
 * dùng cổng 4311 + `NITRO_PUBLIC_BACKOFFICE_DATA_MODE=prototype`), nên dùng
 * cổng khác để không đâm 충突.
 *
 * Chạy: `npx playwright test -c playwright.unavailable.config.ts`
 */

const PORT = Number(process.env.BACKOFFICE_E2E_PORT ?? 4312);
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/unavailable-mode.spec.ts'],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Một dev server dùng chung cho cả suite — ghim 2 worker như lane prototype.
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npx nuxt dev --port ${String(PORT)} --host 127.0.0.1`,
    url: `${BASE_URL}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NITRO_PUBLIC_BACKOFFICE_DATA_MODE: 'disabled',
    },
  },
});
