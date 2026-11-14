import type { Locator, Page } from '@playwright/test';

/**
 * Khoảng lặng xác nhận dev server đã thôi thay trang: không có document request
 * mới trong khoảng này ⇒ cache Vite đã nóng, reload lần sau sẽ phục vụ module
 * từ cache, không gây `full-reload` nữa.
 */
const QUIET_MS = 3_000;

/**
 * Hạ tầng dùng chung cho bộ test browser của backoffice.
 *
 * Không có gì ở đây là "app thứ hai để test": mọi hàm chỉ **đọc DOM đang render**
 * hoặc gắn listener lên `Page`. Không hàm nào tự dựng lại logic của app (một bản
 * sao của `filtered` trong test sẽ luôn khớp với chính nó, kể cả khi UI sai).
 */

/**
 * Năm route prototype, đúng thứ tự trong sidebar.
 *
 * ⚠️ `title` (tiêu đề `<h1>` của trang) và `navTitle` (nhãn link sidebar) là
 * **hai** giá trị khác nhau và phải khai riêng: `/audit` có tiêu đề trang là
 * "Audit trail" nhưng nhãn nav là "Audit" (`nav.audit` ≠ `audit.title`). Fixture
 * cũ gộp một field cho cả hai là nguyên nhân bộ test đỏ khi `/audit` thêm vào
 * nav — bốn test "points every internal link" fail vì nav thật có 5 link mà
 * danh sách route chỉ có 4. Thêm route mới ⇒ thêm **một** mục ở đây + một tín
 * hiệu ready; quên là bộ test đỏ (đúng chiều — fixture lỗi thời phải đỏ).
 */
export const PROTOTYPE_ROUTES = [
  { path: '/', title: 'Overview', navTitle: 'Overview' },
  { path: '/staff', title: 'Staff', navTitle: 'Staff' },
  { path: '/roles', title: 'Roles', navTitle: 'Roles' },
  { path: '/permissions', title: 'Permissions', navTitle: 'Permissions' },
  { path: '/audit', title: 'Audit trail', navTitle: 'Audit' },
] as const;

/**
 * Tín hiệu "trang đã render xong dữ liệu" cho từng route.
 *
 * ⚠️ Cần tín hiệu này thay vì `waitForLoadState('networkidle')`: dữ liệu của trang
 * được nạp trong `onMounted` (xem `use-async-state.ts` — lần render đầu vẽ skeleton,
 * client nạp dữ liệu sau), nên "load" xong **không** có nghĩa là bảng đã có dữ liệu.
 * Chờ đúng phần tử mà test sắp assert vừa nhanh hơn vừa không phụ thuộc mạng.
 */
const READY_TEST_IDS: Readonly<Record<string, string>> = {
  '/': 'backoffice-sample-notice',
  '/staff': 'staff-table',
  '/roles': 'roles-table',
  '/permissions': 'permissions-table',
  // Audit không có dữ liệu mẫu cố định để render bảng: empty state (`audit-empty`)
  // là tín hiệu sẵn có ngay khi trang load xong danh sách (rỗng hay không).
  '/audit': 'audit-empty',
};

/**
 * Chờ route hiện tại render xong phần dữ liệu mà test cần.
 *
 * ⚠️ `timeoutMs` không phải tùy chọn trang trí: không truyền thì lần chờ rơi về
 * timeout mặc định của Playwright (30s) — **không liên quan** đến trần warm-up
 * (`WARM_UP_CAP_MS`). Đó chính là cơ chế đỏ của #239: chain reload của Vite
 * optimizer trên CI vượt 30s trong khi trần warm-up chỉ áp cho hai chỗ chờ khác.
 * `globalSetup` truyền phần trần còn lại của cả vế browser để tổng thời gian
 * warm-up có đúng một biên biết trước.
 *
 * ⚠️ Vì sao cần reload một lần theo ý định: trên CI runner sạch, cache Vite
 * nguội ⇒ lần tải đầu của browser kích hoạt `full-reload` của dev server, và
 * `full-reload` huỷ toàn bộ request module đang bay (`net::ERR_NETWORK_CHANGED`).
 * Client không bao giờ mount ⇒ `getByTestId(...).waitFor()` chờ mãi đến hết trần.
 * Sau lần reload đầu, cache Vite đã nóng, nên reload lần thứ hai phục vụ module
 * từ cache, không gây `full-reload` nữa, và client có thể mount. Đây là **một**
 * lần reload có chủ đích sau sự kiện thay đổi mạng, không phải "chờ lâu hơn và
 * hy vọng": nếu phần tử vẫn không xuất hiện sau reload, lỗi được ném ra thay vì
 * bị nuốt.
 */
