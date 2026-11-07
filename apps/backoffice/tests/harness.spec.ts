/**
 * Ghim hợp đồng của chính harness — những chỗ mà bản giả **phải** hành xử như Nuxt, vì
 * test của page/composable dựa vào chúng mà không tự kiểm lại: bề mặt global, bề mặt
 * của hai module được alias (`#app`, `#i18n`), composer i18n, `useCookie`, `useHead`,
 * và việc dọn dẹp giữa các test.
 *
 * Không có file này thì một bản giả sai vẫn để mọi test khác xanh: đây đúng là loại
 * false-pass mà cả nhánh F3 muốn chặn, chỉ ở tầng thấp hơn một bậc.
 */
import { defineComponent, nextTick, onUnmounted } from 'vue';
import { describe, expect, it } from 'vitest';

import { createFakeBackofficeAdapter } from './fake-adapter';
import { mountBackofficePage } from './harness';
import * as appBridge from './nuxt-app-bridge';
import { setNuxtApp } from './nuxt-app-state';
import {
  NUXT_GLOBALS,
  VUE_GLOBALS,
  backofficeStores,
  i18n,
  resetBackofficeGlobals,
} from './nuxt-globals';
import * as i18nBridge from './nuxt-i18n-bridge';

const DEFAULT_LOCALE = 'en';

describe('harness — global surface', () => {
  it('every name in NUXT_GLOBALS and VUE_GLOBALS is installed as a function', () => {
    const notInstalled = [...NUXT_GLOBALS, ...VUE_GLOBALS].filter(
      (name) => typeof (globalThis as Record<string, unknown>)[name] !== 'function',
    );

    expect(notInstalled).toEqual([]);
  });

  it('resetBackofficeGlobals reinstalls every harness global a prior test deleted', () => {
    const container = globalThis as Record<string, unknown>;
    // `adapter-composable.spec.ts` xoá `useRoute`/`useCookie`/`useState` bằng
    // `Reflect.deleteProperty` trong `finally`, và `vi.unstubAllGlobals()` **không**
    // phục hồi key bị xoá tay — nó chỉ undo `vi.stubGlobal`. Không cài lại thì từ test
    // đó về sau mọi test cùng file mất global, và component gọi `useCookie()` ném
    // `ReferenceError` khó đọc thay vì lỗi thật của test.
    for (const name of [...NUXT_GLOBALS, ...VUE_GLOBALS]) {
      Reflect.deleteProperty(container, name);
    }

    resetBackofficeGlobals();

    expect(
      [...NUXT_GLOBALS, ...VUE_GLOBALS].filter((name) => typeof container[name] !== 'function'),
    ).toEqual([]);
  });
});

describe('harness — surfaces of the two aliased modules', () => {
  it('the `#app` bridge exports exactly the names the app imports from `#app`', () => {
    // Danh sách này là bề mặt app thật sự import, không phải bản sao của
    // `NUXT_GLOBALS`: `useNuxtApp`/`useRuntimeConfig` đến từ
    // `composables/use-backoffice-adapter.ts`, `useCookie`/`useState` từ
    // `composables/use-backoffice-locale.ts`. Thiếu một tên thì lỗi chỉ hiện ra lúc
    // chạy test, ở tầng module resolution ("does not provide an export named ...").
    const exported: Record<string, unknown> = {
      useNuxtApp: appBridge.useNuxtApp,
      useRuntimeConfig: appBridge.useRuntimeConfig,
      useCookie: appBridge.useCookie,
      useState: appBridge.useState,
    };
    const missing = ['useNuxtApp', 'useRuntimeConfig', 'useCookie', 'useState'].filter(
      (name) => typeof exported[name] !== 'function',
    );

    expect(missing).toEqual([]);
  });

  it('the `#i18n` bridge exports `useI18n`, the only name the app takes from `#i18n`', () => {
    expect(typeof i18nBridge.useI18n).toBe('function');
  });

  it('global `useNuxtApp` and the `#app` bridge read the same state', () => {
    const { adapter } = createFakeBackofficeAdapter();
    setNuxtApp({ $backofficeAdapter: adapter });

    // Nếu `nuxt-globals.ts` giữ state `nuxtApp` riêng thì đây là hai nguồn: harness gắn
    // adapter vào nguồn này, page (đi qua `#app`) đọc nguồn kia và tự tạo adapter thật —
    // và mọi test page vẫn xanh trong khi kiểm một adapter không ai dùng.
    const viaGlobal = (globalThis as Record<string, unknown>).useNuxtApp as () => {
      $backofficeAdapter?: unknown;
    };

    expect(appBridge.useNuxtApp().$backofficeAdapter).toBe(adapter);
    expect(viaGlobal().$backofficeAdapter).toBe(adapter);
  });
});

