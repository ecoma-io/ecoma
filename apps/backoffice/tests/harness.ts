/**
 * Harness mount của `backoffice` với đủ global mà Nuxt cấp — **hai** lối vào:
 *
 * - `mountBackofficePage()` — mount **một page** với adapter chỉ định. Dùng cho test
 *   về dữ liệu (loading/ready/empty/error).
 * - `mountBackofficeApp()` / `renderBackofficeAppToHtml()` — mount **`app.vue`**
 *   (shell + `<NuxtPage />`) trên client và trên server. Dùng cho test hành vi
 *   **toàn app**: đổi ngôn ngữ ở runtime, bất biến của `runtime-locale.spec.ts`
 *   nằm ở chính `app.vue` — `useBackofficeI18n()` gọi một lần ở đó, nav và
 *   `useHead` cũng ở đó, `BackofficeLanguageSelect` nằm trong slot `actions`.
 *
 * ⚠️ Component của app dùng những thứ **không tồn tại ngoài Nuxt runtime**: `useI18n()`
 * qua alias `#i18n`, `useCookie`/`useState` qua alias `#app`, `useRoute()`/`useHead()`
 * và `onMounted()` dưới dạng tên trần (auto-import của Nuxt, không có import nào trong
 * SFC). Test không dựng cả Nuxt; việc đó chia làm ba tầng:
 *
 * 1. `tests/setup.ts` nạp `tests/nuxt-globals.ts` **trước** mọi module app — điều kiện
 *    để `app.vue` và `useAsyncState()` chạy `setup()` với global đã có mặt.
 * 2. `vitest.config.mts` nối alias `#app` vào `tests/nuxt-app-bridge.ts` và `#i18n` vào
 *    `tests/nuxt-i18n-bridge.ts`; hai module đó trả đúng bề mặt mà app import.
 * 3. File này mount, cấp component của `app/components/` theo tên trần, và nối composer
 *    i18n vào cây component qua `global.plugins` — không có nó thì `useI18n()` ném
 *    "Not available in this context".
 *
 * `useI18n()` chạy trên **catalog thật** (không phải chuỗi giả), nên một khẳng định về
 * câu chữ đã dịch kiểm đúng nội dung mà `app/i18n/locales/en.ts` khai.
 *
 * ⚠️ Adapter: **chỉ** `mountBackofficePage()` gắn adapter vào `nuxtApp` trước khi mount
 * (vì `useBackofficeAdapter()` dùng `??=` — không gắn thì trang tự tạo adapter thật
 * từ runtime config, `unavailable` ở môi trường test, fail-closed). `mountBackofficeApp()`
 * cố ý **không** gắn: test ở đó chỉ đọc câu chữ đã dịch, và các khẳng định không đi
 * qua nhánh dữ liệu nào.
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { createSSRApp, defineComponent, h, nextTick, type Component } from 'vue';
import { renderToString } from 'vue/server-renderer';

import App from '../app/app.vue';
import type { BackofficeDataAdapter } from '../app/backoffice-data/types';
import { createMockBackofficeAdapter } from '../app/backoffice-data/mock-adapter';
import { backofficeStores, i18n } from './nuxt-globals';
import { setNuxtApp } from './nuxt-app-state';

export type BackofficeTestContext = {
  readonly wrapper: VueWrapper;
  readonly adapter: BackofficeDataAdapter;
  /** Chờ mọi promise đang chờ rồi flush render. */
  readonly flush: () => Promise<void>;
};

type MountOptions = {
  /**
   * Adapter mà trang phải dùng.
   *
   * Bỏ trống thì harness dùng `createMockBackofficeAdapter()` trên fixture mặc định —
   * đủ cho test chỉ quan tâm dữ liệu có hiển thị hay không.
   */
  readonly adapter?: BackofficeDataAdapter;
};

/**
 * Component trong `app/components/` — Nuxt tự đăng ký chúng, nên `<BackofficePageHeader>`
 * dùng ở mọi trang mà không có import. Vitest không chạy qua đăng ký đó.
 *
 * ⚠️ `import.meta.glob` thay vì liệt kê tay: một component mới thêm vào `app/components/`
 * mà không khai ở đây sẽ render thành thẻ rỗng **không** báo lỗi — test vẫn xanh trong
 * khi trang mất hẳn một phần.
 *
 * ⚠️ `eager: true` cố ý: `import.meta.glob` biến mỗi key thành một `import()` riêng, và
 * import động như vậy chỉ resolve được **sau** khi cây component đã render.
 */
function componentName(file: string): string {
  const name = file.slice(file.lastIndexOf('/') + 1);
  return name.slice(0, name.length - '.vue'.length);
}

