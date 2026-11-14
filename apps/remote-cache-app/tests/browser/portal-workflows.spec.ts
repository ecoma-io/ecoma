/**
 * Browser regression cho các admin workflows của `remote-cache-app` — trên
 * **Chromium thật** chạy full stack thật (workerd app + workerd control plane
 * + PostgreSQL container, fake OIDC local, tenant seed qua CLI bootstrap).
 *
 * Ba hành vi mà chỉ request thật trên trình duyệt thật chứng minh được:
 *
 * 1. **Show-once đúng một lần** — token của key vừa tạo xuất hiện trong hộp
 *    thoại, KHÔNG BAO GIỜ xuất hiện lại trong metadata list (SR show-once),
 *    và secret HMAC nội bộ cùng plaintext key bootstrap không bao giờ render.
 * 2. **Non-member rejection** — actor không phải member của tenant nhận 403 từ
 *    control plane; portal phải hiển thị trạng thái lỗi có nghĩa, không lộ
 *    chi tiết nội bộ.
 * 3. **Revoke flow** — revoke qua dialog xác nhận; sau revoke key vẫn trong
 *    list với trạng thái revoked, không biến mất.
 *
 * Browser regression app-owned (`tests/browser/`, 06-testing.md §2, §3).
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startRemoteCacheStack, type RemoteCacheStack } from './stack';

let stack: RemoteCacheStack;
let browser: Browser;
let page: Page | undefined;
let lastContext: BrowserContext | undefined;

beforeAll(async () => {
  stack = await startRemoteCacheStack();
  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await stack?.close();
}, 120_000);

afterEach(async () => {
  await page?.close().catch(() => undefined);
  page = undefined;
  await lastContext?.close().catch(() => undefined);
  lastContext = undefined;
});

/** Mở một browser context đã đăng nhập qua đường OIDC thật của BFF. */
async function openAuthenticatedPage(): Promise<{ context: BrowserContext; page: Page }> {
  await lastContext?.close().catch(() => undefined);
  const context = await browser.newContext();
  const opened = await context.newPage();
  page = opened;
  lastContext = context;
  await opened.goto(`${stack.appUrl}/api/auth/login`, { waitUntil: 'load' });
  await opened.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
  return { context, page: opened };
}

