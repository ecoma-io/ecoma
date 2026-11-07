import { expect, test } from '@playwright/test';

import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Public routing — hợp đồng `{locale}` root của bề mặt public.
 *
 * Hợp đồng thật của home (`local-smoke.mjs` xác nhận): `/` với
 * `Accept: text/html` 302 → `/en` đúng literal. Đây là hợp đồng routing
 * của hệ thống đang chạy thật (Traefik rule `Host(...)` + middleware locale),
 * không phải assertion unit — đúng thứ chỉ system E2E chứng minh được.
 */

test('public routing: / returns 302 with location /en for an HTML negotiator', async () => {
  const origin = resolveStackOrigin();
  const response = await stackGet(`${origin}/`, {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  });

  expect(response.status).toBe(302);
  expect(response.headers.location).toBe('/en');
});

test('public routing: landing on / in the browser lands on the /en page content', async ({
  page,
}) => {
  // Browser path: navigation thật của một client ngoài — click-like entry vào
  // apex host phải kết thúc ở trang EN với nội dung render thật. Đây là vế
  // "người dùng gõ domain và Enter", khác vế API ở trên chỉ chứng minh header.
  await page.goto('/');

  expect(new URL(page.url()).pathname).toBe('/en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Public web, built right');
});
