/**
 * Global Nuxt cho test, cài **trước** khi bất kỳ module app nào được nạp.
 *
 * ⚠️ File này **không** import gì từ `app/composables/` hay `app/utils/` — chính điều
 * đó là điều kiện để nó chạy được. `use-account-preferences.ts` gọi `useState()` lúc
 * module được nạp, nên global phải có mặt trước bước import đó. Tách thành hai file
 * giữ được thứ tự: `nuxt-runtime-bridge.ts` import file này **trước**, rồi mới import
 * composable của app.
 *
 * ⚠️ Vì sao không trỏ `#app` vào `nuxt/dist/app` thật: module đó tự dựng context Nuxt
 * riêng, tách khỏi state mà test kiểm soát. Khi đó `useState` trong component đọc một
 * store khác, `useCookie` ghi vào store khác, và khẳng định kiểu "đổi locale thì
 * `htmlAttrs.lang` đổi theo" sẽ đọc một object rỗng rồi pass nhầm.
 *
 * ⚠️ Vì sao không trỏ `#i18n` vào `dist/runtime/composables` của `@nuxtjs/i18n`:
 * entrypoint đó `export * from "vue-i18n"` **nhưng còn import `#imports`**, mà
 * `#imports` chỉ có trong Nuxt runtime — nên nó không load được ngoài Nuxt.
 *
 * Đây là **global của test**, không phải của production: `vitest.config.mts` chỉ gắn
 * alias `#app`/`#i18n` vào bridge lúc test, build của Nuxt vẫn dùng alias gốc.
 */
import {
  computed,
  nextTick,
  onMounted,
  reactive,
  readonly,
  ref,
  watch,
  watchEffect,
  type Ref,
} from 'vue';
import { createI18n, useI18n as vueI18nUseI18n } from 'vue-i18n';

import en from '../app/i18n/locales/en';
import vi from '../app/i18n/locales/vi';
import zhCN from '../app/i18n/locales/zh-CN';
import { DEFAULT_ACCOUNT_LOCALE } from '../app/i18n/locale-registry';

/**
 * Một composer `vue-i18n` dùng chung cho mọi test trong một file, chạy trên **catalog
 * thật** chứ không phải chuỗi giả: khẳng định "trang này hiện câu tiếng Việt khi đổi
 * locale" kiểm đúng câu chữ đã dịch, chứ không chỉ kiểm `t()` được gọi.
 *
 * `fallbackLocale` là `DEFAULT_ACCOUNT_LOCALE` và `missingWarn: false` là chính đáng:
 * catalog thiếu key là lỗi của `catalogs.spec.ts`, không phải cảnh báo mỗi lần render.
 *
 * Ở mode `legacy: false`, `createI18n()` trả chính composer có `install()` — nó KHÔNG
 * phải `{ install, useI18n }` như ở chế độ legacy. Component gọi `useI18n()` (auto-import
 * của Nuxt), nên `globalThis.useI18n` phải là hàm mà `vue-i18n` export, chứ không phải
 * `i18n.useI18n`.
 */
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: DEFAULT_ACCOUNT_LOCALE,
  fallbackLocale: DEFAULT_ACCOUNT_LOCALE,
  missingWarn: false,
  fallbackWarn: false,
  messages: { en, vi, 'zh-CN': zhCN },
});

const store = new Map<string, unknown>();
const cookies = new Map<string, unknown>();
const head = { value: {} as Record<string, unknown> };
const nuxtApp: Record<string, unknown> = { payload: { state: {} }, _state: {} };
/**
 * Route là `reactive` như vue-router thật: trang đọc `route.query` qua `computed`
 * và `watch` phải invalidate khi `setRoute` đổi query giữa chừng (ví dụ consent
 * nạp lại context khi handle đổi). Object phẳng thì computed không theo dõi
 * được và watch không bao giờ fire — test sẽ xanh nhầm cho một trang cũ.
 */
const route = reactive({
  path: '/',
  query: {} as Record<string, string | undefined>,
});

const container = globalThis as Record<string, unknown>;

container.useI18n = vueI18nUseI18n;
container.useI18nEx = vueI18nUseI18n;

/**
 * `useState` của Nuxt trả **cùng một `Ref`** cho mọi lần gọi cùng key, và ghi vào
 * `.value` phải đi vào ref đó.
 *
 * ⚠️ Bản mock cũ trả `{ value: store.get(name) }` — một object mới mỗi lần gọi,
 * `value` là giá trị **sao chụp** lúc gọi. Ghi `state.value = x` chỉ đổi object
 * tạm, không ghi vào store và không kích hoạt render: `useAccountPreferences`
 * cache bằng `preferences.value ??= await load()` còn `useAccountFormat` đọc
 * `useState` **lần hai** — dưới mock cũ cả hai ghi/đọc hư không, nên "định dạng
 * theo preference đã lưu" không bao giờ được kiểm, mọi test timezone đều kiểm
 * nhánh fallback `UTC` mà không biết. Ref thật trong map sửa đúng hợp đồng của
 * Nuxt: cùng key = cùng ref = reactive.
 */
