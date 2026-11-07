import { DEFAULT_APP_SHELL_PREFERENCES } from './defaults';
import type { AppShellDirection, AppShellPreferences, AppShellThemeColor } from './types';
import { APP_SHELL_THEME_COLORS } from './types';

const DIRECTIONS: readonly AppShellDirection[] = ['ltr', 'rtl'];
const THEME_COLORS: readonly AppShellThemeColor[] = APP_SHELL_THEME_COLORS.map(
  (color) => color.name,
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Kiểm tra một giá trị bất kỳ có phải `AppShellDirection` hay không.
 */
export function isAppShellDirection(value: unknown): value is AppShellDirection {
  return typeof value === 'string' && DIRECTIONS.some((direction) => direction === value);
}

/**
 * Kiểm tra một giá trị bất kỳ có phải màu chủ đạo **có CSS tương ứng** hay
 * không. Màu đã bị bỏ (ví dụ `amber`, `purple` của nguồn) trả `false` — đó là
 * lý do tồn tại của hàm này thay vì chỉ so với danh sách trong type.
 */
export function isAppShellThemeColor(value: unknown): value is AppShellThemeColor {
  return typeof value === 'string' && THEME_COLORS.some((color) => color === value);
}

/**
 * Chuẩn hoá dữ liệu đã lưu thành `AppShellPreferences` hợp lệ.
 *
 * Hàm này chạy trên đầu vào **không tin được**: cookie do người dùng sửa được,
 * và cookie cũ có thể mang giá trị của phiên bản trước (màu `amber`/`purple`
 * của nguồn, `theme.type`, `sidebar.variant`). Mọi trường không đọc được đều
 * rơi về `DEFAULT_APP_SHELL_PREFERENCES`, từng trường độc lập — một giá trị
 * hỏng không được phép xoá giá trị hợp lệ còn lại.
 *
 * Không throw: giá trị trả về luôn dùng được, nên SSR và client luôn tính ra
 * cùng một cấu hình từ cùng một cookie.
 */
export function parseAppShellPreferences(raw: unknown): AppShellPreferences {
  const source = isRecord(raw) ? raw : {};

  return {
    themeColor: isAppShellThemeColor(source['themeColor'])
      ? source['themeColor']
      : DEFAULT_APP_SHELL_PREFERENCES.themeColor,
    direction: isAppShellDirection(source['direction'])
      ? source['direction']
      : DEFAULT_APP_SHELL_PREFERENCES.direction,
  };
}
