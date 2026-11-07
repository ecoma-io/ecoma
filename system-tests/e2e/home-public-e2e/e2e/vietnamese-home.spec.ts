import { expect, test } from '@playwright/test';

import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Trang chủ VI — locale-root `/vi`.
 *
 * Locale `vi` là hạng nhất trong registry locale của home
 * (`PUBLIC_LOCALES` — `apps/home/app/i18n`), có nội dung riêng trong
 * `HOME_CONTENT.vi` — không fallback sang EN. Chuỗi assert lấy từ nguồn đó;
 * test fail khi bản dịch biến mất hoặc `/vi` ngừng render locale đúng.
 */

const VI_TITLE = 'Ecoma.io — trang chủ public';
const VI_HEADING = 'Web public, dựng cho đúng';

test('vietnamese home page: /vi renders 200 HTML with the Vietnamese title', async () => {
  const origin = resolveStackOrigin();
  const response = await stackGet(`${origin}/vi`, { Accept: 'text/html' });

  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain('text/html');
  expect(response.body).toContain(`<title>${VI_TITLE}</title>`);
});

test('vietnamese home page: /vi renders the Vietnamese hero heading in the browser', async ({
  page,
}) => {
  await page.goto('/vi');

  await expect(page).toHaveTitle(VI_TITLE);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(VI_HEADING);
});
