import type { PropType, VNode } from 'vue';
import { defineComponent, h } from 'vue';

/**
 * Cầu nối môi trường Nuxt cho test của library. Nuxt cấp ba thứ mà jsdom
 * **không** có, và component của shell dùng cả ba:
 *
 * - `window.matchMedia` — jsdom không cài đặt API này. `useAppShellMediaQuery`
 *   gọi nó trong `onMounted`, nên thiếu nó thì mọi test mount sidebar đổ ngay
 *   ở `TypeError: window.matchMedia is not a function`.
 * - `ResizeObserver` / `IntersectionObserver` — reka-ui (popper, sheet, drawer)
 *   dùng để đo và theo dõi phần tử. jsdom không có; thiếu thì component ném lỗi
 *   lúc mount chứ không phải lúc render.
 * - `NuxtLink` — component do runtime Nuxt đăng ký, không import được. Test cấp
 *   một stub render ra `<a href>` để vẫn kiểm tra được đích điều hướng.
 *
 * Cài ở **thời điểm import** (không phải trong `beforeEach`) vì một số thư viện
 * đọc global ngay lúc module của chúng được nạp; cài muộn hơn thì đã quá trễ và
 * lỗi sẽ là "not a function" ở giữa một component không liên quan.
 */

/** Giá trị `matches` theo từng query; query không khai thì mặc định `false`. */
const mediaQueryMatches = new Map<string, boolean>();

/**
 * Mỗi `MediaQueryList` stub sinh ra kèm một set listener của chính nó. Gom tại
 * đây (thay vì treo trên object) để `setMediaQueryMatches` với một `query` khác
 * vẫn với tới được listener đã đăng ký.
 */
const mediaQueryListeners = new Map<MediaQueryList, Set<(event: MediaQueryListEvent) => void>>();

/**
 * Đặt kết quả cho một media query, mô phỏng viewport. Hàm có **hai chế độ** và
 * chúng dùng khác nhau:
 *
 * - **Trước khi mount**: chưa có listener nào đăng ký, nên chỉ giá trị `matches`
 *   ban đầu của `MediaQueryList` stub là đổi. Đây là cách dựng nhánh mobile hay
 *   desktop ngay từ render đầu.
 * - **Sau khi mount**: `useAppShellMediaQuery` cập nhật state **qua sự kiện
 *   `change`** chứ không đọc lại `matches`, nên nếu chỉ đổi giá trị thì test đổi
 *   viewport sau mount vẫn xanh mà DOM không đổi theo. Vì thế nhánh dispatch ở
 *   dưới là bắt buộc, không phải phụ kiện.
 *
 * `(max-width: 768px)` là query quyết định sidebar ở chế độ desktop hay mobile
 * (`useAppShellMediaQuery('(max-width: 768px)', false)`).
 */
export function setMediaQueryMatches(query: string, matches: boolean): void {
  const prev = mediaQueryMatches.get(query) ?? false;
  mediaQueryMatches.set(query, matches);
  if (prev === matches) return;

  // `useAppShellMediaQuery` cập nhật state **qua sự kiện `change`**, nên stub
  // phải bắn event tới các listener đã đăng ký. Bắn cả `onchange` và addListener.
  // `createMediaQueryList` ghi vào chính `mediaQueryListeners` này, và một
  // listener hoàn toàn có thể mount component mới trong lúc dispatch (component
  // đó gọi `matchMedia` trong `onMounted`). Iterator của `Map` ghé cả entry vừa
  // thêm, tức là bắn `change` cho một list sinh ra **sau** thay đổi — điều mà
  // trình duyệt thật không bao giờ làm. Chụp snapshot trước khi duyệt; spread ở
  // đây không phải kiểu code thừa mà `no-useless-spread` đang nhắm tới.
  // oxlint-disable-next-line no-useless-spread
  for (const [list, listeners] of [...mediaQueryListeners]) {
    if (list.media !== query) continue;
    // `MediaQueryListEvent` thật có `type`; thêm vào cho đủ, phòng khi có code
    // (hoặc thư viện) branch theo `event.type` thay vì đọc `matches`.
    const event = { type: 'change', matches, media: query } as MediaQueryListEvent;
    // Cách ly lỗi giữa các listener, giống trình duyệt: một listener ném lỗi
    // **không** chặn listener kế tiếp, và cũng không làm hàm này ném ra ngoài
    // chỗ component gắn vào. Đây là cách ly, không phải che giấu thất bại —
    // listener nào thật sự không chịu nổi giá trị mới thì state của nó sẽ đổ
    // ngay ở assertion của chính test đó. Cả hai đường (`onchange` và các
    // listener đăng ký) đi qua **cùng một** helper để hai vế không lệch nhau.
    const dispatch = (listener: (event: MediaQueryListEvent) => void): void => {
      try {
        listener(event);
      } catch {
        // noop: xem đoạn cách ly ngay trên.
      }
    };
    if (typeof list.onchange === 'function') {
      dispatch(list.onchange);
    }
    // `for…of` trên `Set` là an toàn khi listener tự gỡ chính nó trong lúc
    // dispatch: phần tử bị xoá chỉ đơn giản không được thăm nữa, không nhảy phần
    // tử kế tiếp. Không cần copy sang mảng trước khi lặp — khác với vòng lặp Map
    // ngay trên, ở đó vấn đề là entry **thêm vào** chứ không phải gỡ ra.
    for (const listener of listeners) {
      dispatch(listener);
    }
  }
}

