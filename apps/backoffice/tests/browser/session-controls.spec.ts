import { expect, test } from '@playwright/test';

import { watchRequests } from './support/prototype';

/**
 * Điều khiển phiên của shell (#182) — nhánh **chưa đăng nhập** trên lane
 * prototype (server dev không có cấu hình OIDC và không có cookie).
 *
 * Phạm vi của lane này: những gì người dùng nhìn thấy ở trạng thái logged-out.
 * Các kịch bản auth thật (S2/S8/S9/S10 — đăng nhập đầy đủ, redirect `/onboarding`,
 * hết hạn, logout) thuộc item 1 của #182 và cần auth stack thật (authn lane),
 * không phải server prototype: chúng không được mô phỏng ở đây (frontend-data-
 * mocking — auth luôn thật, không fixture).
 */

test('the shell shows exactly one login control and no logout control when logged out', async ({
  page,
}) => {
  await page.goto('/');
  // Tín hiệu ready của `/` (`backoffice-sample-notice`) chứng tỏ app đã hydrate —
  // probe phiên chạy ở mount, nút render ngay sau đó.
  await page.getByTestId('backoffice-sample-notice').waitFor({ state: 'visible' });
  await expect(page.getByTestId('backoffice-login')).toBeVisible();

  // Đúng **một** control đăng nhập: hai bản sao (một ở actions slot, một nơi khác)
  // là một bug hiển thị, không phải lỗi ầm im.
  await expect(page.getByTestId('backoffice-login')).toHaveCount(1);
  await expect(page.getByTestId('backoffice-logout')).toHaveCount(0);
});

test('the login control navigates to the BFF kickoff route, not a UI-built authorize URL', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByTestId('backoffice-sample-notice').waitFor({ state: 'visible' });

  // Điều hướng đầy đủ tới `/api/auth/login`: BFF dựng authorize URL. UI không tự
  // ghép URL issuer vào href (ADR-0012) — khẳng định qua URL kết thúc là đủ để bắt
  // một regression gắn nhầm href.
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/api/auth/login'),
    page.getByTestId('backoffice-login').click(),
  ]);
});

test('the logged-out shell only sends the session probe to /api, never a data route', async ({
  page,
}) => {
  const requests = watchRequests(page);

  await page.goto('/');
  await page.getByTestId('backoffice-sample-notice').waitFor({ state: 'visible' });
  await expect(page.getByTestId('backoffice-login')).toBeVisible();

  const apiCalls = requests
    .map((request) => new URL(request.url).pathname)
    .filter((pathname) => pathname.startsWith('/api/'));

  // Probe phiên là request `/api` duy nhất của shell khi chưa đăng nhập: mọi
  // request `/api/staff`… ở đây là prototype gọi nhầm backend (nguồn sự thật thứ
  // hai bên cạnh fixture — đúng thứ readonly-boundary chặn).
  expect(apiCalls).toEqual(['/api/auth/session']);
});