export const appComponents: Record<string, Component> = Object.fromEntries(
  Object.entries(
    import.meta.glob<{ default: Component }>('../app/components/*.vue', { eager: true }),
  ).map(([file, module]) => [componentName(file), module.default]),
);

/**
 * Nuxt component tự đăng ký; ở test chúng được cấp tay. `NuxtLink` render thẻ `<a>` để
 * test kiểm được `href` thật.
 */
const nuxtStubs: Record<string, Component> = {
  ...appComponents,
  NuxtLink: {
    props: ['to', 'href'],
    template: '<a :href="to"><slot /></a>',
  },
  NuxtPage: { template: '<div data-testid="nuxt-page" />' },
};

/**
 * Mount một page của `backoffice` với adapter chỉ định.
 *
 * Mount xong thì `flush()` một lần: `onMounted` của `useAsyncState` chạy sau lượt render
 * đầu, nên không chờ thì khẳng định đầu tiên đọc phải trạng thái trước khi adapter được
 * gọi. Trạng thái quan sát được ngay sau hàm này là `loading` **cộng** với việc
 * `listX()` đã được gọi.
 */
export async function mountBackofficePage(
  component: Component,
  options: MountOptions = {},
): Promise<BackofficeTestContext> {
  const adapter = options.adapter ?? createMockBackofficeAdapter();
  // Gắn trước mount: `useBackofficeAdapter()` dùng `??=` trên đúng slot này, nên adapter
  // test cấp sẽ là adapter duy nhất trang thấy. `resetNuxtAppBridge()` trong `beforeEach`
  // trả slot về rỗng giữa các test.
  setNuxtApp({ $backofficeAdapter: adapter });

  const wrapper = mount(component, {
    global: {
      components: nuxtStubs,
      plugins: [i18n],
    },
  });

  const flush = (): Promise<void> => flushPromises(wrapper);
  await flush();

  return { wrapper, adapter, flush };
}

/**
 * Chờ một macrotask rồi flush render hai vòng.
 *
 * ⚠️ `setTimeout(0)` ở đây là **ranh giới macrotask**, không phải một `sleep` tuỳ ý:
 * nó để mọi microtask đang chờ cạn trước khi assert, còn luồng điều khiển `Promise` của
 * test vẫn là deferred của `fake-adapter.ts` — không test nào dựa vào thời gian.
 *
 * ⚠️ Phải `await` nó: `void`/bỏ await chỉ chờ microtask, nên assertion chạy trên trạng
 * thái cũ và xanh nhầm.
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

export { backofficeStores, i18n };

/**
 * Phần tử thứ `index` (mặc định 0) của một mảng, và **ném** nếu không có.
 *
 * Dùng thay cho `list[index]` trong test: chỉ số sai — quên gọi adapter, gọi thiếu số
 * lần, hoặc fixture rỗng — thành một thông điệp nói rõ nguyên nhân tại đúng dòng đó,
 * thay vì `undefined` trôi tới một assertion xa hơn và báo lỗi ở chỗ không liên quan.
 */
export function at<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`không có phần tử thứ ${index + 1} (mảng có ${items.length} phần tử)`);
  }
  return item;
}

/* ----------------------------------------------------------------------------------
 * Mount `app.vue` — dùng cho test hành vi **toàn app** (đổi ngôn ngữ ở runtime).
 *
 * ⚠️ Vì sao cần đường riêng ngoài `mountBackofficePage()`: bất biến của
 * `runtime-locale.spec.ts` nằm ở chính `app.vue` — `useBackofficeI18n()` được gọi
 * một lần ở đó, nav và `useHead` cũng ở đó, `BackofficeLanguageSelect` nằm trong slot
 * `actions` của `AppShell`. Mount một page thay thế sẽ bỏ qua đúng những dòng cần
 * kiểm, và mount một bản sao dựng lại đường dây i18n thì kiểm một file không ai ship.
 *
 * ⚠️ **Không** gắn adapter ở đây: `mountBackofficePage()` gắn adapter vì test page
 * cần dữ liệu có kiểm soát, còn test ở đây chỉ đọc câu chữ đã dịch. Page vẫn dựng
 * adapter thật theo runtime config (fail-closed), và các khẳng định không đi qua
 * nhánh dữ liệu đó.
 * ------------------------------------------------------------------------------- */

/** Route trước lúc mount — xem `applyRoute()`. */
type RouteLike = { path?: string; query?: Record<string, string | undefined> };

export type AppMountOptions = {
  /** Page render trong `<NuxtPage />`. Mặc định là trang Overview (`pages/index.vue`). */
  readonly page?: Component;
  /**
   * Route mà app nhìn thấy trong lần render này. Mặc định `{ path: '/' }`.
   *
   * ⚠️ Phải **áp** giá trị này lên `route` của bridge trước khi mount: một tham số
   * nhận vào rồi bỏ qua sẽ khiến khẳng định "đổi ngôn ngữ giữ nguyên route" xanh
   * một cách rỗng — route đứng ở `/` cả trước lẫn sau, nên nó không phân biệt được
   * "được giữ nguyên" với "chưa bao giờ được đặt".
   */
  readonly route?: RouteLike;
};

