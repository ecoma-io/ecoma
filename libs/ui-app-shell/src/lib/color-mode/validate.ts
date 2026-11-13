import { DEFAULT_APP_SHELL_COLOR_MODE } from './defaults';
import type { AppShellColorMode } from './types';

const COLOR_MODES: readonly AppShellColorMode[] = ['light', 'dark', 'system'];

/** Thu hẹp `unknown` về `AppShellColorMode` khi giá trị nằm trong allowlist. */
export function isAppShellColorMode(value: unknown): value is AppShellColorMode {
  return typeof value === 'string' && COLOR_MODES.some((mode) => mode === value);
}

/**
 * Cookie là dữ liệu người dùng sửa được, nên giá trị đọc ra phải đi qua allowlist
 * trước khi dùng. Giá trị lạ rơi về `system` — khác account contract nơi fallback
 * im lặng bị cấm (FR-008a): mode màu của shell không phải dữ liệu nghiệp vụ, một
 * cookie hỏng chỉ đáng trở về trạng thái trung lập chứ không đáng một màn hình lỗi.
 */
export function parseAppShellColorMode(value: unknown): AppShellColorMode {
  return isAppShellColorMode(value) ? value : DEFAULT_APP_SHELL_COLOR_MODE;
}
