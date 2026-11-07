/**
 * Bridge cho hai alias chỉ tồn tại trong Nuxt runtime: `#app` và `#i18n`.
 *
 * ⚠️ **Thứ tự import là cơ chế, không phải sắp xếp cho đẹp.** ESM nâng **mọi** import lên
 * trước phần thân module, nên `import { isValidTimeZone } from '../app/utils/…'` ở đây chạy
 * **trước** phần thân của chính file này. Global của Nuxt phải có mặt đúng lúc đó — và nó
 * có, vì `nuxt-globals` được import ở dòng đầu, không phụ thuộc gì trong app.
 *
 * ⚠️ **Vì sao các export dưới là `function` khai báo, không phải `const` arrow:** import
 * của app quay lại chính file này (qua `#app`), tạo một vòng import. `function` được nâng
 * lên đầu module nên dùng được ngay cả khi vòng đang nâng; `const` thì chưa — nó còn ở
 * TDZ, và mọi lời gọi sẽ là `ReferenceError` chỉ xuất hiện ở test.
 *
 * ⚠️ **Vì sao phải khai các export này, không chỉ dựa vào global:** `unplugin-auto-import` của
 * Nuxt không sinh import cho `<script setup>` — đó là việc của trình biên dịch SFC. Vitest
 * không chạy qua trình biên dịch đó, nên tên trần trong một SFC (`ref`, `useI18n`,
 * `useRoute`) là **biến toàn cục thật**. `nuxt-globals` gắn chúng lên `globalThis`, và các
 * export ở đây là **cùng những hàm đó** — để `import { ref } from '#app'` và tên trần cho
 * ra một kết quả, đúng như ở Nuxt.
 *
 * ⚠️ Danh sách export phải khớp `nuxt-globals.ts`. Lệch chỗ sẽ cho một `undefined` lúc
 * runtime **mà typecheck vẫn xanh**: `import { useNuxtApp } from '#app'` có kiểu đúng kể cả
 * khi module không hề export nó.
 */
import { defineAsyncComponent, h, nextTick, ref as vueRef, type Component } from 'vue';
// `vue-i18n` được alias trỏ về chính file này (xem `vitest.config.mts`), nên import ở
// đây là import của app với đúng một bản `vue-i18n` — không phải một bản riêng.

import {
  NUXT_GLOBALS,
  VUE_GLOBALS,
  accountStores,
  i18n,
  resetAccountGlobals,
  uninstallNuxtGlobals,
} from './nuxt-globals';

import { isValidTimeZone } from '../app/utils/is-valid-time-zone';
import { useAccountAdapter } from '../app/composables/use-account-adapter';
import { useAsyncState } from '../app/composables/use-async-state';
import { useAccountI18n } from '../app/composables/use-account-i18n';
import {
  useAccountFormat,
  useAccountPreferences,
} from '../app/composables/use-account-preferences';
import { useAccountShellPreferences } from '../app/composables/use-account-shell-preferences';
import {
  useAccountLocale,
  useAccountLocaleCookie,
  useStoredAccountLocale,
} from '../app/composables/use-account-locale';

/**
 * Component trong `app/components/` — Nuxt tự đăng ký chúng, nên `<AccountPageHeader>`
 * dùng ở mọi trang mà không có import. Vitest không chạy qua đăng ký đó.
 *
 * ⚠️ `import.meta.glob` thay vì liệt kê tay: một component mới thêm vào
 * `app/components/` mà không khai ở đây sẽ render thành `<account-page-header>` rỗng mà
 * **không** báo lỗi — test vẫn xanh trong khi trang mất hẳn một phần. Danh sách tay hỏng
 * đúng lúc component đó được thêm vào, tức là muộn nhất có thể.
 *
 * ⚠️ `eager: true` cố ý: `import.meta.glob` biến mỗi key thành một `import()` riêng, và
 * import động như vậy chỉ resolve được **sau** khi cây component đã render, nên một
 * `async setup` sẽ làm test phải chờ component con trong khi nó đang khẳng định chính nó.
 */
/** `../app/components/AccountPageHeader.vue` → `AccountPageHeader`. */
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
 * Đọc global mà `nuxt-globals` đã cài. Gọi thiếu thì ném lỗi **nói tên** thứ bị thiếu —
 * `undefined is not a function` không cho biết là do mount thiếu setup hay do một global
 * khác rơi mất trong teardown.
 */