/**
 * Đặt route của bridge theo yêu cầu mount.
 *
 * Route là **một** object `reactive` dùng chung cả file test (closure `useRoute()`
 * đã giữ nó), nên phải ghi vào chỗ chứ không thay tham chiếu — thay tham chiếu thì
 * component đang giữ object cũ và không thấy gì đổi.
 */
function applyRoute(route: RouteLike | undefined): void {
  backofficeStores.route.path = route?.path ?? '/';
  for (const key of Object.keys(backofficeStores.route.query)) {
    Reflect.deleteProperty(backofficeStores.route.query, key);
  }
  for (const [key, value] of Object.entries(route?.query ?? {})) {
    backofficeStores.route.query[key] = value;
  }
}

export type BackofficeAppContext = {
  readonly wrapper: VueWrapper;
  /** Chờ promise đang chờ (adapter, `useAsyncState`) rồi flush render. */
  readonly flush: () => Promise<void>;
  /** Mount lại từ đầu, giữ nguyên cookie/route đã đặt. */
  readonly remount: () => Promise<VueWrapper>;
};

/**
 * Component global của một lần mount `app.vue`.
 *
 * `NuxtPage` là stub render ra `page` truyền vào: `app.vue` render `<NuxtPage />`
 * không prop, nên closure là cách duy nhất chọn page mà không phải sửa `app.vue` cho
 * vừa test. `NuxtLink` dùng lại stub của `mountBackofficePage()` — nó render `href`
 * thật, thứ mà selector `a[href="/staff"]` dựa vào.
 */
function appGlobalComponents(page: Component): Record<string, Component> {
  return {
    ...nuxtStubs,
    NuxtPage: defineComponent({ name: 'NuxtPage', setup: () => () => h(page) }),
    NuxtRouteAnnouncer: defineComponent({ setup: () => () => h('span') }),
  };
}

/**
 * Mount `app.vue` với đủ global mà Nuxt cấp.
 *
 * ⚠️ Cookie và `useState` **không** được xoá ở đây: chúng phải sống qua nhiều lần
 * mount để kiểm "lựa chọn trong phiên thắng cookie". Test cách ly bằng
 * `resetBackofficeGlobals()` trong `beforeEach` — xem `tests/setup.ts`.
 */
export async function mountBackofficeApp(
  options: AppMountOptions = {},
): Promise<BackofficeAppContext> {
  const page = options.page ?? (await import('../app/pages/index.vue')).default;
  const components = appGlobalComponents(page);

  const doMount = (): VueWrapper => mount(App, { global: { components, plugins: [i18n] } });

  applyRoute(options.route);
  let current = doMount();
  await flushPromises(current);

  return {
    get wrapper() {
      return current;
    },
    flush: () => flushPromises(current),
    remount: async () => {
      await current.unmount();
      current = doMount();
      await flushPromises(current);
      return current;
    },
  };
}

/**
 * Render `app.vue` trên **server** và trả HTML đã render.
 *
 * ⚠️ Vì sao cần đường riêng: mount trong jsdom là render phía client — mọi khẳng
 * định trên DOM sau mount đều có thể xanh nhờ client tự sửa sau hydrate, đúng cái
 * bẫy mà test SSR phải tránh. `renderToString` không có client nào cả, nên văn bản
 * tìm thấy trong chuỗi HTML **chỉ** có thể đến từ server.
 *
 * ⚠️ Đầu ra là **fragment của app**, không phải một document: không có
 * `<!DOCTYPE html>` và không có thẻ `<html>` (document template do Nuxt dựng, nằm
 * ngoài phạm vi unit test). Nên `<html lang>` được khẳng định ở tầng `useHead`
 * (`headHtmlAttrs()`), không phải bằng cách grep chuỗi HTML — xem
 * `app-locale.spec.ts` (cùng thư mục `app/`).
 *
 * ⚠️ `renderToString` cần resolve được `vue/server-renderer` — subpath export của
 * chính `vue`, không phải dependency mới.
 */
export async function renderBackofficeAppToHtml(options: AppMountOptions = {}): Promise<string> {
  const page = options.page ?? (await import('../app/pages/index.vue')).default;

  applyRoute(options.route);
  const app = createSSRApp(App);
  app.use(i18n);
  for (const [name, component] of Object.entries(appGlobalComponents(page))) {
    app.component(name, component);
  }

  return renderToString(app);
}