export async function waitForRouteReady(
  page: Page,
  path: string,
  timeoutMs?: number,
): Promise<void> {
  const testId = READY_TEST_IDS[path];

  if (testId === undefined) {
    throw new Error(`Không có tín hiệu ready cho route "${path}".`);
  }

  const deadline = Date.now() + (timeoutMs ?? 30_000);
  let reloaded = false;
  let firstCause: unknown;

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw (
        firstCause ??
        new Error(
          `Chờ route "${path}" hết trần sau ${String(timeoutMs ?? 30_000)} ms; route vẫn chưa render xong.`,
        )
      );
    }

    // Chờ theo lát: `QUIET_MS` mỗi lát để không chờ liên tục 30s một lượt,
    // và trần còn lại vẫn được tôn trọng (không chờ vượt deadline).
    const sliceTimeoutMs = Math.min(QUIET_MS, remainingMs);

    try {
      await page.getByTestId(testId).waitFor({ state: 'visible', timeout: sliceTimeoutMs });
      return;
    } catch (cause) {
      if (firstCause === undefined) {
        firstCause = cause;
      }

      const now = Date.now();
      if (now >= deadline) {
        throw firstCause;
      }

      // Một lần reload theo ý định: Vite full-reload đã huỷ module graph, nhưng
      // cache dependency đã nóng sau lần tải đầu. Reload lần thứ hai phục vụ
      // module từ cache, không gây full-reload nữa. Chỉ reload một lần; sau đó
      // tiếp tục chờ theo lát cho đến hết trần thay vì ném ngay sau một lát.
      if (!reloaded) {
        reloaded = true;
        await page.reload({ waitUntil: 'domcontentloaded' });
      }
    }
  }
}

/** Tiêu đề `<h1>` của trang đang xem. */
export async function pageTitle(page: Page): Promise<string> {
  const heading = page.getByTestId('backoffice-page-title');

  return (await heading.innerText()).trim();
}

/** Một bảng đã render: nhãn cột và toàn bộ ô dữ liệu, đã chuẩn hoá khoảng trắng. */
export type RenderedTable = {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
};

/**
 * Đọc một bảng theo `data-testid` của chính bảng đó.
 *
 * `getByRole` thay vì CSS `td`/`th`: nó bám vào ngữ nghĩa của bảng (row /
 * columnheader / cell), nên đổi class hay thêm `<div>` bọc không làm test đỏ giả,
 * còn bỏ `<td>` thật thì đỏ — đúng chiều.
 */
export async function readTable(page: Page, testId: string): Promise<RenderedTable> {
  const table = page.getByTestId(testId);
  const headers = await table.locator('thead').getByRole('columnheader').allInnerTexts();

  const rowLocator = table.locator('tbody').getByRole('row');
  const rows: string[][] = [];

  for (const row of await rowLocator.all()) {
    const cells = await row.getByRole('cell').allInnerTexts();
    rows.push(cells.map(normalizeText));
  }

  return { headers: headers.map(normalizeText), rows };
}

/**
 * Các link nội bộ đang có trên trang (sidebar, breadcrumb, logo, link nhanh).
 *
 * Thu thập **mọi** `<a href>` rồi để trình duyệt tự phân giải absolute URL
 * (`anchor.href`), thay vì chỉ đọc attribute của href bắt đầu bằng "/". Khác
 * biệt này có thật và đã đo được: một link tương đối như `href="gone"` trên
 * `/staff` không bắt đầu bằng "/" nên bộ lọc cũ bỏ qua, trong khi trình duyệt
 * phân giải nó thành `/gone` (route chết, HTTP 404). Sau đó giữ link cùng
 * origin với trang và trả về pathname (hash/query bỏ qua: mục tiêu là kiểm tra
 * link có dẫn tới route thật không, không phải điều kiện truy vấn).
 */
