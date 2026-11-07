/**
 * Khai báo module cho asset phi-TS mà `tsc` không tự resolve khi module
 * strategy của project là `Bundler` + program không đi qua vue-tsc:
 * component `.vue` (entry module re-export component SFC; test import `.vue`
 * trực tiếp) và artwork `.svg` (component import URL asset để render).
 *
 * Trên Nuxt runtime, component được type qua `.nuxt/components.d.ts` và
 * vue-tsc; shim này chỉ phục vụ typecheck thuần `tsc` của entry module và
 * unit test (kế thừa `shims.d.ts` của thư viện logo trước hợp nhất).
 *
 * Props khai báo `Record<string, unknown>` (không `any`): mọi prop của
 * consumer đều assign được, và lint cấm `no-explicit-any`. `.svg` được type
 * như `vite/client` khai báo (default export là URL asset — chuỗi path/hashed
 * URL do bundler quyết định).
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
