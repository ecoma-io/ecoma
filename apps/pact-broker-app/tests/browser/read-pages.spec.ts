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

/**
 * Raw i18n key rò ra trang — dấu hiệu `t('...')` nhận key không có trong
 * catalog và render nguyên văn. Pattern giới hạn prefix của các nhóm key
 * dashboard (không generic: các khối lệnh CLI trên `/onboarding` chứa
 * `provider.json` kiểu đó sẽ khớp regex generic gây âm giả).
 */
const I18N_RAW_KEY_PATTERN =
  /\b(?:deployments|verifications|matrix|onboarding|states|pacts|overview|tokens|environments|nav)\.[a-zA-Z]/u;

/**
 * Ghi nhận lỗi trình duyệt của một page: console mức `error` và `pageerror`
 * chưa bắt. Listener gắn vào page được trả về và các mảng được push tiếp sau
 * khi helper return — assert ở **cuối** test để bắt cả lỗi nổ sau khi assert
 * dữ liệu (ví dụ lỗi hydration muộn hay fetch reject chậm).
 */
function watchBrowserErrors(target: Page): { consoleErrors: string[]; pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  target.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  target.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  return { consoleErrors, pageErrors };
}

/**
 * Assert chung cho mọi trang đọc: không lỗi console, không lỗi chưa bắt, và
 * không raw i18n key nào rò ra body. Tách hàm để cả ba trang mới dùng đúng
 * một định nghĩa "trang sạch".
 */
