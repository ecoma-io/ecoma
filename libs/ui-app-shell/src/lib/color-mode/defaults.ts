import type { AppShellColorMode } from './types';

/**
 * Giá trị mặc định khi không có gì đã lưu: đi theo hệ điều hành. Đây là lựa chọn
 * trung lập duy nhất — chọn `light` hoặc `dark` làm mặc định là tự ý quyết giúp
 * người dùng một thứ mà chính máy của họ đang biết.
 */
export const DEFAULT_APP_SHELL_COLOR_MODE: AppShellColorMode = 'system';

/**
 * Tên cookie lưu `AppShellColorMode`. Cookie chứ không `localStorage` vì hai
 * phía cùng cần đọc nó theo request/session:
 *
 * - script bootstrap (`bootstrap.ts`) đọc cookie quyết định class `dark` trước
 *   first paint — SSR không render class này, script mới là người đặt;
 * - prop `color-mode` của `AppShell` đọc cookie qua `useCookie` để nút toggle
 *   render đúng trạng thái hiện tại ngay ở lần render đầu (SSR lẫn hydration).
 */
export const APP_SHELL_COLOR_MODE_COOKIE = 'app_shell_color_mode';
