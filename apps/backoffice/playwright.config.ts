import { defineConfig, devices } from '@playwright/test';

/**
 * Cấu hình Playwright cho bộ test browser của `apps/backoffice`.
 *
 * ⚠️ **Vì sao webServer là `nuxt dev`** chứ không phải `nx serve`:
 *
 * - `nx serve` của project này chỉ là `nuxt dev` (xem target `serve` trong
 *   `package.json`), nên chạy thẳng `nuxt dev` không bỏ qua cấu hình nào của app —
 *   chỉ ghim thêm `--port`/`--host` để test không phụ thuộc cổng `4201` mà người
 *   dùng có thể đang chiếm.
 * - `npx nuxt dev` là **lệnh thường**, không phải lệnh `nx`, nên plugin
 *   `@nx/playwright` không dựng chain `e2e--wait-for-webserver`; Playwright tự
 *   quản vòng đời server (khởi động trước suite, kill sau suite).
 * - `nuxt dev` không cần `nuxt build`: build production của app tải font từ
 *   `fonts.gstatic.com`, tức là cần mạng ngoài — thứ mà bộ test này không được
 *   phép phụ thuộc (không kiểm được gì thêm về hành vi UI, chỉ thêm một cách đỏ).
 *
 * ⚠️ **`reuseExistingServer` chỉ bật ngoài CI.** Trên CI phải là `false` để một
 * process lạ đang chiếm cổng làm job đỏ ngay, thay vì im lặng chạy test trên một
 * server không phải bản build của commit này.
 *
 * ⚠️ **`retries: 0` kể cả trên CI.** Retry biến một flake thật thành một lần xanh
 * và không ai đọc lại log để thấy nó; mọi assertion ở đây dùng web-first locator
 * của Playwright (tự chờ), nên chỗ nào còn flake thì đó là bug cần sửa, không phải
 * bug cần che.
 *
 * Chạy: `npx nx e2e @ecoma-io/backoffice`.
 */

/**
 * Cổng của dev server. Mặc định lệch khỏi `4201` (cổng `devServer` của app) để
 * suite không đụng vào dev server mà người dùng đang mở; đổi được bằng
 * `BACKOFFICE_E2E_PORT` khi cổng mặc định cũng bị chiếm.
 */
const PORT = Number(process.env.BACKOFFICE_E2E_PORT ?? 4311);

const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: './e2e',
  // Warm-up một lần cho cả suite: dev server biên dịch route theo lượt truy cập
  // đầu tiên, nên nếu để test tự "trả giá" cho lần compile đó thì triệu chứng là
  // một test timeout — đúng thứ khó đọc nhất, và nó không nói gì về hành vi UI.
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // ⚠️ Ghim số worker, **không** để mặc định của Playwright (`cpus/2`). Trần thật
  // của suite này không phải CPU mà là **một** dev server dùng chung: nó SSR trên
  // một luồng và JIT-compile module theo lượt truy cập đầu tiên. Đo được trên máy
  // 16 nhân: để mặc định (16 worker) thì mỗi test kéo dài 25-60s và 3 test hết giờ
  // 60s ở trạng thái "Loading…" — không phải lỗi app mà là đói server; còn 2 worker
  // thì 40 test xanh trong 1.2 phút, mỗi test 2-4s. Ghim cùng một số ở local và CI
  // để thứ được kiểm ở đây đúng là thứ chạy trên CI.
  workers: 2,
  // Reporter `github` ghi annotation ngay trên PR (đọc được lỗi mà không phải tải
  // artifact); `html` sinh `playwright-report/` để job CI upload kèm trace/screenshot
  // khi đỏ. `open: 'never'` vì không có trình duyệt nào để mở trên runner.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
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
      // Viewport desktop: sidebar của shell chỉ render nhánh desktop từ `md`
      // (`Sidebar.vue` chia nhánh theo `isMobile`), nên điều hướng qua sidebar chỉ
      // kiểm được ở bề rộng này.
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npx nuxt dev --port ${String(PORT)} --host 127.0.0.1`,
    url: `${BASE_URL}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NITRO_PUBLIC_BACKOFFICE_DATA_MODE: 'prototype',
    },
  },
});