function bound<T>(name: string): T {
  const value = (globalThis as Record<string, unknown>)[name];
  if (typeof value !== 'function') {
    throw new Error(`Global '${name}' chưa được cài — xem tests/nuxt-globals.ts`);
  }
  return value as T;
}

/* `#app` — app code dùng đúng những tên này. */
export function useNuxtApp(...args: unknown[]): unknown {
  return (bound<(fn: unknown[]) => unknown>('useNuxtApp') as (...a: unknown[]) => unknown)(...args);
}
export function useState(...args: unknown[]): unknown {
  return (bound<(fn: unknown[]) => unknown>('useState') as (...a: unknown[]) => unknown)(...args);
}
export function useCookie(...args: unknown[]): unknown {
  return (bound<(fn: unknown[]) => unknown>('useCookie') as (...a: unknown[]) => unknown)(...args);
}
export function useHead(...args: unknown[]): unknown {
  return (bound<(fn: unknown[]) => unknown>('useHead') as (...a: unknown[]) => unknown)(...args);
}
export function useRoute(...args: unknown[]): unknown {
  return (bound<(fn: unknown[]) => unknown>('useRoute') as (...a: unknown[]) => unknown)(...args);
}
export function useRouter(...args: unknown[]): unknown {
  return (bound<(fn: unknown[]) => unknown>('useRouter') as (...a: unknown[]) => unknown)(...args);
}
export function useRuntimeConfig(...args: unknown[]): unknown {
  return (bound<(fn: unknown[]) => unknown>('useRuntimeConfig') as (...a: unknown[]) => unknown)(
    ...args,
  );
}
export function useAsyncData(...args: unknown[]): unknown {
  return (bound<(fn: unknown[]) => unknown>('useAsyncData') as (...a: unknown[]) => unknown)(
    ...args,
  );
}

/* `#i18n` — app code chỉ lấy `useI18n` từ đây. */
export function useI18n(...args: unknown[]): unknown {
  return (bound<(fn: unknown[]) => unknown>('useI18n') as (...a: unknown[]) => unknown)(...args);
}

/**
 * Vue API mà `<script setup>` của Nuxt nhận qua auto-import — `import { ref } from '#app'`
 * phải cho ra đúng hàm mà tên trần `ref` dùng.
 *
 * ⚠️ `vueRef` được export trực tiếp, không đi qua `globalThis`: nó không dựa vào context
 * component nào, nên không cần global của test. Giữ nó ở đây chỉ để một file test import
 * `ref` từ `#app` mà không hỏng.
 */
export { defineAsyncComponent, h, nextTick, vueRef as ref };

/**
 * App code chỉ dùng `NuxtApp` như **kiểu** (`import { type NuxtApp } from '#app'`), nên ở
 * test nó không cần giá trị runtime. Khai đúng tên để kiểu của `use-account-adapter.ts`
 * không đổi giữa app và test.
 */
export type NuxtApp = Record<string, unknown>;

/**
 * ⚠️ Composable của `app/composables/` và `app/utils/` cũng là auto-import, và chúng **dùng**
 * các global Nuxt ở trên qua tên trần. Đăng ký ở đây, **sau** khi global đã có, để chúng bắt
 * đúng bản của test chứ không phải bản của Nuxt thật.
 */
const APP_GLOBALS = [
  'isValidTimeZone',
  'useAccountAdapter',
  'useAsyncState',
  'useAccountI18n',
  'useAccountFormat',
  'useAccountPreferences',
  'useAccountShellPreferences',
  'useAccountLocale',
  'useAccountLocaleCookie',
  'useStoredAccountLocale',
] as const;

for (const [name, value] of Object.entries({
  isValidTimeZone,
  useAccountAdapter,
  useAsyncState,
  useAccountI18n,
  useAccountFormat,
  useAccountPreferences,
  useAccountShellPreferences,
  useAccountLocale,
  useAccountLocaleCookie,
  useStoredAccountLocale,
})) {
  (globalThis as Record<string, unknown>)[name] = value;
}

/** Gỡ global của test — gồm cả composable của app. */
export function uninstallAccountGlobals(): void {
  uninstallNuxtGlobals(APP_GLOBALS);
}

export { NUXT_GLOBALS, VUE_GLOBALS, accountStores, i18n, resetAccountGlobals };
