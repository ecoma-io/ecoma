// Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
// Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md.
import type { AppShellPreferences } from './types';

/**
 * Giá trị mặc định, và cũng là giá trị **duy nhất** dùng khi phần đã lưu
 * không đọc được. Shell luôn dark mode, nên không có `theme` ở đây: chỉ có màu
 * chủ đạo và chiều văn bản.
 */
export const DEFAULT_APP_SHELL_PREFERENCES: AppShellPreferences = {
  themeColor: 'default',
  direction: 'ltr',
};

/**
 * Tên cookie lưu `AppShellPreferences`. Đặt cạnh các helper thay vì trong
 * component để app và library không thể lệch nhau về tên khoá.
 */
export const APP_SHELL_PREFERENCES_COOKIE = 'app_shell_preferences';

/**
 * Tên khoá cấu hình cũ của nguồn (`theme.color`, `theme.type`,
 * `sidebar.side|variant|collapsible`). Chỉ dùng cho migration một lần.
 */
export const LEGACY_APP_SETTINGS_KEY = 'app_settings';
