import type { Locator, Page } from '@playwright/test';

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

/** Chờ route hiện tại render xong phần dữ liệu mà test cần. */
export async function waitForRouteReady(page: Page, path: string): Promise<void> {
  const testId = READY_TEST_IDS[path];

  if (testId === undefined) {
    throw new Error(`Không có tín hiệu ready cho route "${path}".`);
  }

  await page.getByTestId(testId).waitFor({ state: 'visible' });
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
