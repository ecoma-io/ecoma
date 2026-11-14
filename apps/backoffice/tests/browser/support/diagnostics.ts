import type { Page } from '@playwright/test';

/**
 * Bằng chứng mà vế warm-up browser phải tự in ra khi fail (issue #253).
 *
 * ⚠️ Vì sao cần: lần đỏ của #253 cho thấy `page.goto('/')` xong bình thường rồi
 * banner `backoffice-sample-notice` không bao giờ xuất hiện trong ~116s. Đó là
 * hai triệu chứng rất khác nhau — "document không phải app ở mode prototype"
 * (config/env/lane sai) so với "app chưa bao giờ mount" (client JS chết, dev
 * server reload liên tục) — nhưng lỗi timeout chỉ in ra một dòng, không phân
 * biệt được. Module này gắn listener lên `Page` **trước** navigation và chỉ in
 * báo cáo ở đường thất bại, để lần đỏ kế tiếp tự nói ra nguyên nhân thay vì
 * phải đoán (điều kiện hoàn thành đầu tiên của issue).
 *
 * Nguyên tắc:
 *
 * - **Không đổi hành vi.** Chỉ đọc (`console`/`pageerror`/response/requestfailed
 *   events, `page.content()`, `page.evaluate`) và không chặn navigation.
 * - **Không làm ngập log.** Mỗi loại có trần cứng; đường thành công chỉ in một
 *   dòng tổng kết để chứng minh instrumentation đã chạy.
 * - **Không treo job.** Runner 4 vCPU dưới tải có thể có main thread bị chặn;
 *   mọi lượt đọc trang đều có trần riêng, hết trần thì in phần đã thu được thay
 *   vì chờ vô hạn.
 */

/** Số loại thông điệp console tối đa giữ lại (đã gộp theo nội dung). */
const MAX_CONSOLE_KINDS = 40;
/** Độ dài tối đa của một thông điệp/ngăn xếp lỗi giữ lại. */
const MAX_MESSAGE_LENGTH = 400;
/** Số `pageerror` tối đa giữ lại. */
const MAX_PAGE_ERRORS = 20;
/** Số loại request thất bại tối đa giữ lại (đã gộp theo method + URL + mã). */
const MAX_FAILED_REQUESTS = 30;
/** Số document request tối đa giữ lại; phần dư chỉ đếm (`documentRequestCount`). */
const MAX_DOCUMENT_REQUESTS = 20;
/** Độ dài excerpt HTML của `<body>` in ra (không in cả document). */
const BODY_EXCERPT_LENGTH = 900;
/** Trần của một lượt đọc trang. Hết trần thì in phần đã thu được. */
const PAGE_READ_TIMEOUT_MS = 10_000;

/** Một loại thông điệp console, gộp theo nội dung để lộ vòng lặp lặp lại. */
export type ConsoleKind = {
  readonly type: string;
  readonly text: string;
  /** Số lần xuất hiện của đúng nội dung này. */
  count: number;
  /** Thời điểm xuất hiện lần đầu, tính từ đầu vế browser. */
  readonly firstAtMs: number;
};

/** Một loại request thất bại (4xx/5xx hoặc `requestfailed`). */
export type FailedRequest = {
  readonly method: string;
  readonly url: string;
  /** Mã HTTP khi server trả lời; `undefined` khi request không có response. */
  readonly status?: number;
  /** Lý do Playwright ghi nhận (`requestfailed`), ví dụ `net::ERR_ABORTED`. */
  readonly failure?: string;
  count: number;
  readonly firstAtMs: number;
};

/** Một document request — chính là dấu vết dev server full-reload. */
export type DocumentRequest = {
  readonly url: string;
  readonly status?: number;
  readonly atMs: number;
};

/**
 * Nhật ký một phiên browser, tích luỹ bởi {@link watchBrowserSession}.
 *
 * Map dùng khoá gộp nội dung + giữ `count`, vì chuỗi reload/full-reload của Vite
 * optimizer sinh ra hàng trăm thông điệp giống nhau — liệt kê từng dòng sẽ đẩy
 * phần bằng chứng quyết định (data mode, phần tử banner) ra khỏi tầm mắt.
 */