describe('harness — composer i18n', () => {
  it('every test starts at the default locale', () => {
    expect(i18n.global.locale.value).toBe(DEFAULT_LOCALE);
  });

  it('resetBackofficeGlobals restores the default locale with no leftover from the previous test', () => {
    // `i18n` là singleton cấp module: nếu reset không đặt lại `locale`, test đứng sau
    // trong cùng file sẽ chạy trên catalog `vi` và mọi khẳng định dựa trên `en` (như
    // `page-data-states.spec.ts`) trôi theo thứ tự chạy.
    i18n.global.locale.value = 'vi';

    resetBackofficeGlobals();

    expect(i18n.global.locale.value).toBe(DEFAULT_LOCALE);
  });
});

describe('harness — useCookie', () => {
  it('returns the same Ref per key, honours `default`, and a write updates the computed', async () => {
    const Stub = defineComponent({
      setup() {
        const first = useCookie<{ theme: string }>('prefs', {
          default: () => ({ theme: 'light' }),
        });
        const second = useCookie<{ theme: string }>('prefs');
        const theme = computed(() => first.value?.theme ?? 'không có');
        // Ghi qua hàm, đúng cách `app.vue` ghi (`updatePreferences`): đọc `vm.first`
        // từ ngoài sẽ nhận **giá trị đã unwrap**, không phải chính `Ref`.
        const setTheme = (next: string): void => {
          first.value = { theme: next };
        };
        return { setTheme, theme, sameRef: first === second };
      },
      template: '<div data-testid="theme">{{ theme }}</div>',
    });

    const { wrapper } = await mountBackofficePage(Stub);

    // `default` của Nuxt là giá trị đầu của cookie, không phải `undefined`.
    expect(wrapper.vm.theme).toBe('light');
    // Cùng key → cùng ref: đây là tính chất `app.vue` dựa vào để `computed` thấy
    // `cookie.value` đổi thay vì cache lần đọc đầu.
    expect(wrapper.vm.sameRef).toBe(true);

    wrapper.vm.setTheme('dark');
    await nextTick();

    expect(wrapper.get('[data-testid="theme"]').text()).toBe('dark');
  });
});

describe('harness — useHead', () => {
  it('accepts the function form app.vue uses, not only a plain object', async () => {
    const Stub = defineComponent({
      setup() {
        useHead(() => ({ htmlAttrs: { lang: 'vi' } }));
      },
      template: '<div />',
    });

    await mountBackofficePage(Stub);

    expect(backofficeStores.head.value).toEqual({ htmlAttrs: { lang: 'vi' } });
  });

  it('rejects unsupported input instead of silently writing nothing', async () => {
    const Stub = defineComponent({
      setup() {
        useHead(['không phải object'] as never);
      },
      template: '<div />',
    });

    await expect(mountBackofficePage(Stub)).rejects.toThrow(/useHead/u);
  });
});

/**
 * Cặp test này cố ý **phụ thuộc thứ tự khai báo**: vitest chạy test trong một file theo
 * thứ tự đó, và điều được kiểm chính là việc dọn dẹp *giữa* hai test.
 */
describe('harness — cleanup between tests', () => {
  const unmounted: string[] = [];

  it('the mount leaves its component tree alive within this test', async () => {
    const Stub = defineComponent({
      setup() {
        useState<string>('probe');
        onUnmounted(() => unmounted.push('probe'));
      },
      template: '<div />',
    });

    await mountBackofficePage(Stub);

    expect(unmounted).toEqual([]);
  });

  it('the previous test tree is unmounted before this test runs', () => {
    // Không có `enableAutoUnmount(afterEach)` trong `tests/setup.ts` thì cây cũ vẫn sống:
    // nó giữ ref của store mà `resetBackofficeGlobals()` vừa xoá, và một `useHead` phát
    // lại từ cây cũ sẽ ghi vào `head` của **test này**.
    expect(unmounted).toEqual(['probe']);
  });
});
