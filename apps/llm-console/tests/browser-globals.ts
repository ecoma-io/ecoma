/**
 * Ba global trình duyệt mà jsdom **không** có, nhưng `AppShell` và các dependency
 * của nó (`reka-ui`, `vaul-vue`) cần để mount được:
 *
 * - `window.matchMedia` — `useAppShellMediaQuery` gọi nó trong `onMounted`; thiếu
 *   thì mọi test mount shell đổ ở `TypeError: window.matchMedia is not a function`.
 * - `ResizeObserver` / `IntersectionObserver` — reka-ui (popper, sheet, drawer)
 *   dùng để đo và theo dõi phần tử; thiếu thì component ném lỗi lúc mount.
 *
 * ⚠️ Hàm này **không** tự chạy ở cuối module: `tests/setup.ts` gọi nó ở cấp module
 * của chính file setup. Cách đó vẫn bảo đảm thời điểm cài — vitest nạp setup file
 * trước mọi test file, nên global có mặt trước khi `AppShell`/reka-ui được nạp —
 * mà không cần `import './browser-globals'` trần, thứ mà `import(no-unassigned-import)`
 * của oxlint chặn.
 *
 * ⚠️ Đây là bản rút gọn so với `libs/ui-app-shell/src/lib/testing/nuxt-env.ts`:
 * test của app không mô phỏng thay đổi viewport giữa chừng (không có test nào
 * khẳng định hành vi responsive), nên stub chỉ cần **tồn tại** và trả `false` ổn
 * định. Nếu sau này có test đổi viewport, phải bổ sung đường bắn sự kiện `change`
 * — nếu không, `matches` đổi mà state trong component thì đứng yên.
 */

class ObserverStub {
  observe(): void {
    // jsdom không có layout nên không có gì để theo dõi.
  }

  unobserve(): void {
    // Không có callback nào được đăng ký, nên không có gì để gỡ.
  }

  disconnect(): void {
    // Như trên: không giữ trạng thái nào giữa các lần gọi.
  }

  takeRecords(): [] {
    return [];
  }
}

/** `MediaQueryList` tối thiểu: `matches` luôn `false`, listener không bao giờ bắn. */
function createMediaQueryList(query: string): MediaQueryList {
  return {
    media: query,
    matches: false,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
}

/**
 * Cài những global còn thiếu. `configurable: true` để một lần import khác (hoặc
 * môi trường jsdom cung cấp sẵn) không ném "Cannot redefine property".
 *
 * Idempotent: gọi lại lần nữa không ghi đè thứ đã có.
 */
export function installBrowserGlobals(): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string): MediaQueryList => createMediaQueryList(query),
    });
  }

  for (const name of ['ResizeObserver', 'IntersectionObserver'] as const) {
    if (globalThis[name] === undefined) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: ObserverStub,
      });
    }
  }
}