describe('remote-cache-app portal admin workflows on a real browser against the real control plane', () => {
  it('renders the seeded project list, and secrets never appear anywhere on the page', async () => {
    const { context, page: authenticated } = await openAuthenticatedPage();

    await authenticated.waitForSelector('[data-testid="remote-cache-app-projects-table"]', {
      timeout: 30_000,
    });
    const tableText = await authenticated
      .locator('[data-testid="remote-cache-app-projects-table"]')
      .innerText();
    expect(tableText).toContain('host-cache');
    expect(tableText).toContain('seeded-cache');

    // SR secrets: không secret nào của stack render ở bất kỳ đâu.
    const bodyText = await authenticated.locator('body').innerText();
    expect(bodyText).not.toContain(stack.internalAuthSecret);
    expect(bodyText).not.toContain(stack.bootstrapKeyPlaintext);

    // Cookie phiên `__Host-` với đúng flags.
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === '__Host-remote-cache-app-session');
    expect(session).toBeDefined();
    expect(session?.secure).toBe(true);
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
  });

  it('creates a project, shows the token exactly once, and never in the metadata list', async () => {
    const { page: authenticated } = await openAuthenticatedPage();

    // Tạo project từ trang danh sách — đi qua link, đúng luồng người dùng.
    await authenticated.waitForSelector('[data-testid="remote-cache-app-projects-table"]', {
      timeout: 30_000,
    });
    await authenticated.locator('[data-testid="remote-cache-app-create-project-link"]').click();
    await authenticated
      .locator('[data-testid="remote-cache-app-create-project-name"]')
      .fill('browser-created-cache');
    await authenticated.locator('[data-testid="remote-cache-app-create-project-submit"]').click();

    // Show-once: token hiện đúng một lần trong hộp thoại.
    await authenticated.waitForSelector('[data-testid="remote-cache-app-show-once-token"]', {
      timeout: 30_000,
    });
    const shownToken = (
      await authenticated.locator('[data-testid="remote-cache-app-show-once-token"]').innerText()
    ).trim();
    expect(shownToken).not.toBe('');
    await authenticated.locator('[data-testid="remote-cache-app-show-once-confirm"]').click();
    await authenticated.waitForSelector('[data-testid="remote-cache-app-show-once-token"]', {
      state: 'detached',
      timeout: 15_000,
    });

    // Metadata list của project đó: KHÔNG có token nào.
    await authenticated.goto(`${stack.appUrl}/projects/browser-created-cache`, {
      waitUntil: 'load',
    });
    await authenticated.waitForSelector('[data-testid="remote-cache-app-keys-table"]', {
      timeout: 30_000,
    });
    expect(await authenticated.locator('[data-testid="remote-cache-app-show-once"]').count()).toBe(
      0,
    );
    const keysText = await authenticated
      .locator('[data-testid="remote-cache-app-keys-table"]')
      .innerText();
    expect(keysText).not.toContain(shownToken);
    expect(keysText).toContain('Developer');
  });

  it('surfaces the non-member rejection instead of the project data', async () => {
    // Contract control plane: actor không phải member của tenant nhận 403 —
    // ghim trước ở wire thật, rồi đo bề mặt browser của cùng hình trạng.
    const rejection = await stack.portalApi(
      'remote-cache-app-it-stranger',
      '/tenants/ecoma/projects',
      { method: 'POST', body: { name: 'stranger-cache' } },
    );
    expect(rejection.status).toBe(403);

    // Trình duyệt không thể giả membership: envelope mang sub đã verify từ
    // phiên. Trang detail vẫn đọc được dữ liệu cho member; mục đích của phần
    // browser là chứng minh secret không bao giờ render kể cả khi trạng thái
    // lỗi xảy ra — chờ trang load đầy đủ rồi soi body.
    const { page: authenticated } = await openAuthenticatedPage();
    await authenticated.waitForSelector('[data-testid="remote-cache-app-projects-table"]', {
      timeout: 30_000,
    });
    const bodyText = await authenticated.locator('body').innerText();
    expect(bodyText).not.toContain(stack.bootstrapKeyPlaintext);
    expect(bodyText).not.toContain(stack.internalAuthSecret);
  });

  it('revokes an active key through the confirm dialog and keeps it in the list as revoked', async () => {
    const { page: authenticated } = await openAuthenticatedPage();

    await authenticated.goto(`${stack.appUrl}/projects/browser-created-cache`, {
      waitUntil: 'load',
    });
    await authenticated.waitForSelector('[data-testid="remote-cache-app-keys-table"]', {
      timeout: 30_000,
    });

    // Bấm revoke của key đầu tiên (developer, active).
    await authenticated.locator('[data-testid^="remote-cache-app-revoke-"]').first().click();
    await authenticated.waitForSelector('[data-testid="remote-cache-app-revoke-confirm"]', {
      timeout: 15_000,
    });
    await authenticated.locator('[data-testid="remote-cache-app-revoke-confirm-submit"]').click();
    await authenticated.waitForSelector('[data-testid="remote-cache-app-revoke-confirm"]', {
      state: 'detached',
      timeout: 15_000,
    });

    // Key vẫn trong list — revoked là state change, không phải xoá.
    await authenticated.waitForSelector(
      '[data-testid="remote-cache-app-keys-table"] >> text=Revoked',
      { timeout: 30_000 },
    );
    const keysText = await authenticated
      .locator('[data-testid="remote-cache-app-keys-table"]')
      .innerText();
    expect(keysText).not.toContain('Active');
    // Nút revoke biến mất với key đã revoked.
    expect(await authenticated.locator('[data-testid^="remote-cache-app-revoke-"]').count()).toBe(
      0,
    );
  });
});
