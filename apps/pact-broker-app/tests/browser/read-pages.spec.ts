/**
 * Browser regression cho các read pages của `pact-broker-app` — `/pacts`,
 * `/environments`, `/tokens` — trên **Chromium thật** chạy full stack thật
 * (workerd app + workerd API + PostgreSQL container, dữ liệu seed qua public
 * surface của API).
 *
 * Vì sao suite này tồn tại (issue #181): lỗi gốc của trang `/pacts` sống sót
 * qua mọi unit stub vì stub mang đúng shape mà trang ĐÃ giả định — contract
 * thật của API là matrix HAL ở top-level với `consumer.version.number`, và
 * chỉ một request thật trên trình duyệt thật mới chứng minh được trang render
 * dữ liệu thật. Browser regression app-owned (`tests/browser/`), không phải
 * system E2E (06-testing.md §2, §3 — runner không quyết định category).
 *
 * ⚠️ Chromium lấy từ `@playwright/test` (re-export `playwright-core`) — đã là
 * devDependency của ROOT workspace, project này không thêm dep nào. Binary
 * chromium phải có sẵn trong cache Playwright của runner (`PLAYWRIGHT_BROWSERS_PATH`
 * mặc định); thiếu binary là lỗi lúc launch — đỏ, không skip.
 */

import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startBrokerStack, type BrokerStack } from '../integrations/broker-stack';

let stack: BrokerStack;
let browser: Browser;
/** Trang đang mở của test hiện tại — afterEach đóng bất kể test đỏ hay xanh. */
let page: Page | undefined;

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
});

/**
 * Mở một deep link của SPA và chờ route render: shell trả 200 ngay, nhưng
 * nội dung trang chỉ xuất hiện sau khi Vue mount + fetch BFF — chờ đúng dấu
 * hiệu dữ liệu thay vì chờ mù thời gian.
 */
async function openPage(path: string): Promise<Page> {
  const opened = await browser.newPage();
  // Gán trước khi goto: goto ném (timeout, mất kết nối) thì afterEach vẫn có
  // tham chiếu để đóng tab.
  page = opened;
  await opened.goto(`${stack.appUrl}${path}`, { waitUntil: 'load' });
  return opened;
}

describe('pact-broker-app read pages on a real browser against the real broker', () => {
  it('renders the pacts matrix table with real seeded rows on /pacts', async () => {
    const opened = await openPage('/pacts');

    // Dữ liệu thật của full stack — không phải stub: cả ba cặp seed phải ra.
    await opened.waitForSelector('[data-testid="pact-broker-pacts-table"]', { timeout: 30_000 });
    const tableText = await opened.locator('[data-testid="pact-broker-pacts-table"]').innerText();

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
    const opened = await openPage('/environments');

    await opened.waitForSelector('[data-testid="pact-broker-environments-table"]', {
      timeout: 30_000,
    });
    const tableText = await opened
      .locator('[data-testid="pact-broker-environments-table"]')
      .innerText();

    expect(tableText).toContain('test');
    expect(tableText).toContain('Test');
  });

  it('renders the token metadata row on /tokens without ever exposing the plaintext token', async () => {
    const opened = await openPage('/tokens');

    await opened.waitForSelector('[data-testid="pact-broker-tokens-table"]', { timeout: 30_000 });
    const tableText = await opened.locator('[data-testid="pact-broker-tokens-table"]').innerText();

    // Metadata đúng: tên + scope admin như lane provision cho BFF.
    expect(tableText).toContain('pact-broker-app-bff');
    expect(tableText).toContain('admin');
    // SR-002 — plaintext token không bao giờ xuất hiện ở bất kỳ đâu trên trang.
    const bodyText = await opened.locator('body').innerText();
    expect(bodyText).not.toContain(stack.machineToken);
  });
});
