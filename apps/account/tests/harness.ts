/**
 * Bộ khung mount cho test của `apps/account`.
 *
 * ⚠️ Component của app dùng những thứ **không tồn tại ngoài Nuxt runtime**: `useI18n()`
 * (auto-import), `NuxtLink`/`NuxtPage`, và các composable trong `app/composables/`.
 * Test không dựng cả Nuxt. Việc đó chia làm hai tầng:
 *
 * 1. `tests/nuxt-runtime-bridge.ts` cài các **global** (`useState`, `useCookie`,
 *    `useHead`, `useRoute`, `useNuxtApp`, `useI18n`) — và phải cài lúc **import**,
 *    không phải lúc mount, vì composable của app gọi `useState()` ngay ở phạm vi
 *    module.
 * 2. File này mount component, cấp `NuxtLink`/`NuxtPage`, và nối composer i18n
 *    vào cây component qua `global.plugins` (không có nó thì `useI18n()` ném "Not
 *    available in this context").
 *
 * `useI18n()` chạy trên **catalog thật** (không phải chuỗi giả): một test khẳng
 * định "trang này hiện câu tiếng Việt khi đổi locale" kiểm đúng câu chữ đã dịch.
 *
 * `onMounted` chạy thật (Vue không bỏ qua nó khi mount), nên `useAsyncState` nạp dữ
 * liệu thật trong test.
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type Component } from 'vue';

import type { AccountAdapter } from '../app/account-data/types';
import { createMockAccountAdapter } from '../app/account-data/mock-adapter';
import type { MockAdapterOptions } from '../app/account-data/mock-adapter';
import type { AccountLocale } from '../app/i18n/locale-registry';
// Import này có **side effect**: nó đăng ký global Nuxt và nối alias `#app`/`#i18n`.
// Phải nạp **trước** mọi component của app — xem `tests/nuxt-globals.ts` vì sao thứ tự đó
// bắt buộc. `import.meta.glob` bên trong cũng chỉ hoạt động sau bước import này.
import { accountStores, appComponents, i18n } from './nuxt-runtime-bridge';

export type AccountTestContext = {
  readonly wrapper: VueWrapper;
  readonly adapter: AccountAdapter;
  /** Đổi locale của `vue-i18n` đang mount — dùng để kiểm text đã dịch. */
  readonly setLocale: (locale: AccountLocale) => Promise<void>;
  /** Chờ mọi promise đang chờ rồi flush render. */
  readonly flush: () => Promise<void>;
  /** Mount lại từ đầu — dùng khi cần `open` của một dialog ở trạng thái đầu. */
  readonly remount: () => Promise<VueWrapper>;
  /** Đặt `useRoute()` trả về giá trị này cho các test đọc query. */
  readonly setRoute: (route: { path?: string; query?: Record<string, string | undefined> }) => void;
};

type MountOptions = {
  readonly adapter?: AccountAdapter;
  readonly adapterOptions?: MockAdapterOptions;
  readonly locale?: AccountLocale;
  /**
   * Route **trước** lúc mount.
   *
   * ⚠️ `setRoute` là không đủ cho mọi trang: `useAsyncState` nạp ở `onMounted`, nên một
   * trang đọc `route.query` sẽ thấy trống nếu query được đặt sau đó. `/consent` và
   * `/login` đều rơi vào loại đó — đặt route trước khi mount là cách duy nhất nói đúng
   * với chúng điều kiện mà chúng thực sự đọc.
   */
  readonly route?: { path?: string; query?: Record<string, string | undefined> };
  /** Props truyền cho component gốc. */
  readonly props?: Record<string, unknown>;
  /** Slot mặc định, dùng khi mount layout. */
  readonly slots?: Record<string, string>;
};

/**
 * Nuxt component tự đăng ký; ở test chúng được cấp tay. `NuxtLink` render thẻ `<a>`
 * để test kiểm được `href` thật — `to` là đường nội bộ không prefix locale.
 */
const nuxtStubs: Record<string, Component> = {
  ...appComponents,
  NuxtLink: {
    props: ['to', 'href', 'ariaCurrentValue'],
    template: '<a :href="to"><slot /></a>',
  },
  NuxtPage: { template: '<div data-testid="nuxt-page" />' },
  NuxtRouteAnnouncer: { template: '<span />' },
  NuxtLayout: { template: '<div><slot /></div>' },
  ClientOnly: { template: '<div><slot /></div>' },
};

