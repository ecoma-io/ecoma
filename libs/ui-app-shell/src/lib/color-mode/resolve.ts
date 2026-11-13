import type { AppShellColorMode } from './types';

/**
 * Quyết định class `dark` cho một mode và trạng thái hệ điều hành — hàm thuần,
 * không đọc environment, để mọi đường (script bootstrap lúc tải trang, watcher
 * sau khi người dùng đổi mode) dùng đúng một quy tắc:
 *
 * - `dark` → đương nhiên tối;
 * - `light` → đương nhiên sáng;
 * - `system` → theo `prefers-color-scheme`, và khi môi trường không cho biết
 *   (không `matchMedia`) thì rơi về sáng — cùng mặc định của CSS khi không có
 *   class nào, nên hai đường này không bao giờ lệch nhau.
 */
export function appShellColorModeIsDark(
  mode: AppShellColorMode,
  systemPrefersDark: boolean,
): boolean {
  if (mode === 'dark') {
    return true;
  }
  if (mode === 'light') {
    return false;
  }
  return systemPrefersDark;
}

/**
 * Đặt lại class `dark` trên `<html>` cho mode vừa chọn. Chỉ gọi ở **client sau
 * hydration** (từ watcher của `AppShell` khi người dùng đổi mode): lúc tải trang
 * class do script bootstrap quyết định, còn render Vue không bao giờ chạm vào
 * class này — đó là điều kiện để hydration không bao giờ dispute với script.
 *
 * `matchMedia` được đọc ở đây là có chủ ý: đây là event handler, không phải lúc
 * render, nên không vi phạm invariant "render không đọc environment".
 */
export function appShellApplyColorMode(mode: AppShellColorMode, target?: Document): void {
  const doc = target ?? (typeof document === 'undefined' ? undefined : document);
  if (!doc) {
    return;
  }
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : undefined;
  doc.documentElement.classList.toggle(
    'dark',
    appShellColorModeIsDark(mode, query?.matches === true),
  );
}
