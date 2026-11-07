import { expect, test } from '@playwright/test';

import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Navigation — main nav của `/en` phải dẫn tới các trang thật 200.
 *
 * Cấu trúc nav KHÔNG được test phát minh lại: `PUBLIC_NAVIGATION` của home
 * (`apps/home/app/layout/lib/public-navigation.ts`) khai ba item cấp top
 * (docs, blog, legal), trong đó docs/legal là mega panel với các link con.
 * Danh sách dưới đây là các link cùng nguồn dữ liệu đó — thêm/bớt item ở
 * registry là test này đỏ, đúng nghĩa "nav deploy không còn khớp registry".
 */

/** Nav href cấp top cho locale EN — `triggerPath` của từng item trong `PUBLIC_NAVIGATION`. */
const TOP_LEVEL_NAV_HREFS = ['/en/docs', '/en/blog', '/en/legal'] as const;

/** Link con của mega panel docs — `DOCS_SECTION_GROUPS` trong `public-navigation.ts`. */
const DOCS_PANEL_LINKS = [
  '/en/docs/getting-started',
  '/en/docs/getting-started/installation',
  '/en/docs/getting-started/first-steps',
  '/en/docs/concepts',
  '/en/docs/concepts/public-web',
  '/en/docs/concepts/content-and-locales',
  '/en/docs/guides',
  '/en/docs/guides/building-a-public-page',
  '/en/docs/guides/local-development',
] as const;

test('navigation: every top-level nav href resolves to a 200 HTML page', async () => {
  const origin = resolveStackOrigin();
  for (const href of TOP_LEVEL_NAV_HREFS) {
    const response = await stackGet(`${origin}${href}`, { Accept: 'text/html' });
    expect(response.status, `${href} should return 200`).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  }
});

test('navigation: docs mega panel links resolve to 200 pages', async () => {
  const origin = resolveStackOrigin();
  for (const href of DOCS_PANEL_LINKS) {
    const response = await stackGet(`${origin}${href}`, { Accept: 'text/html' });
    expect(response.status, `${href} should return 200`).toBe(200);
  }
});

test('navigation: navigating from /en via the rendered nav lands on a 200 docs page', async ({
  page,
}) => {
  // Vế browser: link phải tồn tại TRONG DOM render của `/en` (không chỉ tồn
  // tại trong registry) và điều hướng thật phải tới trang docs sống.
  await page.goto('/en');

  // Mega panel của docs: trigger là link thật `/en/docs` nhưng click đầu tiên
  // mở disclosure panel (aria-expanded), không navigate ngay. Dùng link con đầu
  // tiên trong panel (`Getting started` → `/en/docs/getting-started`) để kiểm
  // đường điều hướng thật của nav render. Đây là cách duy nhất test được "nav
  // đã render và dẫn tới trang sống" mà không phụ thuộc timing hover.
  const docsTrigger = page.getByRole('link', { name: 'Docs', exact: true }).first();
  await expect(docsTrigger).toBeVisible();
  await docsTrigger.click();

  const gettingStartedLink = page.getByRole('link', { name: 'Getting started' }).first();
  await expect(gettingStartedLink).toBeVisible();
  await gettingStartedLink.click();
  await page.waitForURL('**/en/docs/getting-started');

  const response = await page.goto('/en/docs/getting-started');
  expect(response?.status()).toBe(200);
});
