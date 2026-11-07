import { expect, test } from '@playwright/test';

import {
  PROTOTYPE_ROUTES,
  mainRegion,
  mainSection,
  sidebarLink,
  waitForRouteReady,
  watchRequests,
  watchRuntimeFailures,
} from './support/prototype';

/**
 * §3 (boundary và read-only state) — người dùng phải luôn nhận ra đây là dữ liệu
 * mẫu, và **không** thao tác nào được tạo cảm giác đã ghi được vào backend.
 *
 * ⚠️ Phạm vi: chỉ locale mặc định. Bộ test sâu về chuyển locale đã có ở D1, ở đây
 * chỉ cần ngôn ngữ mặc định render được (điều mà `routes-navigation.spec.ts` đã
 * ghìm bằng tiêu đề tiếng Anh).
 */

/**
 * Điều khiển **chỉ-đọc** mà mỗi trang được phép có, theo `role` + accessible name.
 *
 * Đây là danh sách đóng: test đối chiếu cả tổng số điều khiển tương tác trong phần
 * nội dung, nên thêm một nút hay một form mới sẽ đỏ ngay, chứ không lặng lẽ lọt qua.
 */
const READ_ONLY_CONTROLS = [
  {
    path: '/',
    controls: [
      { role: 'link', name: 'Staff' },
      { role: 'link', name: 'Roles' },
      { role: 'link', name: 'Permissions' },
    ],
  },
  {
    path: '/staff',
    controls: [
      { role: 'searchbox', name: 'Search staff' },
      { role: 'combobox', name: 'Filter by staff status' },
    ],
  },
  { path: '/roles', controls: [{ role: 'searchbox', name: 'Search roles' }] },
  { path: '/permissions', controls: [{ role: 'searchbox', name: 'Search permissions' }] },
] as const;

/**
 * Điều khiển tương tác — **kể cả** ARIA role gắn trên element không native.
 *
 * `[role="…"]` là bắt buộc: `<span role="button">Assign role</span>` là affordance ghi
 * thật nhưng không khớp `a, button, input, select, textarea`. CSS selector list khử
 * trùng lặp element, nên element khớp nhiều nhánh vẫn chỉ bị đếm một lần.
 */
const INTERACTIVE_CONTROLS =
  'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="tab"], [role="radio"], [role="textbox"], [role="searchbox"], [role="combobox"]';

/**
 * Tên truy cập được của một điều khiển **ghi**.
 *
 * Danh sách đóng theo *nghĩa*, không theo thẻ: nút "Save" đặt ở header của shell cũng
 * là affordance ghi, nên phép kiểm phải quét cả vùng `main` chứ không riêng `<section>`.
 */
const WRITE_AFFORDANCE_NAME =
  /save|submit|assign|create|delete|remove|edit|update|invite|revoke|publish|apply|reset|upload|\badd\b/iu;

/**
 * Path `/api/**` mà prototype được phép gọi — allow-list **tường minh**.
 *
 * ⚠️ Mặc định **rỗng**, và đó là chủ ý: prototype không có backend, nên không được
 * gọi route `/api/**` nào — kể cả GET same-origin. Một `fetch('/api/staff')` là
 * nguồn sự thật thứ hai bên cạnh fixture, trong khi banner vẫn ghi "never talks to
 * a backend": đúng cái cửa sổ "hai nguồn sự thật" mà bộ test này phải chặn.
 *
 * So khớp là **pathname chính xác** (không phải prefix). Nếu sau này prototype cần
 * gọi route thật, khai path cụ thể ở đây — tường minh, kèm lý do — chứ không âm
 * thầm nới phép kiểm bên dưới.
 */
const ALLOWED_API_PATHS: readonly string[] = [];

/**
 * Chữ tự nhận một thao tác ghi **đã hoàn tất**.
 *
 * Đây là heuristic theo từ khoá, không phải bằng chứng "không có thao tác ghi" — bảo
 * đảm thật nằm ở test request-level bên dưới. Danh sách chỉ gồm những từ **đo được là
 * không xuất hiện** trong nội dung thật: `persisted` (banner sample-data), `assigned`
 * (cột "Assigned roles" ở `/staff`) và `assign` (mô tả permission `role.assign`) là từ
 * vựng hợp lệ của prototype nên bị loại; `\b` để "delivery" không khớp "live".
 */
const WRITE_COMPLETION_TEXT =
  /\b(?:saved|success|successfully|created|deleted|updated|applied|confirmed|completed|done|live)\b/iu;

test('shows the sample-data notice on every prototype route', async ({ page }) => {
  for (const route of PROTOTYPE_ROUTES) {
    await page.goto(route.path);
    await waitForRouteReady(page, route.path);

    const notice = mainSection(page).getByTestId('backoffice-sample-notice');

    await expect(notice).toHaveCount(1);
    await expect(notice).toBeVisible();
    // Hai mệnh đề cốt lõi: đây là prototype, và nó không nói chuyện với backend nào.
    await expect(notice).toContainText('UI prototype');
    await expect(notice).toContainText('never talks to a backend');
  }
});

