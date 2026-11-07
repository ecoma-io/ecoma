/**
 * Shim cho asset và SFC mà `tsc`/`vue-tsc` không tự resolve.
 *
 * `tsc` gốc không resolve `.vue`; app Nuxt có shim riêng của nó, shim này chỉ
 * phục vụ typecheck của chính library và test. Props khai báo
 * `Record<string, unknown>` (không `any` — lint cấm `no-explicit-any`): mọi
 * prop của consumer đều assign được, còn kiểu prop cụ thể vẫn đọc được ở phía
 * `defineProps` thật trong file `.vue`.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, never>>;
  export default component;
}

/**
 * `NuxtLink` là component **global do Nuxt đăng ký**, không phải thứ import
 * được: template của shell dùng nó y như nguồn (điều hướng client-side), còn
 * runtime của consumer mới là bên cấp nó. Khai báo ở đây để typecheck của
 * library biết tên đó là component, không phải thẻ HTML lạ.
 *
 * ⚠️ File này phải là **module** (có `export` bên dưới) thì `declare module
 * 'vue'` mới là *augmentation* — nối thêm vào type có thật của Vue. Nếu file là
 * script toàn cục, khối đó biến thành khai báo ambient cho `'vue'` và TypeScript
 * sẽ dùng nó **thay** cho type thật của Vue.
 *
 * Kiểu prop khai `Record<string, unknown>` theo cùng lý do như shim `*.vue`:
 * nhận mọi prop hợp lệ của NuxtLink (`to`, `href`, `external`, `target`…) mà
 * không phải chép lại type của một package không nằm trong `dependencies`.
 */
export type UIShellNuxtLinkComponent = import('vue').DefineComponent<
  Record<string, unknown>,
  Record<string, never>
>;

declare module 'vue' {
  export interface GlobalComponents {
    NuxtLink: UIShellNuxtLinkComponent;
  }
}