export async function internalHrefs(page: Page): Promise<string[]> {
  const origin = new URL(page.url()).origin;

  const resolved = await page
    .locator('a[href]')
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.href));

  const unique = new Set<string>();

  for (const href of resolved) {
    const url = new URL(href);

    if (url.origin === origin) {
      unique.add(url.pathname);
    }
  }

  return [...unique].toSorted();
}

/** Mục nav đang được đánh dấu active, kèm `href` của nó. */
export async function activeSidebarHrefs(page: Page): Promise<string[]> {
  return page
    .locator('[data-slot="sidebar"] a[data-active="true"]')
    .evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute('href')).filter((href) => href !== null),
    );
}

/**
 * Link điều hướng trong sidebar theo **tên truy cập được**, không theo thứ tự DOM.
 *
 * `:not([data-mobile="true"])` loại nhánh Sheet trên mobile: nó cũng mang
 * `data-slot="sidebar"`, nên nếu tồn tại song song thì mọi locator ở đây khớp hai
 * phần tử và rơi vào strict-mode violation.
 */
export function sidebarLink(page: Page, name: string): Locator {
  return page
    .locator('[data-slot="sidebar"]:not([data-mobile="true"])')
    .getByRole('link', { name, exact: true });
}

/**
 * Phần nội dung của trang, tách khỏi chrome của shell (header, trigger, breadcrumb).
 *
 * Dùng cho các phép đếm **đóng** (số điều khiển tương tác phải đúng bằng danh sách
 * cho phép): gộp cả chrome vào sẽ phải liệt kê cả nút "Toggle Sidebar" và `<select>`
 * ngôn ngữ của shell, làm phép đếm phụ thuộc vào shell thay vì vào trang.
 */
export function mainSection(page: Page): Locator {
  return page.getByRole('main').locator('section');
}

/**
 * Toàn bộ vùng `main`, **gồm cả** chrome của shell (header, breadcrumb).
 *
 * Dùng cho các bất biến phủ định ("không có affordance ghi ở đâu", "không có chữ tự
 * nhận đã lưu"): ở đó net càng rộng càng tốt, vì một nút ghi đặt ở header cũng là
 * affordance ghi. `mainSection` không phù hợp cho việc này.
 */
export function mainRegion(page: Page): Locator {
  return page.getByRole('main');
}

/** Toàn bộ link điều hướng trong sidebar, không phụ thuộc trạng thái active. */
export function sidebarNavLinks(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-slot="sidebar"] a[data-active]');
}

/**
 * Lỗi runtime của **tab đang chạy**, gom lại để một test có thể assert "không có".
 *
 * Chỉ `console` type `error` và `pageerror`: Nuxt DevTools và Vite ghi khá nhiều
 * `log`/`info` trong dev, và một suite đỏ vì log thông tin thì sẽ bị tắt thay vì
 * được sửa.
 */
export type RuntimeFailures = {
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
};

/**
 * Gắn listener và trả về mảng **sống** (đọc lại sau khi trang đã chạy xong).
 *
 * ⚠️ Phải gọi **trước** `page.goto`: listener gắn sau khi trang đã load sẽ không
 * bao giờ thấy lỗi của chính lần load đó, và test sẽ xanh vì lý do sai.
 */
export function watchRuntimeFailures(page: Page): RuntimeFailures {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(`${message.text()} (${message.location().url})`);
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  return { consoleErrors, pageErrors };
}

/** Request đã phát ra từ tab, kèm method — để kiểm "không có thao tác ghi". */
export type ObservedRequest = {
  readonly method: string;
  readonly url: string;
};

/**
 * Ghi lại mọi request của tab. Dùng để khẳng định adapter prototype không gọi
 * backend: bộ test này không kiểm nội dung request, nó kiểm **sự tồn tại** của
 * một thao tác ghi.
 */
export function watchRequests(page: Page): ObservedRequest[] {
  const requests: ObservedRequest[] = [];

  page.on('request', (request) => {
    requests.push({ method: request.method(), url: request.url() });
  });

  return requests;
}

/** Gộp mọi khoảng trắng (kể cả xuống dòng trong `<td>`) thành một dấu cách. */
export function normalizeText(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}
