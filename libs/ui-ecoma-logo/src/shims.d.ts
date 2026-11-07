/**
 * Khai báo module cho asset phi-TS mà `tsc`/`vue-tsc` không tự resolve:
 * component `.vue` (index.ts re-export component SFC; test import `.vue`) và
 * artwork `.svg` (component import URL asset để render).
 *
 * `tsc` gốc không tự resolve `.vue`; app Nuxt có shim của riêng nó, shim này
 * chỉ phục vụ typecheck của chính library và test.
 *
 * `.svg` được type như `vite/client` khai báo (default export là URL asset —
 * chuỗi path/hashed URL do bundler quyết định). Props khai báo
 * `Record<string, unknown>` (không `any`): mọi prop của consumer đều assign
 * được (kiểu prop cụ thể vẫn đọc được ở phía khai báo `defineProps` thật
 * trong file `.vue`), và lint cấm `no-explicit-any`.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, never>>;
  export default component;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
