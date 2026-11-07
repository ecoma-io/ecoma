/**
 * Minimal bridge cho `#app` trong unit test của `pact-broker-app`.
 *
 * Đủ cho những gì app import tường minh từ `#app`: `useNuxtApp`,
 * `useRuntimeConfig` và `useCookie`/`useState` của
 * `composables/use-pact-broker-locale.ts`, cộng kiểu `NuxtApp`. Hàm điều khiển
 * (`setNuxtApp`, `setRuntimeConfig`, `resetNuxtAppBridge`) được tách sang
 * `tests/nuxt-app-state.ts`.
 *
 * Kiểu `NuxtApp` khai đúng slot mà app ghi — dashboard này không có adapter
 * phía client (mọi dữ liệu đi qua BFF), nên slot duy nhất là runtime config —
 * thay vì `Record<string, unknown>`, để bề mặt bridge khớp cái app thật sự dùng
 * và gõ nhầm tên slot là lỗi ngay trong editor.
 *
 * ⚠️ Đo được: `tests/` **không** nằm trong chương trình typecheck của app —
 * `include` của `.nuxt/tsconfig.json` chỉ có `../app/**` và `../tests/nuxt/**`
 * (thư mục test của Nuxt), và một lỗi kiểu hiển nhiên trong spec vẫn làm
 * `nx typecheck` xanh. Nên kiểu ở đây là tài liệu + trợ giúp editor,
 * **không** phải hàng rào: thứ thật sự bắt việc đổi tên slot là assertion
 * runtime trong spec.
 *
 * ⚠️ Phạm vi: alias `#app` trong `vitest.config.mts` áp cho **toàn bộ** app, nhưng
 * bridge này chỉ mô phỏng bề mặt mà app **import tường minh** từ `#app`. Nuxt
 * thật còn auto-import những cái đó (`useCookie`, `useState`, `useI18n`, `useHead`,
 * `useRoute`, `useRouter`) và cả Vue API cho `<script setup>`; Nuxt sinh import cho
 * auto-import lúc **biên dịch SFC**, nên vitest chạy thẳng SFC không có bước đó và
 * tên trần là biến toàn cục thật. `tests/nuxt-globals.ts` cài chúng lên
 * `globalThis` (xem `NUXT_GLOBALS`/`VUE_GLOBALS` ở đó). `useCookie`/`useState` có
 * mặt ở đây vì app import chúng từ `#app`; hai bản re-export đọc đúng state mà
 * `nuxt-app-state.ts` giữ, nên global và alias không bao giờ lệch nhau.
 */
import { readNuxtApp, readRuntimeConfig, type BridgeNuxtApp } from './nuxt-app-state';
import { useCookie, useState } from './nuxt-globals';

export type NuxtApp = BridgeNuxtApp;

export function useNuxtApp(..._args: unknown[]): NuxtApp {
  return readNuxtApp();
}

export function useRuntimeConfig(..._args: unknown[]): { public: Record<string, unknown> } {
  return readRuntimeConfig();
}

export { useCookie, useState };
