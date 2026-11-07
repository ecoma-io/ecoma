import type { AppShellDirection, AppShellPreferences, AppShellThemeColor } from './types';

/**
 * Class cho một màu chủ đạo. `default` không gắn gì: nó là token trong `:root`,
 * không phải một class như chín màu còn lại. Nguồn luôn gắn `color-default`
 * (một class không có CSS nào), nên bỏ hẳn cũng cho ra giao diện y hệt.
 */
export function appShellColorClass(themeColor: AppShellThemeColor): string {
  return themeColor === 'default' ? '' : `color-${themeColor}`;
}

/** Hình dạng trả về để truyền thẳng vào `useHead()`. */
export interface AppShellHeadAttributes {
  readonly htmlAttrs: { readonly class: string; readonly dir: AppShellDirection };
  readonly bodyAttrs: { readonly class?: string };
}

/**
 * Thuộc tính `<html>`/`<body>` cho cấu hình đã lưu:
 *
 * ```ts
 * useHead(() => appShellHeadAttributes(preferences.value));
 * ```
 *
 * Tất cả giá trị đều suy ra từ cấu hình đã persist — **không** đọc `window`,
 * `localStorage` hay `matchMedia`. Vì thế lần render đầu trên client (hydration)
 * luôn khớp HTML mà SSR đã gửi, kể cả ở request đầu tiên.
 *
 * Hai chỗ đặt class khác nhau, và đó không phải chi tiết tuỳ ý:
 *
 * - `dark` trên `<html>`: mọi utility `dark:` trong primitive biên dịch thành
 *   `.dark &`, nên `dark` phải là class thật trên một tổ tiên, không thể chỉ là
 *   token trong `:root`. Nó là hằng số vì shell chỉ có một chế độ.
 * - `color-*` trên `<body>`: khối `@variant dark` bên trong mỗi class màu biên
 *   dịch thành `.color-x:is(.dark *)`, tức đòi `.color-x` nằm trên một phần tử
 *   **con** của `.dark`. Đặt cả hai lên `<html>` thì phần màu của chế độ tối
 *   không bao giờ khớp. Nguồn cũng chia đúng như vậy (color-mode gắn `dark` lên
 *   `<html>`, `app.vue` gắn `color-*` lên `<body>`).
 */
export function appShellHeadAttributes(preferences: AppShellPreferences): AppShellHeadAttributes {
  const colorClass = appShellColorClass(preferences.themeColor);

  return {
    htmlAttrs: { class: 'dark', dir: preferences.direction },
    bodyAttrs: colorClass === '' ? {} : { class: colorClass },
  };
}