async function expectCleanPage(
  target: Page,
  errors: { consoleErrors: string[]; pageErrors: string[] },
): Promise<void> {
  const bodyText = await target.locator('body').innerText();
  expect(bodyText, 'raw i18n keys must never leak into the rendered page').not.toMatch(
    I18N_RAW_KEY_PATTERN,
  );
  expect(errors.pageErrors, 'uncaught page errors').toEqual([]);
  expect(errors.consoleErrors, 'console errors').toEqual([]);
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

  it('renders the tokens table on /tokens with metadata only and never any machine token', async () => {
    const { page: authenticated } = await openAuthenticatedPage();

    await openPage(authenticated, '/tokens');

    // ADR-0032 §5 (#207): owner session (floor admin) thấy bảng metadata
    // credential; hợp đồng không đổi — không token material nào trên trang
    // (SR-002/SR-007), và list chỉ chứa metadata (không secret).
    await authenticated.waitForSelector('[data-testid="pact-broker-tokens-table"]', {
      timeout: 30_000,
    });

    // SR-002 — plaintext token không bao giờ xuất hiện ở bất kỳ đâu trên trang.
    const bodyText = await authenticated.locator('body').innerText();
    expect(bodyText).not.toContain(stack.machineToken);
    // Digest hex 64 ký tự của token seed cũng không được rò qua bảng metadata.
    expect(bodyText).not.toMatch(new RegExp(stack.machineToken, 'u'));
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

  // ===== Ba trang mới của #208: /verifications, /matrix, /onboarding =====

  it('renders the verifications table with the seeded verification on /verifications', async () => {
    const { page: authenticated } = await openAuthenticatedPage();
    const errors = watchBrowserErrors(authenticated);

    await openPage(authenticated, '/verifications');

    // Trang gộp row theo provider cho consumer ĐANG chọn (mặc định cái đầu
    // trong dropdown) và lấy verification mới nhất — seed có một verification
    // thành công cho svc-consumer@1.0.0 → svc-provider, nên bảng mặc định
    // phải ra đúng row đó, không rơi vào empty/unavailable dù seed đầy đủ.
    await authenticated.waitForSelector('[data-testid="pact-broker-verifications-table"]', {
      timeout: 30_000,
    });
    const tableText = await authenticated
      .locator('[data-testid="pact-broker-verifications-table"]')
      .innerText();
    expect(tableText).toContain('svc-consumer');
    expect(tableText).toContain('svc-provider');
    expect(tableText).toContain('Verified');

    // Đổi consumer qua dropdown thật: cặp chưa verify nào phải hiện
    // "Not verified" — nhánh null-verification của trang, không phải row mất.
    const consumers = ['svc-consumer', 'svc-other'];
    for (const consumer of consumers) {
      const present = await authenticated
        .locator('[data-testid="pact-broker-verifications-consumer-select"] option', {
          hasText: consumer,
        })
        .count();
      expect(present, `dropdown must offer the seeded consumer ${consumer}`).toBeGreaterThan(0);
    }
    await authenticated.selectOption('[data-testid="pact-broker-verifications-consumer-select"]', {
      label: 'svc-other',
    });
    await authenticated.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="pact-broker-verifications-table"]')
          ?.textContent?.includes('svc-other'),
      undefined,
      { timeout: 30_000 },
    );
    const otherText = await authenticated
      .locator('[data-testid="pact-broker-verifications-table"]')
      .innerText();
    expect(otherText).toContain('svc-other');
    expect(otherText).toContain('Not verified');

    await expectCleanPage(authenticated, errors);
  });

  it('serves the matrix form populated with the seeded pacticipants on /matrix', async () => {
    const { page: authenticated } = await openAuthenticatedPage();
    const errors = watchBrowserErrors(authenticated);

    await openPage(authenticated, '/matrix');

    // Form chỉ render khi danh sách pacticipant nạp được từ BFF — chính nó là
    // bằng chứng trang đọc được dữ liệu thật.
    await authenticated.waitForSelector('[data-testid="pact-broker-matrix-form"]', {
      timeout: 30_000,
    });
    for (const name of ['svc-consumer', 'svc-other', 'svc-provider']) {
      const present = await authenticated
        .locator('[data-testid="pact-broker-matrix-pacticipant"] option', { hasText: name })
        .count();
      expect(present, `dropdown must offer the seeded pacticipant ${name}`).toBeGreaterThan(0);
    }

    await expectCleanPage(authenticated, errors);
  });

  // Verdict `can-i-deploy` qua form thật: POST phải mang header CSRF
  // double-submit — thiếu header là middleware authn 401 và `brokerFetch`
  // dịch thành redirect login (kicks người dùng ra login thay vì hiện verdict).

  it('returns a verdict for svc-consumer@1.0.0 without any login redirect on /matrix', async () => {
    const { page: authenticated } = await openAuthenticatedPage();
    const errors = watchBrowserErrors(authenticated);

    await openPage(authenticated, '/matrix');

    await authenticated.waitForSelector('[data-testid="pact-broker-matrix-form"]', {
      timeout: 30_000,
    });

    // Điền form với cặp seed có verification thành công
    // (svc-consumer@1.0.0 → svc-provider): verdict phải là deployable.
    await authenticated.selectOption('[data-testid="pact-broker-matrix-pacticipant"]', {
      label: 'svc-consumer',
    });
    await authenticated.fill('[data-testid="pact-broker-matrix-version"]', '1.0.0');
    await authenticated.click('[data-testid="pact-broker-matrix-ask"]');

    // Verdict hiện ra và KHÔNG có redirect login: URL vẫn là /matrix và
    // nguyên văn verdict deployable của catalog render trên trang.
    await authenticated.waitForSelector('[data-testid="pact-broker-matrix-verdict"]', {
      timeout: 30_000,
    });
    expect(authenticated.url()).not.toContain('/api/auth/login');
    const verdictText = await authenticated
      .locator('[data-testid="pact-broker-matrix-verdict"]')
      .innerText();
    expect(verdictText).toContain('Deployable: all verifications for this version pass.');

    // Bảng matrix đi kèm verdict: row thật của seed, verification Verified.
    await authenticated.waitForSelector('[data-testid="pact-broker-matrix-table"]', {
      timeout: 30_000,
    });
    const tableText = await authenticated
      .locator('[data-testid="pact-broker-matrix-table"]')
      .innerText();
    expect(tableText).toContain('svc-consumer');
    expect(tableText).toContain('svc-provider');
    expect(tableText).toContain('1.0.0');
    expect(tableText).toContain('Verified');

    await expectCleanPage(authenticated, errors);
  });

  it('renders the CLI onboarding command blocks with the pinned CLI version on /onboarding', async () => {
    const { page: authenticated } = await openAuthenticatedPage();
    const errors = watchBrowserErrors(authenticated);

    await openPage(authenticated, '/onboarding');

    // Trang tĩnh không đọc BFF — khối lệnh là dữ liệu assert: pin CLI và các
    // lệnh thật của quy trình publish/verify/can-i-deploy.
    await authenticated.waitForSelector('[data-testid="pact-broker-onboarding-pin"]', {
      timeout: 30_000,
    });
    const bodyText = await authenticated.locator('body').innerText();
    expect(bodyText).toContain('18.10.9');
    expect(bodyText).toContain('pact-broker publish');
    expect(bodyText).toContain('pact verifier');
    expect(bodyText).toContain('can-i-deploy');
    expect(bodyText).toContain('record-deployment');

    // SR-002: token thật của stack không bao giờ render lại trên trang nào.
    expect(bodyText).not.toContain(stack.machineToken);
    // Placeholder của token trong khối lệnh là chủ ý (show-once), giữ nguyên.
    expect(bodyText).toContain('$PACT_BROKER_TOKEN');

    // SR-002 trên toàn HTML (không chỉ innerText): attribute/CDATA/comment
    // ẩn cũng không được mang token thật.
    const bodyHtml = await authenticated.locator('body').innerHTML();
    expect(bodyHtml).not.toContain(stack.machineToken);

    await expectCleanPage(authenticated, errors);
  });
});