/**
 * Mount một component của `apps/account` với đủ các global mà Nuxt cấp.
 *
 * ⚠️ State và cookie **không** được xoá ở đây: `account/composables` gọi `useState()`
 * ở phạm vi module, nên state phải sống lâu hơn một lần mount. Test cách ly bằng
 * `resetAccountStores()` trong `beforeEach` — xem `tests/setup.ts`.
 */
export async function mountAccount(
  component: Component,
  options: MountOptions = {},
): Promise<AccountTestContext> {
  const adapter = options.adapter ?? createMockAccountAdapter(options.adapterOptions ?? {});
  const composer = i18n.global as unknown as { locale: { value: AccountLocale } };
  composer.locale.value = options.locale ?? 'en';

  if (options.route !== undefined) {
    if (options.route.path !== undefined) {
      accountStores.route.path = options.route.path;
    }
    Object.assign(accountStores.route.query, options.route.query ?? {});
  }

  /**
   * Adapter test định nghĩa phải là adapter mà app dùng.
   *
   * `useAccountAdapter()` gắn adapter lần đầu vào `nuxtApp` và trả về chính nó ở mọi
   * lần gọi sau — đó là hợp đồng của nó (mọi trang phải thấy cùng một nguồn dữ liệu). Nên
   * test phải gắn **trước**: `mountAccount` sinh adapter của riêng nó, và nếu không gắn thì
   * component sẽ tự tạo một cái khác, test lại kiểm một adapter không ai dùng.
   */
  accountStores.nuxtApp.$accountAdapter = adapter;

  /**
   * Component của app dùng bằng **tên trần** `<AccountPageHeader>` — Nuxt đăng ký chúng
   * global. `nuxtStubs` (truyền qua `global.components` của `mount`, chứa `...appComponents`)
   * là đủ: `@vue/test-utils` gộp `global.components` vào chính app instance nên tên trần
   * phân giải cho **cả cây**, kể component con — không cần (và không nên) ghi thêm vào
   * `config.global.components` của test-utils: đó là singleton dùng chung cho worker,
   * side effect không được hoàn tác.
   *
   * ⚠️ Không có đăng ký này thì mọi component đó render thành thẻ rỗng **không báo lỗi**, và
   * khẳng định kiểu "trang này không có ô mật khẩu" sẽ pass vì cả trang không render gì.
   */

  const doMount = (): VueWrapper =>
    mount(component, {
      props: options.props ?? {},
      slots: options.slots ?? {},
      global: {
        components: nuxtStubs,
        plugins: [i18n],
      },
    });

  /**
   * Wrapper **hiện tại**.
   *
   * `remount()` thay nó, nên mọi closure của context đọc qua biến này thay vì giữ
   * một `wrapper` cũ trong scope — nếu không, `flush()` sau `remount()` sẽ chờ
   * render của cây đã unmount.
   */
  let current = doMount();

  // Chờ `onMounted` của `useAsyncState` và các promise adapter đã settle.
  await flushPromises(current);

  return {
    get wrapper() {
      return current;
    },
    adapter,
    setLocale: async (next: AccountLocale) => {
      composer.locale.value = next;
      await flushPromises(current);
    },
    flush: () => flushPromises(current),
    remount: async () => {
      await current.unmount();
      current = doMount();
      await flushPromises(current);
      return current;
    },
    /** Đặt `useRoute()` trả về giá trị này cho các test đọc query. */
    setRoute(route: { path?: string; query?: Record<string, string | undefined> }): void {
      if (route.path !== undefined) {
        accountStores.route.path = route.path;
      }
      if (route.query !== undefined) {
        Object.assign(accountStores.route.query, route.query);
      }
    },
  };
}

/**
 * Chờ một macrotask rồi flush render hai vòng.
 *
 * ⚠️ `setTimeout(0)` phải được **await**, không phải `void`: `void` huỷ promise
 * ngay nên hàm chỉ chờ microtask (hai `nextTick`), trong khi nhiều chuỗi async
 * thật resolve qua timer — assertion chạy trên trạng thái cũ rồi xanh nhầm, và
 * timer bị bỏ rơi vẫn fire sau khi test kết thúc.
 */
export async function flushPromises(wrapper?: VueWrapper): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await nextTick();
  await nextTick();
  if (wrapper !== undefined) {
    await wrapper.vm.$nextTick();
  }
}