export type BrowserSessionLog = {
  /** `Date.now()` lúc bắt đầu vế browser; mọi mốc thời gian là hiệu số với nó. */
  readonly phaseStart: number;
  readonly consoleKinds: Map<string, ConsoleKind>;
  readonly pageErrors: string[];
  readonly failedRequests: Map<string, FailedRequest>;
  readonly documentRequests: DocumentRequest[];
  /** Tổng số document request, kể cả phần vượt trần `MAX_DOCUMENT_REQUESTS`. */
  documentRequestCount: number;
};

/** Một ảnh chụp trạng thái DOM/client tại thời điểm fail. */
export type PageSnapshot = {
  readonly url: string;
  readonly title: string;
  readonly readyState: string;
  readonly nuxtRootPresent: boolean;
  readonly nuxtRootChildren: number;
  readonly nuxtRootHtmlLength: number;
  readonly noticeInDom: boolean;
  /** `window.__NUXT__.config.public.backofficeDataMode` đã serialize, hoặc `null`. */
  readonly dataMode: string | null;
  readonly bodyExcerpt: string;
};

/**
 * Gắn listener lên `page` và trả về nhật ký tích luỹ.
 *
 * Phải gọi **trước** navigation đầu tiên: `page.on('console')` chỉ thấy sự kiện
 * phát sinh sau thời điểm đăng ký, và toàn bộ giá trị chẩn đoán nằm ở giai đoạn
 * mount đầu tiên.
 */
export function watchBrowserSession(
  page: Page,
  phaseStart: number = Date.now(),
): BrowserSessionLog {
  const log: BrowserSessionLog = {
    phaseStart,
    consoleKinds: new Map<string, ConsoleKind>(),
    pageErrors: [],
    failedRequests: new Map<string, FailedRequest>(),
    documentRequests: [],
    documentRequestCount: 0,
  };

  page.on('console', (message) => {
    const text = truncate(message.text(), MAX_MESSAGE_LENGTH);
    const type = message.type();
    const key = `${type}\u0000${text}`;
    const existing = log.consoleKinds.get(key);

    if (existing !== undefined) {
      existing.count += 1;
      return;
    }

    if (log.consoleKinds.size >= MAX_CONSOLE_KINDS) {
      return;
    }

    log.consoleKinds.set(key, { type, text, count: 1, firstAtMs: Date.now() - phaseStart });
  });

  page.on('pageerror', (error) => {
    if (log.pageErrors.length >= MAX_PAGE_ERRORS) {
      return;
    }

    log.pageErrors.push(truncate(`${error.name}: ${error.message}`, MAX_MESSAGE_LENGTH));
  });

  page.on('response', (response) => {
    const request = response.request();
    const status = response.status();

    if (request.resourceType() === 'document') {
      recordDocumentRequest(log, request.url(), status);
    }

    if (status >= 400) {
      recordFailedRequest(log, request.method(), request.url(), { status });
    }
  });

  page.on('requestfailed', (request) => {
    recordFailedRequest(log, request.method(), request.url(), {
      failure: request.failure()?.errorText ?? 'unknown failure',
    });
  });

  return log;
}

/**
 * Một dòng tổng kết cho đường thành công — đủ để chứng minh instrumentation
 * chạy, không in chi tiết nào.
 */
export function summarizeBrowserSession(log: BrowserSessionLog): string {
  return `[warm-up] browser diagnostics armed: ${String(log.consoleKinds.size)} console kinds, ${String(log.pageErrors.length)} page errors, ${String(log.failedRequests.size)} failed request kinds, ${String(log.documentRequestCount)} document requests (details only on failure)`;
}

/**
 * Báo cáo nhiều dòng, **chỉ** gọi ở đường thất bại.
 *
 * Trả về chuỗi thay vì tự in: `globalSetup` giữ quyền quyết định in ở đâu (CI
 * đọc `stderr`/`stdout` của job như nhau), và unit test kiểm được nội dung mà
 * không cần chạy Playwright.
 *
 * Thứ tự dòng đi từ "cấu hình/lane có đúng không" tới "app có mount không", rồi
 * mới tới log chi tiết: người đọc log CI thấy ngay câu trả lời cho hai giả thuyết
 * hàng đầu của issue.
 */
