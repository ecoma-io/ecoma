import { expect, test } from '@playwright/test';

import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Unknown routes — hành vi 404 thật của home đã deploy.
 *
 * Hai cơ chế 404 riêng biệt trong home (đọc `apps/home/server/middleware/
 * prerendered-content-404.ts` và `validate` của route `[locale]`):
 *
 * 1. **Path content lạ** dưới mount `/(en|vi)/(docs|blog|legal)/**` không có
 *    trong manifest prerender → middleware gate 404 NGAY TẠI ĐÂY, không chạy
 *    query content nào — và đây cũng là chốt access control của draft legal.
 * 2. **Locale lạ** (`/fr`, `/xx/...`) → không khớp regex mount, đi tiếp
 *    renderer, `validate` topology của route từ chối → 404.
 *
 * Test hệ thống kiểm CẢ HAI qua bề mặt public — hành vi mà unit test của
 * middleware không chứng minh được (nó chạy trên bundle đã prerender thật).
 */

test('unknown routes: an unknown content path under a locale mount returns 404', async () => {
  const origin = resolveStackOrigin();
  const response = await stackGet(`${origin}/en/blog/no-such-post`, { Accept: 'text/html' });

  expect(response.status).toBe(404);
});

test('unknown routes: an unknown locale root returns 404', async () => {
  const origin = resolveStackOrigin();
  const response = await stackGet(`${origin}/fr`, { Accept: 'text/html' });

  expect(response.status).toBe(404);
});

test('unknown routes: the 404 is the real SSR error page with the not-found heading', async ({
  page,
}) => {
  // Middleware 404 là non-fatal error → đi qua Nuxt error renderer (`error.vue`
  // + trang 404 dùng chung), KHÔNG phải trang lỗi thô của Nitro. Assert trên
  // heading render thật: đủ để phân biệt hai đường đó qua bề mặt public.
  await page.goto('/en/blog/no-such-post');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
});
