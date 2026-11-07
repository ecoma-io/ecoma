/**
 * Global Nuxt cho test của `pact-broker-app` — cài khi module này được nạp.
 *
 * ⚠️ Điều kiện thật mà file này phải giữ là: global có mặt **trước khi bất kỳ
 * component `setup()` nào chạy** — `onMounted` gọi trong thân hàm composable,
 * tức lúc composable chạy trong `setup()`, không phải lúc module được nạp —
 * và trước khi bất kỳ module app nào đọc `globalThis`. `tests/setup.ts` import
 * file này; vitest chạy setup file trước mọi test file, nên thứ tự đó được bảo
 * đảm ở đấy chứ không phải bằng cách sắp import trong file này.
 *
 * ⚠️ File này **không** import gì từ `app/` ngoài các file i18n thuần (`catalogs`,
 * `locales/*`, `locale-registry`) — những file không gọi composable nào, nên việc
 * nạp chúng không đòi global nào đã tồn tại.
 *
 * ⚠️ Vì sao không trỏ `#app` vào `nuxt/dist/app` thật: module đó tự dựng context
 * Nuxt riêng, tách khỏi state mà test kiểm soát, nên `useNuxtApp()` trong component
 * trả một object khác object mà test gắn vào — và mọi test page sẽ xanh nhầm.
 * Cùng lý do, entrypoint runtime của `@nuxtjs/i18n` còn import `#imports` nên
 * không load được ngoài Nuxt.
 *
 * ⚠️ Đây là **global của test**, không phải của production: `vitest.config.mts` chỉ
 * gắn alias `#app`/`#i18n` vào bridge lúc test; build của Nuxt vẫn dùng alias gốc.
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

import { pactBrokerMessages } from '../app/i18n/catalogs';
import { DEFAULT_PACT_BROKER_LOCALE } from '../app/i18n/locale-registry';
import { readNuxtApp, readRuntimeConfig } from './nuxt-app-state';

/**
 * Composer `vue-i18n` chạy trên **catalog thật** của app, không phải chuỗi giả.
 * `messages` là chính `pactBrokerMessages` mà `app/i18n/vue-i18n.config.ts` dùng —
 * cùng một object, không phải bản sao; thêm một locale là thêm một lần ở một chỗ.
 *
 * `missingWarn`/`fallbackWarn` tắt ở đây khác `app/i18n/vue-i18n.config.ts` (nơi cả
 * hai đều bật): chốt chặn cấu trúc của key là `tests/catalogs.spec.ts`, còn chốt
 * chặn runtime — key dựng động — là spec của từng trang. Bật cảnh báo ở đây chỉ
 * làm mỗi lần render một trang in ra vài dòng nhiễu, không làm key thiếu trở nên
 * đỏ.
 *
 * Ở mode `legacy: false`, `createI18n()` trả chính composer có `install()` — không
 * phải `{ install, useI18n }` như ở chế độ legacy. Component gọi `useI18n()`
 * (auto-import của Nuxt), nên `globalThis.useI18n` phải là hàm mà `vue-i18n` export.
 */
export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: DEFAULT_PACT_BROKER_LOCALE,
  fallbackLocale: DEFAULT_PACT_BROKER_LOCALE,
  missingWarn: false,
  fallbackWarn: false,
  messages: pactBrokerMessages,
});

const store = new Map<string, unknown>();
const cookies = new Map<string, unknown>();

/**
 * Mọi lệnh điều hướng app phát ra trong lúc test, theo thứ tự.
 *
 * ⚠️ Đây là **thiết bị đo** của bất biến "đổi ngôn ngữ không điều hướng": nếu ai
 * đó đổi locale bằng `navigateTo`/`router.push`, mảng này có phần tử. Không có nó
 * thì một mutation như vậy không lộ ra ở đâu cả — `route` của stub đứng yên vì
 * stub không điều hướng thật, và một test chỉ so `route` trước/sau sẽ xanh nhầm.
 */
const navigations: string[] = [];

/**
 * Route là `reactive` như vue-router thật, để `computed`/`watch` đọc `route.query`
 * invalidate khi test đổi query giữa chừng — object phẳng thì watch không bao giờ
 * fire và test sẽ xanh nhầm cho một trang cũ.
 */
const route = reactive({
  path: '/',
  query: {} as Record<string, string | undefined>,
});

const container = globalThis as Record<string, unknown>;