export async function describeBrowserSession(
  page: Page,
  log: BrowserSessionLog,
  options: { readonly capMs: number },
): Promise<string> {
  const lines: string[] = [];
  const elapsedMs = Date.now() - log.phaseStart;

  lines.push(
    `[warm-up] browser diagnostics on failure (${String(elapsedMs)} ms elapsed of ${String(options.capMs)} ms cap)`,
  );

  const snapshot = await readPageSnapshot(page);

  if (snapshot.ok) {
    lines.push(`[warm-up]   url: ${snapshot.value.url}`);
    lines.push(`[warm-up]   title: ${JSON.stringify(snapshot.value.title)}`);
    lines.push(`[warm-up]   readyState: ${snapshot.value.readyState}`);
    lines.push(
      `[warm-up]   data mode (window.__NUXT__.config.public.backofficeDataMode): ${snapshot.value.dataMode ?? 'absent'}`,
    );
    lines.push(
      `[warm-up]   #__nuxt root: present=${String(snapshot.value.nuxtRootPresent)} children=${String(snapshot.value.nuxtRootChildren)} htmlLength=${String(snapshot.value.nuxtRootHtmlLength)}`,
    );
    lines.push(
      `[warm-up]   notice in rendered DOM: ${snapshot.value.noticeInDom ? 'present' : 'absent'}`,
    );
    lines.push(`[warm-up]   body excerpt: ${snapshot.value.bodyExcerpt}`);
  } else {
    lines.push(`[warm-up]   page snapshot unavailable: ${snapshot.error}`);
  }

  lines.push(...(await describePageContent(page)));

  lines.push(
    `[warm-up]   document requests: ${String(log.documentRequestCount)}${log.documentRequestCount > MAX_DOCUMENT_REQUESTS ? ` (showing first ${String(MAX_DOCUMENT_REQUESTS)})` : ''}`,
  );

  for (const request of log.documentRequests) {
    const status = request.status === undefined ? 'no response' : `HTTP ${String(request.status)}`;
    lines.push(`[warm-up]     +${String(request.atMs)} ms ${request.url} (${status})`);
  }

  lines.push(`[warm-up]   console messages: ${String(log.consoleKinds.size)} distinct`);

  for (const kind of log.consoleKinds.values()) {
    const suffix = kind.count > 1 ? ` (x${String(kind.count)})` : '';
    lines.push(`[warm-up]     [${kind.type}]${suffix} +${String(kind.firstAtMs)} ms ${kind.text}`);
  }

  lines.push(`[warm-up]   page errors: ${String(log.pageErrors.length)}`);

  for (const error of log.pageErrors) {
    lines.push(`[warm-up]     ${error}`);
  }

  lines.push(`[warm-up]   failed requests: ${String(log.failedRequests.size)} distinct`);

  for (const request of log.failedRequests.values()) {
    const detail =
      request.status === undefined
        ? `failure=${request.failure ?? 'unknown'}`
        : `HTTP ${String(request.status)}`;
    const suffix = request.count > 1 ? ` (x${String(request.count)})` : '';
    lines.push(
      `[warm-up]     ${request.method} ${request.url} -> ${detail}${suffix} (+${String(request.firstAtMs)} ms)`,
    );
  }

  return lines.join('\n');
}

/**
 * Kiểm sự có mặt của banner trong **source** HTML (`page.content()`), tách khỏi
 * DOM đang render.
 *
 * Với app non-SSR (`ssr: false` trong `nuxt.config.ts`), banner không bao giờ
 * nằm trong HTML server trả — nó chỉ xuất hiện sau khi client mount. Vì vậy hai
 * dòng "source" và "rendered DOM" phải đọc cùng nhau: `source=absent` là bình
 * thường, còn `rendered DOM=absent` nghĩa là client chưa mount xong.
 */
