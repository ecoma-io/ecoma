import { expect, test } from '@playwright/test';

import {
  PROTOTYPE_ROUTES,
  activeSidebarHrefs,
  internalHrefs,
  sidebarLink,
  waitForRouteReady,
  watchRuntimeFailures,
} from './support/prototype';

/**
 * §3 (routes/navigation) — bốn route prototype phải mở được **trực tiếp bằng URL**,
 * không chỉ qua sidebar; điều hướng trong app phải khớp route và trạng thái active;
 * và không link nội bộ nào trỏ vào chỗ chết.
 *
 * ⚠️ Mọi test ở file này đều dùng `page.goto`, tức một lượt load **mới** — cố ý.
 * Một route chỉ hoạt động khi bấm từ sidebar (thiếu SSR, lazy chunk hỏng, điều kiện
 * `onMounted` lệch) sẽ vẫn xanh nếu test điều hướng trong app, nên phải có cả hai vế.
 */

const ALL_PATHS = PROTOTYPE_ROUTES.map((route) => route.path).toSorted();

for (const route of PROTOTYPE_ROUTES) {
  test(`loads ${route.path} directly by URL and renders its own content`, async ({ page }) => {
    const response = await page.goto(route.path);

    expect(response?.status()).toBe(200);
    await waitForRouteReady(page, route.path);
    await expect(page.getByTestId('backoffice-page-title')).toHaveText(route.title);
    await expect(page.getByTestId('backoffice-page-title')).toHaveCount(1);
  });

  test(`marks ${route.path} as the only active sidebar item`, async ({ page }) => {
    await page.goto(route.path);
    await waitForRouteReady(page, route.path);

    await expect(sidebarLink(page, route.title)).toHaveAttribute('data-active', 'true');
    expect(await activeSidebarHrefs(page)).toEqual([route.path]);
  });

  test(`reloads ${route.path} without a runtime error`, async ({ page }) => {
    const failures = watchRuntimeFailures(page);

    await page.goto(route.path);
    await waitForRouteReady(page, route.path);
    await page.reload();
    await waitForRouteReady(page, route.path);

    await expect(page.getByTestId('backoffice-page-title')).toHaveText(route.title);
    expect(failures.consoleErrors).toEqual([]);
    expect(failures.pageErrors).toEqual([]);
  });

  test(`points every internal link on ${route.path} at a live prototype route`, async ({
    page,
    request,
  }) => {
    await page.goto(route.path);
    await waitForRouteReady(page, route.path);

    const hrefs = await internalHrefs(page);

    // Vế 1: tập link nội bộ đúng bằng bốn route prototype.
    expect(hrefs).toEqual(ALL_PATHS);

    // Vế 2: mỗi link trả 200 thật, không chỉ suy ra từ việc route có trong danh sách.
    for (const href of hrefs) {
      const response = await request.get(href);

      expect(response.status()).toBe(200);
    }
  });
}

test('shows the overview with a working link to each prototype area', async ({ page }) => {
  await page.goto('/');
  await waitForRouteReady(page, '/');

  const areas = page.getByRole('navigation', { name: 'Overview' });

  await expect(areas.getByTestId('overview-area-staff')).toHaveAttribute('href', '/staff');
  await expect(areas.getByTestId('overview-area-roles')).toHaveAttribute('href', '/roles');
  await expect(areas.getByTestId('overview-area-permissions')).toHaveAttribute(
    'href',
    '/permissions',
  );
});

test('navigates between prototype routes from the sidebar and follows the active state', async ({
  page,
}) => {
  await page.goto('/');
  await waitForRouteReady(page, '/');

  for (const route of PROTOTYPE_ROUTES) {
    const failures = watchRuntimeFailures(page);

    await sidebarLink(page, route.title).click();
    // Chờ theo `pathname` thay vì glob `**/roles`: glob không phân biệt được `/` với
    // mọi URL kết thúc bằng `/`.
    await page.waitForURL((url) => url.pathname === route.path);
    await waitForRouteReady(page, route.path);

    await expect(page.getByTestId('backoffice-page-title')).toHaveText(route.title);
    await expect(sidebarLink(page, route.title)).toHaveAttribute('data-active', 'true');
    expect(await activeSidebarHrefs(page)).toEqual([route.path]);
    expect(failures.consoleErrors).toEqual([]);
    expect(failures.pageErrors).toEqual([]);
  }

  // Bấm lại đúng route đang mở không được tạo lỗi runtime.
  await sidebarLink(page, 'Overview').click();
  await waitForRouteReady(page, '/');
  await expect(page.getByTestId('backoffice-page-title')).toHaveText('Overview');
});

/**
 * Đối chứng cho test "every internal link ... at a live prototype route".
 *
 * Không có test này, vế 2 ở trên có thể xanh vì lý do sai: nếu môi trường test nuốt
 * mọi URL lạ và trả 200, một link chết sẽ không bao giờ bị bắt. Test này chứng minh
 * một route ngoài prototype **thật sự** trả 404.
 */
test('answers 404 for a route outside the prototype surface', async ({ page }) => {
  const response = await page.goto('/definitely-not-a-prototype-route');

  expect(response?.status()).toBe(404);
  await expect(page.locator('body')).toContainText('Page not found');
});
