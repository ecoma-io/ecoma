import { expect, test } from '@playwright/test';

import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Trang chủ EN — locale-root `/en`.
 *
 * Chuỗi ổn định được assert lấy từ nguồn sự thật `HOME_CONTENT` của home
 * (`apps/home/app/domain/home-content.ts`): title trang và `<h1>` hero. Suite
 * hệ thống không nhúng lại nội dung — nó khoá hành vi đã deploy vào đúng
 * contract nội dung của app; đổi content của app là test đỏ theo đúng nghĩa.
 */

const EN_TITLE = 'Ecoma.io — public home';
const EN_HEADING = 'Public web, built right';

test('english home page: /en renders 200 HTML with the site title', async () => {
  const origin = resolveStackOrigin();
  const response = await stackGet(`${origin}/en`, { Accept: 'text/html' });

  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain('text/html');
  expect(response.body).toContain(`<title>${EN_TITLE}</title>`);
});

test('english home page: /en renders the hero heading in the browser', async ({ page }) => {
  await page.goto('/en');

  await expect(page).toHaveTitle(EN_TITLE);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(EN_HEADING);
});