async function describePageContent(page: Page): Promise<string[]> {
  try {
    const content = await withTimeout(page.content(), PAGE_READ_TIMEOUT_MS, 'page.content()');
    const noticeInSource = content.includes('data-testid="backoffice-sample-notice"');

    return [
      `[warm-up]   notice in page.content() (server HTML): ${noticeInSource ? 'present' : 'absent'}; document length=${String(content.length)}`,
    ];
  } catch (cause) {
    return [`[warm-up]   page.content() unavailable: ${describeError(cause)}`];
  }
}

/**
 * Đọc trạng thái client trong trang. Không ném: mọi lỗi (navigation đang bay,
 * main thread bị chặn) trở thành một dòng báo cáo, vì báo cáo không được phép
 * che lỗi gốc của warm-up.
 */
async function readPageSnapshot(
  page: Page,
): Promise<{ ok: true; value: PageSnapshot } | { ok: false; error: string }> {
  try {
    const value = await withTimeout(
      page.evaluate(() => {
        const root = document.querySelector('#__nuxt');
        // Tên global của Nuxt đi qua biến + chỉ số chuỗi: `no-underscore-dangle`
        // của repo chặn truy cập trực tiếp `window.__NUXT__`.
        const nuxtGlobal = '__NUXT__';
        const nuxt = (
          window as unknown as Record<
            string,
            { config?: { public?: { backofficeDataMode?: unknown } } } | undefined
          >
        )[nuxtGlobal];
        const mode = nuxt?.config?.public?.backofficeDataMode;

        return {
          url: window.location.href,
          title: document.title,
          readyState: document.readyState,
          nuxtRootPresent: root !== null,
          nuxtRootChildren: root?.children.length ?? 0,
          nuxtRootHtmlLength: (root?.innerHTML ?? '').length,
          noticeInDom: document.querySelector('[data-testid="backoffice-sample-notice"]') !== null,
          dataMode: mode === undefined || mode === null ? null : JSON.stringify(mode),
          bodyExcerpt: (document.body?.innerHTML ?? '')
            .replace(/\s+/gu, ' ')
            .slice(0, BODY_EXCERPT_LENGTH),
        };
      }),
      PAGE_READ_TIMEOUT_MS,
      'page.evaluate()',
    );

    return { ok: true, value };
  } catch (cause) {
    return { ok: false, error: describeError(cause) };
  }
}

function recordDocumentRequest(
  log: BrowserSessionLog,
  url: string,
  status: number | undefined,
): void {
  log.documentRequestCount += 1;

  if (log.documentRequests.length >= MAX_DOCUMENT_REQUESTS) {
    return;
  }

  log.documentRequests.push({ url, status, atMs: Date.now() - log.phaseStart });
}

function recordFailedRequest(
  log: BrowserSessionLog,
  method: string,
  url: string,
  detail: { readonly status?: number; readonly failure?: string },
): void {
  const key = `${method} ${url} ${detail.status === undefined ? (detail.failure ?? '') : String(detail.status)}`;
  const existing = log.failedRequests.get(key);

  if (existing !== undefined) {
    existing.count += 1;
    return;
  }

  if (log.failedRequests.size >= MAX_FAILED_REQUESTS) {
    return;
  }

  log.failedRequests.set(key, {
    method,
    url,
    status: detail.status,
    failure: detail.failure,
    count: 1,
    firstAtMs: Date.now() - log.phaseStart,
  });
}

/** Cắt chuỗi về độ dài tối đa, đánh dấu phần bị bỏ. */
function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function describeError(cause: unknown): string {
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

  return truncate(message, MAX_MESSAGE_LENGTH);
}

/**
 * Chặn một lượt đọc trang bằng trần thời gian.
 *
 * `page.evaluate`/`page.content()` không nhận `timeout`; dưới tải CI nặng main
 * thread có thể bị chặn tới mức lượt đọc treo, và một chẩn đoán treo sẽ biến
 * lỗi cần chẩn đoán thành một job timeout thứ hai.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} did not settle within ${String(timeoutMs)} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