/**
 * `useState` của Nuxt trả **cùng một `Ref`** cho mọi lần gọi cùng key, và ghi vào
 * `.value` phải đi vào chính ref đó.
 *
 * ⚠️ Trả `{ value: store.get(name) }` là một object mới mỗi lần gọi, với `value` là
 * giá trị **sao chụp** lúc gọi: ghi `state.value = x` chỉ đổi object tạm và không
 * kích hoạt render. Ref thật trong map giữ đúng hợp đồng của Nuxt — cùng key, cùng
 * ref, reactive.
 */
export const useState = <T>(key?: string, init?: () => T): Ref<T> => {
  const name = key ?? '__auto';
  let slot = store.get(name) as Ref<T> | undefined;
  if (slot === undefined) {
    slot = ref(init === undefined ? undefined : init()) as Ref<T>;
    store.set(name, slot);
  }
  return slot;
};

/**
 * `useCookie` của Nuxt trả một `Ref` phản ứng được, và app dựa vào đúng tính đó:
 * `app.vue` đọc cookie trong một `computed` (`preferences`) rồi ghi lại trong
 * `updatePreferences()`. Trả một object thường với getter/setter trên `Map` sẽ
 * khiến `computed` cache lần đọc đầu và **không bao giờ** invalidate — đổi
 * theme/direction qua shell không cập nhật DOM lẫn `<html lang>`, và test xanh
 * nhầm. Ref thật trong map giữ hợp đồng của Nuxt: cùng key, cùng ref, reactive.
 *
 * ⚠️ Khác Nuxt ở hai điểm, có chủ ý: bỏ qua `options` (trừ `default`, dùng làm giá
 * trị đầu) và không mã hoá/giải mã `encode`/`decode` — cookie ở đây là state
 * trong bộ nhớ, không đi qua HTTP header.
 */
export const useCookie = <T>(key: string, options?: { default?: () => T }): Ref<T | undefined> => {
  let slot = cookies.get(key) as Ref<T | undefined> | undefined;
  if (slot === undefined) {
    slot = ref(options?.default === undefined ? undefined : options.default()) as Ref<
      T | undefined
    >;
    cookies.set(key, slot);
  }
  return slot;
};

/** Input của một lần gọi `useHead`, giữ nguyên dạng app truyền vào. */
type HeadInput = Record<string, unknown> | (() => Record<string, unknown>);

/** Mọi lần app gọi `useHead`, theo thứ tự — xem `documentHead()`. */
const headInputs: HeadInput[] = [];

/** Giải một input thành object, **ném** nếu dạng không hỗ trợ. */
function resolveHeadInput(input: HeadInput): Record<string, unknown> {
  const resolved = typeof input === 'function' ? input() : input;
  if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new Error(
      `useHead của test chỉ nhận object hoặc hàm trả object; nhận ${typeof resolved}`,
    );
  }
  return resolved;
}

/**
 * `useHead` của Nuxt nhận **object hoặc hàm trả object**, và app dùng dạng hàm
 * (`app.vue`: `useHead(() => ({ htmlAttrs, bodyAttrs }))`). Bản giả chỉ nhận object
 * phẳng sẽ trải một hàm ra thành `{}` — không ném lỗi, chỉ ghi sai — nên test khẳng
 * định `<html lang>` sẽ đọc object rỗng và xanh/đỏ vì lý do sai.
 *
 * ⚠️ Input được **giữ nguyên và giải lại mỗi lần đọc** (`documentHead()`), không
 * phải chụp một lần lúc gọi: dạng hàm của unhead chính là cơ chế để nó đọc lại khi
 * dependency đổi, và `app.vue` dựa vào đúng điều đó — `lang` lấy từ
 * `language.value`, nên sau khi người dùng đổi ngôn ngữ, lần đọc sau phải thấy
 * `lang` mới. Chụp ảnh lúc gọi thì khẳng định `lang` sau khi đổi ngôn ngữ không
 * đo được gì cả.
 *
 * ⚠️ Giới hạn đã đo, không được đọc quá lời: `headHtmlAttrs()` là **object `app.vue`
 * truyền cho `useHead`**, đúng thứ Nuxt đọc để ghi ra thẻ `<html>`. Nó **không**
 * chứng minh unhead đã ghi `<html lang="…">` vào DOM: không plugin unhead nào chạy
 * trong test này, và `renderToString` chỉ render fragment của app nên đầu ra không
 * có thẻ `<html>`. Muốn chứng minh vế DOM thì phải chạy Nuxt thật, nằm ngoài phạm vi
 * unit test.
 *
 * Lỗi dạng input (mảng, `null`, kiểu lạ) được ném **ngay lúc gọi** thay vì bỏ qua
 * im lặng, để một `useHead` viết sai chết tại chỗ chứ không âm thầm ghi rỗng.
 */
