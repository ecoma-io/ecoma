// Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
// Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md.

/**
 * Bộ màu chủ đạo mà shell hỗ trợ, đúng bằng bảng chọn màu của nguồn
 * (`app/constants/themes.ts`, 9 mục). Mỗi giá trị ở đây tương ứng một class
 * `color-<name>` trong `styles/app-shell.css` — trừ `default`, vốn không gắn
 * class nào mà dùng token gốc trong `:root`.
 *
 * Chiều ngược lại không bắt buộc: nguồn có 10 class `.color-*`, và
 * `.color-amber`/`.color-purple` vẫn nằm nguyên trong stylesheet (chép y nguyên
 * từ nguồn) dù bảng chọn không mở chúng. Bất biến cần giữ là "mọi lựa chọn đều
 * có CSS", không phải "mọi class CSS đều có lựa chọn" — một lựa chọn không CSS
 * mới là lỗi, còn CSS thừa chỉ là CSS chưa dùng.
 */
export const APP_SHELL_THEME_COLORS = [
  { name: 'default', swatch: 'oklch(0.205 0 0)' },
  { name: 'blue', swatch: 'oklch(0.623 0.214 259.815)' },
  { name: 'green', swatch: 'oklch(0.723 0.219 149.579)' },
  { name: 'red', swatch: 'oklch(0.637 0.237 25.331)' },
  { name: 'rose', swatch: 'oklch(0.645 0.246 16.439)' },
  { name: 'violet', swatch: 'oklch(0.606 0.25 292.717)' },
  { name: 'orange', swatch: 'oklch(0.705 0.213 47.604)' },
  { name: 'yellow', swatch: 'oklch(0.795 0.184 86.047)' },
  { name: 'teal', swatch: 'oklch(0.60 0.118 184.704)' },
] as const;

/**
 * Tên màu chủ đạo. Chỉ những giá trị này mới gắn được class có CSS tương ứng.
 */
export type AppShellThemeColor = (typeof APP_SHELL_THEME_COLORS)[number]['name'];

/**
 * Chiều văn bản. `direction` là thuộc tính của **document**, không phải của
 * sidebar: đổi chiều không được kéo theo đổi vị trí sidebar (nguồn gộp hai thứ
 * này vào một control, và đó là thứ bị tách ra ở đây).
 */
export type AppShellDirection = 'ltr' | 'rtl';

/**
 * Cấu hình shell mà người dùng được phép đổi.
 *
 * Ba thứ khác của nguồn (`theme.type` mono/scaled, `sidebar.variant`
 * floating/inset, chế độ sáng/tối) **không** nằm ở đây: shell luôn ở dark mode,
 * variant luôn `sidebar`, typography luôn `default`.
 */
export interface AppShellPreferences {
  readonly themeColor: AppShellThemeColor;
  readonly direction: AppShellDirection;
}
