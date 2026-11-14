/**
 * Browser regression cho các read pages của `pact-broker-app` — `/pacts`,
 * `/environments`, `/tokens` — trên **Chromium thật** chạy full stack thật
 * (workerd app + workerd API + PostgreSQL container, fake OIDC local, dữ liệu
 * seed qua public surface của API).
 *
 * Vì sao suite này tồn tại (issue #181): lỗi gốc của trang `/pacts` sống sót
 * qua mọi unit stub vì stub mang đúng shape mà trang ĐÃ giả định — contract
 * thật của API là matrix HAL ở top-level với `consumer.version.number`, và
 * chỉ một request thật trên trình duyệt thật mới chứng minh được trang render
 * dữ liệu thật. Từ #206, trang còn phải đi qua **phiên đăng nhập thật**: mọi
 * `/api/broker/*` trả 401 khi không có phiên, nên browser regression phải
 * đi trọn luồng OIDC (login → authorize → callback) chứ không seed cookie tay.
 *
 * Browser regression app-owned (`tests/browser/`), không phải system E2E
 * (06-testing.md §2, §3 — runner không quyết định category).
 *
 * ⚠️ Chromium lấy từ `@playwright/test` (re-export `playwright-core`) — đã là
 * devDependency của ROOT workspace, project này không thêm dep nào. Binary
 * chromium phải có sẵn trong cache Playwright của runner (`PLAYWRIGHT_BROWSERS_PATH`
 * mặc định); thiếu binary là lỗi lúc launch — đỏ, không skip.
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startBrokerStack, type BrokerStack } from '../integrations/broker-stack';

let stack: BrokerStack;
let browser: Browser;
/** Trang đang mở của test hiện tại — afterEach đóng bất kể test đỏ hay xanh. */
let page: Page | undefined;
/** Context gần nhất mà `openAuthenticatedPage` tạo — afterEach đóng cùng `page`. */
let lastContext: BrowserContext | undefined;

beforeAll(async () => {
  // Stack riêng của suite này: dữ liệu seed là dữ liệu assert, không chia sẻ
  // với suite nào khác (mỗi suite tự sở hữu setup của mình — 06-testing.md §1.3).
  stack = await startBrokerStack();
  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await stack?.close();
}, 120_000);

afterEach(async () => {
  // Đóng tab trước khi trình duyệt bị đóng ở afterAll — test chết giữa chừng
  // (timeout, mất kết nối) không được để rò rỉ tab trong cùng session Chromium.
  await page?.close().catch(() => undefined);
  page = undefined;
  await lastContext?.close().catch(() => undefined);
  lastContext = undefined;
});

/**
 * Mở một browser context **đã đăng nhập**: đi trọn luồng OIDC thật của BFF
 * (`/api/auth/login` → authorize của `auth` → callback → set cookie phiên).
 *
 * Context và page được ghi vào module scope (`page`/`lastContext`) để
 * `afterEach` đóng cả hai bất kể test đỏ hay xanh (review #254: test "logout
 * và login lại" mở context thứ hai — không đóng thì rò context trong cùng
 * session Chromium). Helper không trả context qua module scope cho test body:
 * return value là nguồn dữ liệu của test.
 *
 * ⚠️ Context riêng cho mỗi test: cookie phiên là trạng thái của người dùng,
 * nên test này không được kế thừa phiên của test trước (khác với app thật,
 * nơi người dùng đăng nhập một lần cho cả phiên làm việc).
 */
async function openAuthenticatedPage(): Promise<{ context: BrowserContext; page: Page }> {
  // Gọi lần thứ hai trong cùng test (logout → login lại) thì đóng context cũ:
  // ghi đè `lastContext` mà không đóng thì context cũ chỉ được dọn ở `afterAll`.
  await lastContext?.close().catch(() => undefined);
  const context = await browser.newContext();
  const opened = await context.newPage();
  page = opened;
  lastContext = context;
  // `waitUntil: 'load'` chờ tới trang đích sau chuỗi redirect của OIDC.
  await opened.goto(`${stack.appUrl}/api/auth/login`, { waitUntil: 'load' });
  await opened.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
  return { context, page: opened };
}

/**
 * Mở một deep link của SPA và chờ route render: shell trả 200 ngay, nhưng
 * nội dung trang chỉ xuất hiện sau khi Vue mount + fetch BFF — chờ đúng dấu
 * hiệu dữ liệu thay vì chờ mù thời gian.
 */
async function openPage(target: Page, path: string): Promise<void> {
  await target.goto(`${stack.appUrl}${path}`, { waitUntil: 'load' });
}