const testUseHead = (input: unknown): void => {
  const candidate = input as HeadInput;
  // Gọi thử một lần để dạng hàm cũng bị kiểm ngay lúc gọi, không đợi tới lần đọc.
  resolveHeadInput(candidate);
  headInputs.push(candidate);
};

/**
 * Thuộc tính document mà app đặt qua `useHead`: giá trị hiện tại của mọi lần gọi,
 * đã giải hàm và gộp theo thứ tự đăng ký — cùng cách unhead gộp nhiều `useHead`.
 */
export function documentHead(): Record<string, unknown> {
  return headInputs.reduce<Record<string, unknown>>(
    (acc, input) => ({ ...acc, ...resolveHeadInput(input) }),
    {},
  );
}

/** `htmlAttrs` mà app đặt cho `<html>` — nơi `lang` được khai. */
export function headHtmlAttrs(): Record<string, unknown> {
  return (documentHead()['htmlAttrs'] as Record<string, unknown> | undefined) ?? {};
}

const testUseRoute = (): typeof route => route;

const testUseRouter = (): {
  push: (to: unknown) => Promise<void>;
  replace: (to: unknown) => Promise<void>;
} => ({
  push: (to: unknown) => {
    navigations.push(String(to));
    return Promise.resolve();
  },
  replace: (to: unknown) => {
    navigations.push(String(to));
    return Promise.resolve();
  },
});

/**
 * `navigateTo` của Nuxt — cùng vai trò **thiết bị đo** như `testUseRouter`: ghi lại
 * lệnh điều hướng thay vì thực hiện. App hiện không gọi nó (đó là bất biến cần
 * ghim: đổi ngôn ngữ không được điều hướng), nên đây là tripwire cho một regression
 * thêm nó vào — nếu không cài, regression ném `ReferenceError`, còn cài thì đỏ kèm
 * mảng `navigations` nói rõ đã điều hướng tới đâu.
 */
const testNavigateTo = (to: unknown): Promise<unknown> => {
  navigations.push(String(to));
  return Promise.resolve(to);
};

// `definePageMeta` là macro của Nuxt lúc build và chạy lúc setup, nên một hàm rỗng là
// đủ: test không khẳng định gì về page meta. Khai ở đây để một page thêm macro này
// không chết bằng `ReferenceError` khó đọc.
const testDefinePageMeta = (): void => undefined;

/**
 * Cài toàn bộ global Nuxt/Vue lên `globalThis` — và mọi phép gán global đều nằm trong
 * hàm này, không rải ở phạm vi module.
 *
 * ⚠️ Gom vào một hàm để `resetPactBrokerGlobals()` **gọi lại được**. Một spec có thể
 * xoá `useRoute`/`useCookie`/`useState` khỏi `globalThis` bằng `Reflect.deleteProperty`
 * trong `finally`, và `vi.unstubAllGlobals()` **không** phục hồi key bị xoá tay — nó
 * chỉ undo `vi.stubGlobal`. Không cài lại thì từ test đó về sau mọi test cùng file đã
 * mất global, và một component gọi `useCookie()` sẽ ném `ReferenceError` khó đọc thay
 * vì lỗi thật của test.
 *
 * ⚠️ `useNuxtApp`/`useRuntimeConfig` **không** có state riêng ở đây: chúng đọc state
 * của `nuxt-app-state.ts`, cùng nguồn với `#app` (xem `tests/nuxt-app-bridge.ts`). Hai
 * nguồn song song thì `setNuxtApp()`/`setRuntimeConfig()` và global mà page mount đọc
 * sẽ nói hai chuyện khác nhau.
 *
 * Mọi giá trị được gán đều là hằng số cấp module, nên gọi lại bao nhiêu lần cũng cho
 * đúng một bộ hàm, cùng identity — hàm này idempotent. Nhờ đó hai đường vào
 * (`globalThis` và re-export cho `tests/nuxt-app-bridge.ts`) không thể lệch nhau.
 */
