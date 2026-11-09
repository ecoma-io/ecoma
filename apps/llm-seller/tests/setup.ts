/**
 * Setup unit test `pact-broker-app`.
 *
 * - Import `nuxt-globals` để đảm bảo global của Nuxt có mặt và có thể reset.
 * - Reset bridge state để đảm bảo module `#app` có mặt và có thể reset.
 * - Reset bridge giữa các test, tránh state tràn giữa test.
 * - Gỡ component đã mount của test trước: một tree cũ giữ ref vào state mà test sau
 *   thay đi, nên assertion của test sau có thể đọc trạng thái của test trước.
 * - Reset client state của jsdom (cookie, localStorage, sessionStorage, URL) vì
 *   mọi test trong cùng file dùng chung một `window`: cookie locale và cookie
 *   preferences nếu không xoá thì các test chạy sau diễn ra trong môi trường
 *   đã bị nhiễm — một khẳng định "mặc định là en" có thể xanh vì lý do sai
 *   (cookie rò từ test trước) thay vì vì logic thật.
 * - Reset state của Vitest (mock và global stub) vì `vitest.config.mts` không bật
 *   `restoreMocks`/`unstubGlobals`: một mock `fetch` còn sống sang test sau cũng là
 *   đúng loại false-green mà setup này tồn tại để chặn.
 * - Cài ba global trình duyệt mà jsdom thiếu (`matchMedia`, `ResizeObserver`,
 *   `IntersectionObserver`) — xem `tests/browser-globals.ts` — vì `AppShell` và
 *   dependency của nó (`reka-ui`, `vaul-vue`) cần chúng để mount được.
 *
 * Giới hạn còn lại, đã đo (kế thừa phân tích của `apps/backoffice`):
 * - Chỉ cookie đi qua phép gán `document.cookie = ...` mới được ghi nhận. Cookie
 *   do nguồn khác tạo (response header qua `fetch`, internals của jsdom) không
 *   xuất hiện trong danh sách ghi nhận và không được dọn; test nào cần thì tự dọn.
 * - `Domain`: jsdom lưu `Domain=localhost` (đúng host của document) như cookie
 *   host-only và xoá được bằng lệnh không kèm `domain`; `Domain` khác host thì
 *   jsdom **từ chối lưu**. Vì vậy `domain` không cần ghi lại.
 */
import { enableAutoUnmount } from '@vue/test-utils';
import { afterEach, beforeEach, vi } from 'vitest';

import { installBrowserGlobals } from './browser-globals';
import { resetPactBrokerGlobals } from './nuxt-globals';
import { resetNuxtAppBridge } from './nuxt-app-state';

/** Cookie mà test đã đặt, ghi tại thời điểm đặt: đủ để xoá đúng bản ghi. */
type RecordedCookie = {
  name: string;
  path: string;
};

const recordedCookies: RecordedCookie[] = [];
let recording = true;

/**
 * Default-path của RFC 6265 §5.1.4: **thư mục** của URL hiện tại, không phải `/`.
 *
 * Đo được: cookie gán khi URL ở `/pacts` mà không khai `path` mang
 * `path=/pacts`, và ở `/` nó thậm chí không xuất hiện trong `document.cookie`.
 */
function cookieDefaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) {
    return '/';
  }

  const lastSlash = pathname.lastIndexOf('/');

  return lastSlash === 0 ? '/' : pathname.slice(0, lastSlash);
}

/** Ghi lại `(name, path)` của một phép gán `document.cookie = ...`. */
function recordCookieAssignment(assignment: string): void {
  const [pair = '', ...attributes] = assignment.split(';');
  const separator = pair.indexOf('=');
  const name = (separator === -1 ? pair : pair.slice(0, separator)).trim();

  if (name === '') {
    return;
  }

  // Tên attribute không phân biệt hoa/thường (RFC 6265 §5.2), giá trị thì có.
  const declaredPath = attributes
    .map((part) => part.trim())
    .find((part) => part.slice(0, 5).toLowerCase() === 'path=')
    ?.slice(5);

  const path = declaredPath ? declaredPath : cookieDefaultPath(window.location.pathname);

  recordedCookies.push({ name, path });
}

/**
 * Ghi lại mọi cookie test đặt, ngay lúc đặt — thay vì đi tìm tên cookie lúc dọn.
 *
 * Vì sao không quét tên lúc dọn: `document.cookie` chỉ hiển thị cookie khớp
 * path/domain của URL hiện tại. Một cookie `path=/pacts` đặt lúc URL ở `/` không
 * hiện ở `/`; tên của nó không xuất hiện ở đâu để mà xoá, mà jsdom **không có API
 * liệt kê cookie jar**. Ghi lúc gán là cách duy nhất biết chắc tên + path + domain.
 */
function installCookieRecorder(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  const read = descriptor?.get;
  const write = descriptor?.set;

  if (!read || !write) {
    return;
  }

  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get(): string {
      return read.call(document) as string;
    },
    set(value: string): void {
      if (recording) {
        recordCookieAssignment(value);
      }
      write.call(document, value);
    },
  });
}

installCookieRecorder();
installBrowserGlobals();

/** Xoá mọi cookie đã ghi nhận, tại đúng path đã ghi. */
function clearRecordedCookies(): void {
  // Tắt ghi nhận trong lúc dọn: chính lệnh xoá dưới đây cũng là một phép gán
  // `document.cookie`, ghi lại nó sẽ làm danh sách không bao giờ rỗng.
  recording = false;

  try {
    for (const record of recordedCookies.splice(0)) {
      document.cookie = `${record.name}=; Max-Age=0; path=${record.path}`;
    }
  } finally {
    recording = true;
  }
}

function resetClientState(): void {
  // Guard: `beforeEach` này chạy ở mọi environment mà repo cấu hình, và ở
  // `node` thuần không có `window` để dọn — ném ReferenceError sẽ hỏng cả file
  // test đó thay vì bỏ qua phần không áp dụng.
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.clear();
  window.sessionStorage.clear();
  clearRecordedCookies();
  window.history.replaceState({}, '', '/');
}

// Gỡ component đã mount **sau** mỗi test, tức trước `beforeEach` của test kế tiếp:
// `resetPactBrokerGlobals()` thay ref/reactive mà tree cũ đang giữ, và một tree còn
// sống thì assertion của test sau có thể đọc dữ liệu của test trước.
enableAutoUnmount(afterEach);

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // `resetNuxtAppBridge()` xoá runtime config mà harness gắn vào `nuxtApp`:
  // thiếu nó thì cấu hình của test trước rò sang test sau.
  resetNuxtAppBridge();
  // `resetPactBrokerGlobals()` xoá store/cookie/head/route và trả locale về mặc định.
  resetPactBrokerGlobals();
  resetClientState();
});
