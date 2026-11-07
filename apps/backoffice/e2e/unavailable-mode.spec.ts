import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * §4 (lane unavailable) — khi `NITRO_PUBLIC_BACKOFFICE_DATA_MODE` là `'disabled'`,
 * backoffice vào trạng thái fail-closed: không banner dữ liệu mẫu, không bảng
 * dữ liệu, và các trang đọc-dữ liệu hiển thị trạng thái lỗi thay vì dữ liệu.
 *
 * Lane này chạy server riêng (`playwright.unavailable.config.ts`, cổng 4312,
 * `NITRO_PUBLIC_BACKOFFICE_DATA_MODE=disabled`) — không chia server với lane
 * prototype (cổng 4311, `prototype`).
 */

const UNAVAILABLE_ROUTES = [
  { path: '/', title: 'Overview' },
  { path: '/staff', title: 'Staff' },
  { path: '/roles', title: 'Roles' },
  { path: '/permissions', title: 'Permissions' },
] as const;

/**
 * Tín hiệu "trang đã render xong" cho lane unavailable.
 *
 * Overview không đọc dữ liệu qua adapter → render ngay, dùng `backoffice-page-title`.
 * Ba trang còn lại dùng adapter → adapter fail-closed reject → `useAsyncState`
 * vào trạng thái error → render `backoffice-error`.
 */
const READY_TEST_IDS: Readonly<Record<string, string>> = {
  '/': 'backoffice-page-title',
  '/staff': 'backoffice-error',
  '/roles': 'backoffice-error',
  '/permissions': 'backoffice-error',
};

/** Chờ route hiện tại render xong phần dữ liệu mà test cần. */
async function waitForRouteReady(page: Page, path: string): Promise<void> {
  const testId = READY_TEST_IDS[path];

  if (testId === undefined) {
    throw new Error(`Không có tín hiệu ready cho route "${path}".`);
  }

  await page.getByTestId(testId).waitFor({ state: 'visible' });
}

for (const route of UNAVAILABLE_ROUTES) {
  test(`loads ${route.path} directly by URL and renders its own content`, async ({ page }) => {
    const response = await page.goto(route.path);

    expect(response?.status()).toBe(200);
    await waitForRouteReady(page, route.path);
    await expect(page.getByTestId('backoffice-page-title')).toHaveText(route.title);
    await expect(page.getByTestId('backoffice-page-title')).toHaveCount(1);
  });
}

test('shows no sample-data notice in unavailable mode on any route', async ({ page }) => {
  for (const route of UNAVAILABLE_ROUTES) {
    await page.goto(route.path);
    await waitForRouteReady(page, route.path);

    // Không banner "dữ liệu mẫu" vì adapter thật không phải preview.
    await expect(page.getByTestId('backoffice-sample-notice')).toHaveCount(0);
  }
});

test('staff/roles/permissions show error state instead of data table', async ({ page }) => {
  for (const path of ['/staff', '/roles', '/permissions']) {
    await page.goto(path);
    await waitForRouteReady(page, path);

    // Adapter fail-closed: mọi lần đọc bị reject → `useAsyncState` vào error.
    await expect(page.getByTestId('backoffice-error')).toHaveCount(1);
    await expect(page.getByTestId('backoffice-error')).toBeVisible();

    // Không có bảng dữ liệu render kèm theo trạng thái lỗi.
    await expect(page.getByTestId(`${path.slice(1)}-table`)).toHaveCount(0);
  }
});

test('overview shows neither error state nor sample notice', async ({ page }) => {
  await page.goto('/');
  await waitForRouteReady(page, '/');

  await expect(page.getByTestId('backoffice-error')).toHaveCount(0);
  await expect(page.getByTestId('backoffice-sample-notice')).toHaveCount(0);
});