/**
 * Trả mọi query về mặc định `false`.
 *
 * `mediaQueryListeners` chỉ gỡ entry **đã rỗng** chứ không xoá sạch: một list
 * của component còn mount vẫn giữ listener của chính nó, mà xoá sạch registry
 * sẽ làm `setMediaQueryMatches` sau đó không với tới list đó nữa — lúc đó
 * `mql.matches` đổi còn state trong component thì đứng yên, một lệch thứ tự im
 * lặng chỉ chờ ai đó gọi `reset` trước khi `unmount`. List của component đã
 * unmount thì `onScopeDispose` đã gỡ hết listener nên entry tự rỗng và được dọn
 * ở đây.
 */
export function resetMediaQueryMatches(): void {
  mediaQueryMatches.clear();
  for (const [list, listeners] of mediaQueryListeners) {
    if (listeners.size === 0) {
      mediaQueryListeners.delete(list);
    }
  }
}

function createMediaQueryList(query: string): MediaQueryList {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const list = {
    media: query,
    get matches(): boolean {
      return mediaQueryMatches.get(query) ?? false;
    },
    onchange: null as ((event: MediaQueryListEvent) => void) | null,
    addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
      // `MediaQueryList` thật chỉ hỗ trợ `change`; listener của loại khác không
      // bao giờ được bắn. Gom tất cả vào chung một Set rồi bắn `change` cho đủ
      // là giả định sai hợp đồng — và là kiểu sai sót chỉ lộ ra rất muộn, khi
      // có ai đó đăng ký một loại khác và tự hỏi sao nó chạy.
      if (type === 'change') {
        listeners.add(listener);
      }
    },
    removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
      // Đối xứng với `addEventListener` ở trên: gỡ đúng listener đã thêm, tức
      // chỉ listener của `change`.
      if (type === 'change') {
        listeners.delete(listener);
      }
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;

  mediaQueryListeners.set(list, listeners);
  return list;
}

/**
 * Thay cho `ResizeObserver`/`IntersectionObserver` của trình duyệt. reka-ui chỉ
 * cần ba method tồn tại để gọi; nội dung rỗng là đúng ý đồ, nên có comment giải
 * thích thay vì thân hàm rỗng không lý do.
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

function installBrowserGlobals(): void {
  if (typeof window === 'undefined') {
    return;
  }

  // `configurable: true` để lần import sau (hoặc một thư viện tự cài) không ném
  // lỗi "Cannot redefine property".
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList => createMediaQueryList(query),
  });

  for (const name of ['ResizeObserver', 'IntersectionObserver'] as const) {
    if (window[name] === undefined) {
      Object.defineProperty(window, name, {
        configurable: true,
        writable: true,
        value: ObserverStub,
      });
    }
  }
}

installBrowserGlobals();

/**
 * Stub cho `NuxtLink`. Truyền vào `global.components` khi mount:
 *
 * ```ts
 * mount(AppShell, { global: { components: { NuxtLink: NuxtLinkStub } } });
 * ```
 *
 * `config.global.components` là cơ chế duy nhất khiến một tên **viết hoa không
 * import** trong template resolve được: `<NuxtLink>` biên dịch thành
 * `resolveComponent('NuxtLink')`, và bước tra đó đọc từ component registry của
 * app. Stub này render thật ra `<a href>` (không phải `<nuxt-link-stub>` như
 * `stubs` mặc định) để test khẳng định được đích điều hướng.
 */
export const NuxtLinkStub = defineComponent({
  name: 'NuxtLink',
  inheritAttrs: false,
  props: {
    to: {
      type: [String, Object] as PropType<string | Record<string, unknown>>,
      default: undefined,
    },
  },
  setup(props, { slots, attrs }) {
    // `slots['default']` chứ không `slots.default`: tsconfig của lib bật
    // `noPropertyAccessFromIndexSignature`, và `Slots` của Vue đúng là một
    // kiểu có index signature.
    return (): VNode =>
      h(
        'a',
        { ...attrs, href: typeof props.to === 'string' ? props.to : '#' },
        slots['default']?.(),
      );
  },
});