container.useState = <T>(key?: string, init?: () => T): Ref<T> => {
  const name = key ?? '__auto';
  let slot = store.get(name) as Ref<T> | undefined;
  if (slot === undefined) {
    slot = ref(init === undefined ? undefined : init()) as Ref<T>;
    store.set(name, slot);
  }
  return slot;
};
container.useCookie = <T>(key: string): { value: T } => ({
  get value(): T {
    return cookies.get(key) as T;
  },
  set value(next: T) {
    cookies.set(key, next);
  },
});
container.useHead = (input: Record<string, unknown>): void => {
  head.value = { ...head.value, ...input };
};
container.useRoute = (): typeof route => route;
container.useRouter = (): { push: () => Promise<void>; replace: () => Promise<void> } => ({
  push: async () => undefined,
  replace: async () => undefined,
});
container.useNuxtApp = (): typeof nuxtApp => nuxtApp;
container.useRuntimeConfig = (): { public: Record<string, unknown> } => ({ public: {} });

/**
 * `useAsyncData` tối giản cho test: chạy handler **ngay** và trả `data`/`pending`
 * dạng `Ref`. Shell (`useAccountShellPreferences`) dùng nó để nạp preference lúc
 * dựng app; test không cần cơ chế dedupe/payload của Nuxt thật, chỉ cần handler
 * chạy thật và state đọc được sau `flushPromises`.
 */
container.useAsyncData = <T>(
  _key: string,
  handler: () => Promise<T>,
): {
  data: Ref<T | undefined>;
  pending: Ref<boolean>;
  error: Ref<unknown>;
  refresh: () => Promise<void>;
} => {
  const data = ref<T | undefined>(undefined) as Ref<T | undefined>;
  const pending = ref(true);
  const error = ref<unknown>(undefined);
  const refresh = async (): Promise<void> => {
    pending.value = true;
    try {
      data.value = await handler();
      error.value = undefined;
    } catch (caught) {
      error.value = caught;
    } finally {
      pending.value = false;
    }
  };
  void refresh();
  return { data, pending, error, refresh };
};
// `definePageMeta` là macro của Nuxt lúc build và bị gọi lúc setup, nên một hàm rỗng là
// đủ ở đây — test không khẳng định gì về meta page.
container.definePageMeta = (): void => undefined;

for (const [name, value] of Object.entries({
  ref,
  computed,
  watch,
  watchEffect,
  onMounted,
  readonly,
  nextTick,
})) {
  container[name] = value;
}

/**
 * Store của harness, để test đọc trạng thái `useState`, cookie đã ghi và `htmlAttrs`
 * mà `useAccountI18n()` đặt.
 */
export const accountStores = { store, cookies, head, nuxtApp, route } as const;

/** Global Nuxt mà bridge và app đều đọc — dùng cho cả lúc cài lẫn lúc dọn. */
export const NUXT_GLOBALS = [
  'useI18n',
  'useI18nEx',
  'useState',
  'useCookie',
  'useHead',
  'useRoute',
  'useRouter',
  'useNuxtApp',
  'useRuntimeConfig',
  'useAsyncData',
  'definePageMeta',
] as const;

/** Vue API mà `<script setup>` của Nuxt nhận qua auto-import. */
export const VUE_GLOBALS = [
  'ref',
  'computed',
  'watch',
  'watchEffect',
  'onMounted',
  'readonly',
  'nextTick',
] as const;

/**
 * App code chỉ dùng `NuxtApp` như **kiểu** (`import { type NuxtApp } from '#app'`), nên ở
 * test nó không cần giá trị runtime. Khai đúng tên để kiểu của
 * `use-account-adapter.ts` không đổi giữa app và test.
 */
export type NuxtApp = Record<string, unknown>;

/** Xoá toàn bộ trạng thái test — gọi trong `beforeEach`, xem `tests/setup.ts`. */
export function resetAccountGlobals(): void {
  store.clear();
  cookies.clear();
  head.value = {};
  route.path = '/';
  // `Object.assign(route.query, {})` KHÔNG xoá gì: nguồn rỗng không ghi đè key
  // đang tồn tại, nên query của test trước (vd `client_id=attacker-app`) tràn sang
  // test sau và làm chúng xanh dù trang render nhầm giá trị đó. Vòng xoá key
  // giữ nguyên tính danh của object `route` — closure `useRoute()` đã giữ nó.
  for (const key of Object.keys(route.query)) {
    Reflect.deleteProperty(route.query, key);
  }
  nuxtApp.$accountAdapter = undefined;
  nuxtApp.$accountPreferencesLoad = undefined;
}

/** Gỡ global của test. Không bắt buộc — vitest cách ly từng file. */
export function uninstallNuxtGlobals(extraGlobals: readonly string[] = []): void {
  for (const name of [...NUXT_GLOBALS, ...VUE_GLOBALS, ...extraGlobals]) {
    Reflect.deleteProperty(container, name);
  }
  resetAccountGlobals();
}
