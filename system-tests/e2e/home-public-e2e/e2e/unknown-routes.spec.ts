import { expect, test } from '@playwright/test';

import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Unknown routes — hành vi 404 thật của home đã deploy.
 *
 * Hai đường vào 404 riêng biệt của home, đều kết thúc ở error renderer SSR
 * (`error.vue`) chạy trên Worker — route page duy nhất của app là
 * `apps/home/app/pages/[locale]/index.vue`:
 *
 * 1. **Path lạ dưới một locale hợp lệ** (`/en/blog/no-such-post`) → không
 *    khớp route page nào (`[locale]/index.vue` chỉ nhận đúng một segment
 *    sau `/`) → Nuxt render 404 qua `error.vue`.
 * 2. **Locale lạ** (`/fr`, `/xx/...`) → khớp `[locale]` về cấu trúc segment,
 *    nhưng `validate` của route (qua `parseHomeLocaleRoot` của `app/i18n`)
 *    từ chối locale ngoài registry → 404.
 *
 * Test hệ thống kiểm CẢ HAI qua bề mặt public — status lẫn trang lỗi render
 * thật, thứ mà unit test của route không chứng minh được.
 */

test('unknown routes: an unknown path under a locale returns 404', async () => {
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
  // Lỗi 404 của route là non-fatal error → đi qua Nuxt error renderer (`error.vue`
  // + trang 404 dùng chung), KHÔNG phải trang lỗi thô của Nitro. Assert trên
  // heading render thật: đủ để phân biệt hai đường đó qua bề mặt public.
  await page.goto('/en/blog/no-such-post');

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not found');
});