export function installPactBrokerGlobals(): void {
  container.useI18n = vueI18nUseI18n;
  container.useState = useState;
  container.useCookie = useCookie;
  container.useHead = testUseHead;
  container.useRoute = testUseRoute;
  container.useRouter = testUseRouter;
  container.useNuxtApp = readNuxtApp;
  container.useRuntimeConfig = readRuntimeConfig;
  container.navigateTo = testNavigateTo;
  container.definePageMeta = testDefinePageMeta;

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
}

installPactBrokerGlobals();

/**
 * Store của harness — test đọc cookie đã ghi, `head` mà app đặt, route và các lệnh
 * điều hướng đã phát ra.
 *
 * ⚠️ `head` là một **view đọc**, không phải nơi chứa ảnh chụp: `value` giải lại các
 * lần gọi `useHead` ở thời điểm đọc — xem `documentHead()`. Nguồn thật là
 * `headInputs`.
 */
export const pactBrokerStores = {
  store,
  cookies,
  head: {
    get value(): Record<string, unknown> {
      return documentHead();
    },
  },
  route,
  navigations,
} as const;

/**
 * Global Nuxt mà app gọi **không qua import** (auto-import của Nuxt).
 *
 * ⚠️ Đây là bề mặt global của test, không phải bề mặt module `#app`: `useCookie` và
 * `useState` có mặt vì Nuxt auto-import chúng, còn app import tường minh từ `#app`
 * (xem `tests/nuxt-app-bridge.ts`). `tests/harness.spec.ts` ghim từng tên là hàm
 * trên `globalThis`.
 *
 * ⚠️ `navigateTo` có mặt dù app **không** gọi nó: nó là tripwire cho bất biến "đổi
 * ngôn ngữ không điều hướng" (xem `testNavigateTo`) — không có nó thì ngày ai thêm
 * một lệnh điều hướng vào luồng đổi locale, không phép đo nào ghi lại được.
 *
 * ⚠️ Cố ý **không** có `useAsyncData`/`useFetch`. App đọc dữ liệu qua `fetch('/api/
 * broker/...')` trong `useAsyncState`, và một bản giả ở đây sẽ che mất hành vi thật
 * (network, lỗi JSON) đúng ở chỗ mà test nên thất bại rõ ràng nếu page đổi cách nạp.
 */
export const NUXT_GLOBALS = [
  'useI18n',
  'useState',
  'useCookie',
  'useHead',
  'useRoute',
  'useRouter',
  'useNuxtApp',
  'useRuntimeConfig',
  'navigateTo',
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
 * Xoá trạng thái **của file này** — gọi trong `beforeEach`, xem `tests/setup.ts`.
 *
 * ⚠️ Phải **cài lại global** trước khi xoá state, không phải chỉ dọn state:
 * một spec có thể xoá key khỏi `globalThis` bằng `Reflect.deleteProperty`, và
 * `vi.unstubAllGlobals()` không phục hồi key bị xoá tay — xem
 * `installPactBrokerGlobals()`.
 *
 * ⚠️ Locale của composer phải được đặt lại: `i18n` là singleton cấp module, sống lâu
 * hơn mọi test, còn `usePactBrokerI18n()` ghi `i18n.locale.value` trong `watchEffect`
 * — một test đổi ngôn ngữ sẽ để lại locale đó cho test sau và làm mọi khẳng định trên
 * catalog `en` phụ thuộc thứ tự chạy.
 */
export function resetPactBrokerGlobals(): void {
  installPactBrokerGlobals();
  store.clear();
  cookies.clear();
  // `headInputs` là nguồn thật của `pactBrokerStores.head.value`, nên xoá nó là đủ:
  // lần đọc sau trả `{}`, đúng trạng thái "app chưa gọi `useHead` lần nào".
  headInputs.length = 0;
  navigations.length = 0;
  route.path = '/';
  // `Object.assign(route.query, {})` KHÔNG xoá gì: nguồn rỗng không ghi đè key đang
  // tồn tại, nên query của test trước tràn sang test sau. Vòng xoá key giữ nguyên
  // tính danh của object `route` — closure `useRoute()` đã giữ nó.
  for (const key of Object.keys(route.query)) {
    Reflect.deleteProperty(route.query, key);
  }
  i18n.global.locale.value = DEFAULT_PACT_BROKER_LOCALE;
}
