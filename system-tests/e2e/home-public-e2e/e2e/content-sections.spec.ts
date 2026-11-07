import { expect, test } from '@playwright/test';

import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Content sections — index page của docs, blog, legal cho cả hai locale.
 *
 * Route thật của home: `apps/home/app/pages/[locale]/docs|blog|legal` (catch
 * -all `[[...slug]]`, index = path không slug). Hai locale EN/VI là hai entry
 * của `PUBLIC_LOCALES` — kiểm cả hai vì URL locale-first là contract của bề
 * mặt public: một locale index gãy là một nửa site gãy.
 */

const SECTION_INDEX_PATHS = [
  '/en/docs',
  '/en/blog',
  '/en/legal',
  '/vi/docs',
  '/vi/blog',
  '/vi/legal',
] as const;

test('content sections: docs, blog and legal index pages return 200 HTML for both locales', async () => {
  const origin = resolveStackOrigin();
  for (const path of SECTION_INDEX_PATHS) {
    const response = await stackGet(`${origin}${path}`, { Accept: 'text/html' });
    expect(response.status, `${path} should return 200`).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  }
});

test('content sections: docs index renders a real content listing in the browser', async ({
  page,
}) => {
  await page.goto('/en/docs');

  // Trang docs index render danh sách section thật (Getting started / Concepts
  // / Guides — cùng nguồn mega panel của nav). Assert trên heading cấp 2 của
  // section đầu: đủ để khẳng định nội dung không phải trang rỗng/404.
  await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
});