describe('pact-broker-app read pages on a real browser against the real broker', () => {
  it('renders the pacts matrix table with real seeded rows on /pacts', async () => {
    const { page: authenticated } = await openAuthenticatedPage();

    await openPage(authenticated, '/pacts');

    // Dữ liệu thật của full stack — không phải stub: cả ba cặp seed phải ra.
    await authenticated.waitForSelector('[data-testid="pact-broker-pacts-table"]', {
      timeout: 30_000,
    });
    const tableText = await authenticated
      .locator('[data-testid="pact-broker-pacts-table"]')
      .innerText();

    expect(tableText).toContain('svc-consumer');
    expect(tableText).toContain('svc-provider');
    expect(tableText).toContain('svc-other');
    // Version từ consumer.version.number — shape HAL thật của matrix.
    expect(tableText).toContain('1.0.0');
    expect(tableText).toContain('2.0.0');
    // Verification đã seed cho pact 1.0.0 (en catalog — browser chạy default locale).
    expect(tableText).toContain('Verified');
  });

  it('renders the environments table with the seeded environment on /environments', async () => {
    const { page: authenticated } = await openAuthenticatedPage();

    await openPage(authenticated, '/environments');

    await authenticated.waitForSelector('[data-testid="pact-broker-environments-table"]', {
      timeout: 30_000,
    });
    const tableText = await authenticated
      .locator('[data-testid="pact-broker-environments-table"]')
      .innerText();
    expect(tableText).toContain('test');
    expect(tableText).toContain('Test');
  });

  it('shows a forbidden state on /tokens and never renders any machine token', async () => {
    const { page: authenticated } = await openAuthenticatedPage();

    await openPage(authenticated, '/tokens');

    // ADR-0032: M1 user path chỉ đọc — route `machine-tokens` đòi mực admin,
    // nên API trả 403 và trang hiển thị trạng thái "không đủ quyền", KHÔNG
    // phải bảng token (credential self-service là #207).
    await authenticated.waitForSelector('[data-testid="pact-broker-empty"]', { timeout: 30_000 });
    expect(await authenticated.locator('[data-testid="pact-broker-tokens-table"]').count()).toBe(0);

    // SR-002 — plaintext token không bao giờ xuất hiện ở bất kỳ đâu trên trang.
    const bodyText = await authenticated.locator('body').innerText();
    expect(bodyText).not.toContain(stack.machineToken);
  });

  it('sets __Host- session cookies that are Secure and HttpOnly, and carries no machine token', async () => {
    const { context, page: authenticated } = await openAuthenticatedPage();
    await openPage(authenticated, '/pacts');
    await authenticated.waitForSelector('[data-testid="pact-broker-pacts-table"]', {
      timeout: 30_000,
    });

    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === '__Host-pact-broker-session');
    expect(session).toBeDefined();
    expect(session?.secure).toBe(true);
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    expect(session?.path).toBe('/');

    // Cookie mang **chỉ** định danh phiên opaque — không token, không JWT.
    expect(session?.value).not.toContain('.');
    for (const cookie of cookies) {
      expect(cookie.value).not.toContain(stack.machineToken);
    }
  });

  it('logs out and back in again — the second session is a new one', async () => {
    const { context, page: authenticated } = await openAuthenticatedPage();
    await openPage(authenticated, '/pacts');
    await authenticated.waitForSelector('[data-testid="pact-broker-pacts-table"]', {
      timeout: 30_000,
    });

    const firstSession = (await context.cookies()).find(
      (cookie) => cookie.name === '__Host-pact-broker-session',
    );
    expect(firstSession).toBeDefined();

    // Logout từ chính trình duyệt: CSRF double-submit — đọc cookie CSRF
    // (không HttpOnly, đúng thiết kế) rồi echo trong header.
    const logoutStatus = await authenticated.evaluate(async () => {
      const csrf = document.cookie
        .split('; ')
        .find((pair) => pair.startsWith('__Host-pact-broker-csrf='))
        ?.split('=')[1];
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: csrf === undefined ? {} : { 'x-ecoma-csrf': csrf },
      });
      return response.status;
    });
    expect(logoutStatus).toBe(204);

    // Cookie phiên bị xoá ⇒ điều hướng tới login khi trang gọi API.
    const cookiesAfterLogout = await context.cookies();
    expect(cookiesAfterLogout.find((cookie) => cookie.name === '__Host-pact-broker-session')).toBe(
      undefined,
    );

    // Đăng nhập lại ⇒ phiên MỚI (khác phiên cũ) và trang đọc lại được dữ liệu.
    const { context: secondContext } = await openAuthenticatedPage();
    const secondSession = (await secondContext.cookies()).find(
      (cookie) => cookie.name === '__Host-pact-broker-session',
    );
    expect(secondSession).toBeDefined();
    expect(secondSession?.value).not.toBe(firstSession?.value);
  });
});
