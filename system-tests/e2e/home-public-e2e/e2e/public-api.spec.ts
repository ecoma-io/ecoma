import { expect, test } from '@playwright/test';

import { resolveStackOrigin, stackGet } from './support/local-origin';

/**
 * Public API — hợp đồng `GET /api/greet` của home đã deploy.
 *
 * Contract thật (`apps/home/server/api/greet.ts`): query `name` tuỳ chọn,
 * mặc định `World`; response JSON `{ message: "Hello <name>" }`, status 200.
 * Đây là bề mặt API công khai của home qua Traefik — kiểm qua request thuần
 * (scoped `ca`), không browser cần thiết.
 */

test('public api: GET /api/greet returns the greeting JSON shape', async () => {
  const origin = resolveStackOrigin();
  const response = await stackGet(`${origin}/api/greet`);

  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ message: 'Hello World' });
});

test('public api: GET /api/greet?name=<value> echoes the name', async () => {
  const origin = resolveStackOrigin();
  const response = await stackGet(`${origin}/api/greet?name=HomePublicE2E`);

  expect(response.status).toBe(200);
  expect(JSON.parse(response.body)).toEqual({ message: 'Hello HomePublicE2E' });
});