for (const { path, controls } of READ_ONLY_CONTROLS) {
  test(`exposes no write control on ${path}`, async ({ page }) => {
    await page.goto(path);
    await waitForRouteReady(page, path);

    const content = mainSection(page);
    const main = mainRegion(page);

    // Vế 1: tổng số điều khiển tương tác trong nội dung đúng bằng danh sách cho phép —
    // vế này bắt một nút "Save" hay một form thêm mới mà vế dưới (kiểm từng control)
    // không thấy. Đếm cả ARIA role nên element không native cũng không lọt.
    await expect(content.locator(INTERACTIVE_CONTROLS).first()).toBeVisible();
    expect(await content.locator(INTERACTIVE_CONTROLS).count()).toBe(controls.length);

    // Vế 2: trong **toàn vùng main** (gồm header/breadcrumb của shell) không có form,
    // không có vùng soạn thảo, không có input kiểu submit/button.
    await expect(main.locator('form, [contenteditable="true"]')).toHaveCount(0);
    await expect(main.locator('input[type="submit"], input[type="button"]')).toHaveCount(0);

    // Vế 3: không điều khiển nào trong vùng main mang tên của một thao tác ghi. Vế này
    // phủ chrome của shell, nơi vế 1 cố ý không với tới.
    const names = await main
      .locator(INTERACTIVE_CONTROLS)
      .evaluateAll((elements) =>
        elements.map((element) =>
          (element.getAttribute('aria-label') ?? element.textContent ?? '')
            .trim()
            .replaceAll(/\s+/gu, ' '),
        ),
      );

    expect(names.filter((name) => WRITE_AFFORDANCE_NAME.test(name))).toEqual([]);

    for (const control of controls) {
      await expect(
        content.getByRole(control.role, { name: control.name, exact: true }),
      ).toHaveCount(1);
    }
  });
}

test('never claims a write succeeded', async ({ page }) => {
  const main = mainRegion(page);

  for (const route of PROTOTYPE_ROUTES) {
    await page.goto(route.path);
    await waitForRouteReady(page, route.path);

    // Không có hộp thoại, không toast, không alert: không có kênh nào để báo "đã lưu".
    await expect(page.locator('[role="alert"], [role="dialog"], [data-sonner-toast]')).toHaveCount(
      0,
    );

    // Không có chữ nào tự nhận đã ghi, ở cả nội dung lẫn chrome của shell.
    await expect(main.getByText(WRITE_COMPLETION_TEXT)).toHaveCount(0);

    await expect(page.getByTestId('backoffice-error')).toHaveCount(0);
  }
});

test('sends no mutating request and never leaves the app origin', async ({ page, baseURL }) => {
  const requests = watchRequests(page);
  const failures = watchRuntimeFailures(page);
  const origin = new URL(baseURL ?? '').origin;

  // Đi qua toàn bộ route, rồi **thao tác** mọi điều khiển chỉ-đọc đang có: nếu adapter
  // prototype lén gọi backend thì chính các thao tác này mới là chỗ lộ ra.
  for (const route of PROTOTYPE_ROUTES) {
    await page.goto(route.path);
    await waitForRouteReady(page, route.path);
  }

  await page.goto('/staff');
  await waitForRouteReady(page, '/staff');
  await page.getByTestId('staff-search-input').fill('linh');
  await page.getByTestId('staff-filter-select').selectOption('active');

  await page.goto('/roles');
  await waitForRouteReady(page, '/roles');
  await page.getByTestId('roles-search-input').fill('operator');

  await page.goto('/permissions');
  await waitForRouteReady(page, '/permissions');
  await page.getByTestId('permissions-search-input').fill('mail');

  for (const route of PROTOTYPE_ROUTES) {
    await sidebarLink(page, route.title).click();
    await page.waitForURL((url) => url.pathname === route.path);
    await waitForRouteReady(page, route.path);
  }

  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)),
  ).toEqual([]);
  expect(requests.filter((request) => new URL(request.url).origin !== origin)).toEqual([]);

  // Vế cấm **đọc** từ backend: mọi request tới `/api/**` đều bị chặn, kể cả GET
  // same-origin. Lý do: prototype không có backend, nên bất kỳ request `/api/**`
  // nào cũng là một nguồn sự thật thứ hai bên cạnh fixture — trong khi banner
  // vẫn ghi "never talks to a backend". Bộ test trước đây chỉ cấm method ghi và
  // cross-origin, nên `fetch('/api/staff')` lọt qua mà vẫn xanh.
  //
  // Allow-list khai ở `ALLOWED_API_PATHS` (mặc định rỗng) là **đường nới duy
  // nhất**, và nó phải tường minh: thêm path ở đó kèm lý do, không sửa phép kiểm
  // này.
  expect(
    requests
      .map((request) => new URL(request.url).pathname)
      .filter((pathname) => pathname.startsWith('/api/'))
      .filter((pathname) => !ALLOWED_API_PATHS.includes(pathname)),
  ).toEqual([]);

  // Vế console/page error đặt **sau** vế trên: một request `/api/**` bị server từ
  // chối (503 vì chưa có authn layer) cũng làm Chromium ghi console error, và
  // nếu vế này đứng trước thì lỗi đỏ sẽ chỉ nói về console chứ không nói về
  // ranh giới dữ liệu — tức là không chỉ ra đúng điều cần sửa.
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
});
