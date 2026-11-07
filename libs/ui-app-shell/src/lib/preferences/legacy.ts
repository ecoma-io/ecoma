// Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
// Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md.
import { DEFAULT_APP_SHELL_PREFERENCES } from './defaults';
import type { AppShellDirection, AppShellPreferences, AppShellThemeColor } from './types';
import { isAppShellDirection, isAppShellThemeColor } from './validate';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Chuyển cấu hình của nguồn (`app_settings`) sang `AppShellPreferences`.
 *
 * Chiến lược migration — **một chiều, đọc một lần, không ghi ngược lại**:
 *
 * - `theme.color` → `themeColor`. Màu nguồn có mà bản này không port
 *   (`amber`, `purple`) không đóng góp gì; nếu `sidebar.side` đọc được thì
 *   `themeColor` rơi về mặc định, còn nếu đó là trường duy nhất thì hàm trả
 *   `undefined` (xem dưới) — kết quả người dùng thấy vẫn là mặc định, chỉ khác
 *   ở chỗ caller có ghi cookie hay không.
 * - `sidebar.side` → `direction`: `right` ⇒ `rtl`, `left` ⇒ `ltr`. Đây là dấu
 *   vết **duy nhất** còn lưu lại của chiều văn bản ở nguồn, vì nguồn gộp hai
 *   thứ vào một control (chọn RTL thì nó set luôn `side: 'right'`) và
 *   `useTextDirection` chỉ ghi attribute `dir`, không lưu chỗ nào. Bản này tách
 *   hai thứ ra, nên migration là chỗ duy nhất còn đọc `side` như một gợi ý về
 *   chiều — sau đó vị trí sidebar không bao giờ suy ra chiều nữa.
 * - `theme.type` (mono/scaled) và `sidebar.variant|collapsible` bị **bỏ**:
 *   shell luôn `default` typography và luôn variant `sidebar`.
 *
 * Trả `undefined` khi không có trường nào đọc được — không phải object, hoặc chỉ
 * toàn giá trị bản này không hỗ trợ. Caller dùng kết quả đó để quyết định có ghi
 * cookie mới hay không: thà không ghi, vì ghi giá trị mặc định xuống cũng cho ra
 * đúng cấu hình đó (`parseAppShellPreferences` trên cookie trống), mà lại thêm
 * một lần ghi không mang thông tin gì.
 */
export function migrateLegacyAppSettings(raw: unknown): AppShellPreferences | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const theme = isRecord(raw['theme']) ? raw['theme'] : undefined;
  const sidebar = isRecord(raw['sidebar']) ? raw['sidebar'] : undefined;

  const themeColor: AppShellThemeColor | undefined = isAppShellThemeColor(theme?.['color'])
    ? theme['color']
    : undefined;

  const side: unknown = sidebar?.['side'];
  const direction: AppShellDirection | undefined =
    side === 'right' ? 'rtl' : side === 'left' ? 'ltr' : undefined;

  if (themeColor === undefined && direction === undefined) {
    return undefined;
  }

  return {
    themeColor: themeColor ?? DEFAULT_APP_SHELL_PREFERENCES.themeColor,
    direction: direction ?? DEFAULT_APP_SHELL_PREFERENCES.direction,
  };
}

/**
 * Kiểm tra một giá trị đã lưu có **đúng** hình dạng `AppShellPreferences` hay
 * không, kể cả số khoá.
 *
 * Khác `parseAppShellPreferences` ở chủ đích: `parse` là bộ chuẩn hoá dễ tính,
 * đọc hai trường nó cần và bỏ qua mọi thứ khác; còn hàm này trả lời câu hỏi
 * hẹp hơn — "giá trị này có phải do chính shell này ghi ra không?". Khoá thừa
 * nghĩa là dữ liệu của phiên bản khác (bản nguồn ghi `sidebar`, `theme.type`),
 * nên câu trả lời là không, và caller phải đi qua `migrateLegacyAppSettings`
 * hoặc `parseAppShellPreferences` thay vì tin thẳng giá trị đó.
 */
export function isAppShellPreferences(value: unknown): value is AppShellPreferences {
  const expectedKeys = Object.keys(DEFAULT_APP_SHELL_PREFERENCES);

  return (
    isRecord(value) &&
    Object.keys(value).length === expectedKeys.length &&
    expectedKeys.every((key) => key in value) &&
    isAppShellThemeColor(value['themeColor']) &&
    isAppShellDirection(value['direction'])
  );
}
