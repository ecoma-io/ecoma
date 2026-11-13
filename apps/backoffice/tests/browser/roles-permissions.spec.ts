import { expect, test } from '@playwright/test';

import { PROTOTYPE_ROUTES, readTable, waitForRouteReady } from './support/prototype';

/**
 * §3 (roles và permissions) — bảng phải có đúng cột và đúng dữ liệu fixture, nội
 * dung không được rỗng vì lỗi i18n hay lỗi render component, và **identifier phải
 * hiển thị như identifier**, không bị dịch thành nhãn.
 *
 * Giá trị literal, cùng lý do như `staff-directory.spec.ts`.
 */

const ROLE_HEADERS = ['Role', 'Permissions in this role'];

const ROLE_ROWS = [
  [
    'Operator Runs day-to-day delivery and mail operations. ID: operator',
    '4 permissions delivery.redrive, mail.read, mail.send, staff.read',
  ],
  [
    'Support Reads staff and mail records to help customers. ID: support',
    '2 permissions mail.read, staff.read',
  ],
  [
    'Auditor Reads authorization audit records only. ID: auditor',
    '2 permissions audit.read, staff.read',
  ],
];

const PERMISSION_HEADERS = ['Permission ID', 'Resource domain', 'Action'];

const PERMISSION_ROWS = [
  ['delivery.redrive Queue a redrive for a delivery that already ran.', 'delivery', 'redrive'],
  ['mail.read Read transactional mail templates and delivery records.', 'mail', 'read'],
  ['mail.send Send a transactional mail.', 'mail', 'send'],
  ['staff.read Read the staff directory.', 'staff', 'read'],
  ['role.assign Assign a role to a staff member.', 'role', 'assign'],
  ['audit.read Read authorization audit records.', 'audit', 'read'],
];

/**
 * Các mảnh khoá i18n **không bao giờ** được lộ ra thành chữ trên màn hình.
 *
 * Không kiểm bằng regex "cell bắt đầu bằng `staff.`" vì `staff.read` là identifier
 * thật của permission — sẽ báo đỏ nhầm. Ở đây chỉ liệt kê những chuỗi là khoá dịch
 * thật, tức dấu hiệu của một lần render đọc nhầm namespace.
 *
 * Danh sách này **không chỉ khoá trong bảng**: `roles.description`, `pages.roles.` là
 * khoá của tiêu đề/mô tả trang, còn `nav.platform` là nhãn nhóm của sidebar. Vì vậy
 * phép kiểm phải quét cả trang, không chỉ ô của bảng — nếu chỉ quét bảng thì ba mảnh
 * khoá cấp trang này không bao giờ khớp được, tức là mục trong danh sách nằm chết.
 */
const I18N_KEY_FRAGMENTS = [
  'roles.items.',
  'roles.permissionCount',
  'roles.description',
  'permissions.items.',
  'staff.columns.',
  'staff.noRoles',
  'nav.platform',
  'pages.roles.',
  'pages.permissions.',
];

test('renders the role catalog with its permission list and count', async ({ page }) => {
  await page.goto('/roles');
  await waitForRouteReady(page, '/roles');

  const table = await readTable(page, 'roles-table');

  expect(table.headers).toEqual(ROLE_HEADERS);
  expect(table.rows).toEqual(ROLE_ROWS);
});

test('renders the permission catalog with id, domain and action as identifiers', async ({
  page,
}) => {
  await page.goto('/permissions');
  await waitForRouteReady(page, '/permissions');

  const table = await readTable(page, 'permissions-table');

  expect(table.headers).toEqual(PERMISSION_HEADERS);
  expect(table.rows).toEqual(PERMISSION_ROWS);
});

test('keeps role and permission identifiers untranslated', async ({ page }) => {
  await page.goto('/roles');
  await waitForRouteReady(page, '/roles');

  const roles = page.getByTestId('roles-table');

  // Tên catalog đứng trước, identifier thô đứng sau tiền tố "ID: " — không phải một
  // nhãn đã dịch, và cũng không phải chuỗi rỗng.
  await expect(roles).toContainText('ID: operator');
  await expect(roles).toContainText('delivery.redrive, mail.read, mail.send, staff.read');

  await page.goto('/permissions');
  await waitForRouteReady(page, '/permissions');

  await expect(page.getByTestId('permissions-table')).toContainText('role.assign');
});

test('renders catalog content instead of a loading, empty or error state', async ({ page }) => {
  for (const route of [
    { path: '/roles', testId: 'roles-table' },
    { path: '/permissions', testId: 'permissions-table' },
  ] as const) {
    await page.goto(route.path);
    await waitForRouteReady(page, route.path);

    const rows = (await readTable(page, route.testId)).rows;

    expect(rows.length).toBeGreaterThan(0);

    // Mọi ô phải có nội dung: một ô rỗng là dấu hiệu i18n trả về undefined/''.
    expect(rows.flat().every((cell) => cell.length > 0)).toBe(true);

    // Sau khi render xong thì không còn skeleton, không có empty state, không có lỗi.
    await expect(page.getByTestId('backoffice-loading')).toHaveCount(0);
    await expect(page.getByTestId('backoffice-empty')).toHaveCount(0);
    await expect(page.getByTestId('backoffice-error')).toHaveCount(0);
  }
});

test('never renders a raw i18n key as visible text on any prototype route', async ({ page }) => {
  for (const route of PROTOTYPE_ROUTES) {
    await page.goto(route.path);
    await waitForRouteReady(page, route.path);

    // Quét **toàn trang**: khoá rò ra ở tiêu đề/mô tả trang, ở nhãn sidebar hay trong
    // shell đều là cùng một lỗi, và `I18N_KEY_FRAGMENTS` có mục thuộc cả ba chỗ đó.
    const text = await page.locator('body').innerText();

    // Chống xanh rỗng: trang không render gì thì vòng lặp dưới không chứng minh được gì.
    expect(text.length).toBeGreaterThan(100);

    for (const fragment of I18N_KEY_FRAGMENTS) {
      expect(text).not.toContain(fragment);
    }
  }
});

test('narrows the role catalog by name or identifier', async ({ page }) => {
  await page.goto('/roles');
  await waitForRouteReady(page, '/roles');

  const search = page.getByTestId('roles-search-input');

  await search.fill('operator');
  expect((await readTable(page, 'roles-table')).rows).toEqual([ROLE_ROWS[0]]);

  await search.fill('AUDITOR');
  expect((await readTable(page, 'roles-table')).rows).toEqual([ROLE_ROWS[2]]);

  await search.fill('zzz');
  await expect(page.getByTestId('roles-no-results')).toBeVisible();
  await expect(page.getByTestId('roles-table')).toHaveCount(0);
});

test('narrows the permission catalog by identifier, domain or action', async ({ page }) => {
  await page.goto('/permissions');
  await waitForRouteReady(page, '/permissions');

  const search = page.getByTestId('permissions-search-input');

  await search.fill('mail');
  expect((await readTable(page, 'permissions-table')).rows).toEqual([
    PERMISSION_ROWS[1],
    PERMISSION_ROWS[2],
  ]);

  await search.fill('assign');
  expect((await readTable(page, 'permissions-table')).rows).toEqual([PERMISSION_ROWS[4]]);

  await search.fill('zzz');
  await expect(page.getByTestId('permissions-no-results')).toBeVisible();
  await expect(page.getByTestId('permissions-table')).toHaveCount(0);
});
