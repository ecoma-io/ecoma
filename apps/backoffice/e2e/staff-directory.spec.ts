import { expect, test } from '@playwright/test';

import { readTable, waitForRouteReady } from './support/prototype';

/**
 * §3 (staff directory) — bảng phải hiển thị đúng dữ liệu fixture, search phải hoạt
 * động trên đúng các trường UI thực sự hỗ trợ, filter theo status phải trả đúng
 * hàng, và hai thứ đó phải kết hợp đúng.
 *
 * Bảng kỳ vọng dưới đây là **giá trị literal**, không import từ
 * `app/backoffice-data/prototype-fixture.ts`. Đây là chủ ý: một test tự so bảng
 * render với chính fixture sẽ luôn khớp kể cả khi fixture đổi mà UI quên đổi, còn
 * literal thì buộc mọi thay đổi dữ liệu prototype phải được cập nhật có ý thức.
 */

const HEADERS = ['Staff member', 'Account ID', 'Staff status', 'Assigned roles'];

const ALL_ROWS = [
  ['Linh Trần', 'acct_7PZNH32PY20PD8Y10EF9CQXJ18', 'Active', 'operator'],
  ['Minh Nguyễn', 'acct_4TPCKEP6AW4YNNQJMXEE37E1FS', 'Active', 'support'],
  ['An Lê', 'acct_2PKJGMDSQTG64PY4DMHBX6TNC0', 'Suspended', 'operator, support'],
  ['Quang Phạm', 'acct_6Z7N9NWQ0SCWKK02XYWZPD6WMH', 'Terminated', 'auditor'],
  ['Thu Vũ', 'acct_0DKKG1D0ZQ1KMN3PYT8RQ9W9G4', 'Active', 'No roles assigned'],
];

/** Tên hiển thị của một bảng đã render. */
function displayNames(rows: readonly (readonly string[])[]): string[] {
  return rows.map((row) => row[0]);
}

test('lists every member of the prototype staff fixture with all four columns', async ({
  page,
}) => {
  await page.goto('/staff');
  await waitForRouteReady(page, '/staff');

  const table = await readTable(page, 'staff-table');

  expect(table.headers).toEqual(HEADERS);
  expect(table.rows).toEqual(ALL_ROWS);
});

test('shows the role assignment per member, including the empty case', async ({ page }) => {
  await page.goto('/staff');
  await waitForRouteReady(page, '/staff');

  const { rows } = await readTable(page, 'staff-table');
  const roles = rows.map((row) => row[3]);

  // `staff.noRoles` — thành viên không có role nào không được render ô trống.
  expect(roles).toEqual([
    'operator',
    'support',
    'operator, support',
    'auditor',
    'No roles assigned',
  ]);
});

test('searches by display name regardless of case, including diacritics', async ({ page }) => {
  await page.goto('/staff');
  await waitForRouteReady(page, '/staff');

  const search = page.getByTestId('staff-search-input');
  const cases = [
    { term: 'linh', name: 'Linh Trần' },
    { term: 'LINH', name: 'Linh Trần' },
    { term: 'lê', name: 'An Lê' },
  ] as const;

  for (const step of cases) {
    await search.fill(step.term);

    const { rows } = await readTable(page, 'staff-table');

    expect(displayNames(rows)).toEqual([step.name]);
    await expect(page.getByTestId('staff-no-results')).toHaveCount(0);
  }
});

test('searches by account ID', async ({ page }) => {
  await page.goto('/staff');
  await waitForRouteReady(page, '/staff');

  const search = page.getByTestId('staff-search-input');

  await search.fill('acct_4TPC');
  expect(displayNames((await readTable(page, 'staff-table')).rows)).toEqual(['Minh Nguyễn']);

  await search.fill('acct_0DKK');
  expect(displayNames((await readTable(page, 'staff-table')).rows)).toEqual(['Thu Vũ']);
});

test('filters the directory by staff status', async ({ page }) => {
  await page.goto('/staff');
  await waitForRouteReady(page, '/staff');

  const filter = page.getByTestId('staff-filter-select');
  const expected = [
    { value: 'active', label: 'Active', names: ['Linh Trần', 'Minh Nguyễn', 'Thu Vũ'] },
    { value: 'suspended', label: 'Suspended', names: ['An Lê'] },
    { value: 'terminated', label: 'Terminated', names: ['Quang Phạm'] },
    { value: 'all', label: null, names: displayNames(ALL_ROWS) },
  ] as const;

  for (const step of expected) {
    await filter.selectOption(step.value);

    const { rows } = await readTable(page, 'staff-table');

    expect(displayNames(rows)).toEqual([...step.names]);

    // Cột status cũng phải khớp filter, không chỉ số hàng: một bảng lọc sai cột vẫn
    // có thể trả đúng *số lượng* hàng.
    if (step.label !== null) {
      expect(rows.every((row) => row[2] === step.label)).toBe(true);
    }
  }
});

test('combines the search term with the status filter instead of overriding one with the other', async ({
  page,
}) => {
  await page.goto('/staff');
  await waitForRouteReady(page, '/staff');

  const search = page.getByTestId('staff-search-input');
  const filter = page.getByTestId('staff-filter-select');

  // "an" khớp hai thành viên ở hai status khác nhau: "An Lê" (suspended, khớp theo
  // tên) và "Quang Phạm" (terminated, khớp theo chuỗi con "quANg" trong tên). Vì vậy
  // nếu search ghi đè filter — hoặc hai điều kiện bị OR với nhau — thì các ca dưới
  // sẽ trả về hàng của status khác.
  const cases = [
    { status: 'suspended', term: 'an', names: ['An Lê'] },
    { status: 'terminated', term: 'an', names: ['Quang Phạm'] },
    { status: 'active', term: 'an', names: [] },
    { status: 'active', term: 'linh', names: ['Linh Trần'] },
    { status: 'suspended', term: 'linh', names: [] },
  ] as const;

  for (const step of cases) {
    await filter.selectOption(step.status);
    await search.fill(step.term);

    const { rows } = await readTable(page, 'staff-table');

    expect(displayNames(rows)).toEqual([...step.names]);
  }

  // Ca cuối cùng không khớp ai: filter vẫn phải giữ giá trị đang chọn chứ không bị
  // reset về "all", và thông báo không-khớp phải theo đúng filter đó.
  await expect(filter).toHaveValue('suspended');
  await expect(page.getByTestId('staff-no-results')).toBeVisible();
});

test('shows a no-match message instead of a broken or empty directory', async ({ page }) => {
  await page.goto('/staff');
  await waitForRouteReady(page, '/staff');

  await page.getByTestId('staff-search-input').fill('zzz');

  await expect(page.getByTestId('staff-no-results')).toBeVisible();
  await expect(page.getByTestId('staff-no-results')).toHaveText(
    'No staff member matches this search.',
  );

  // Không có kết quả thì bảng phải biến mất, nhưng KHÔNG được giả thành lỗi hệ thống
  // và cũng không được giả thành "adapter không có ai".
  await expect(page.getByTestId('staff-table')).toHaveCount(0);
  await expect(page.getByTestId('backoffice-empty')).toHaveCount(0);
  await expect(page.getByTestId('backoffice-error')).toHaveCount(0);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);

  // Banner sample-data vẫn còn, tức người dùng vẫn biết đây là prototype.
  await expect(page.getByTestId('backoffice-sample-notice')).toBeVisible();
});
