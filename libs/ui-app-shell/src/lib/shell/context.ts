import type { ComputedRef, InjectionKey, Ref } from 'vue';
import { inject, provide } from 'vue';
import type { AppShellColorMode } from '../color-mode';
import type { AppShellDirection } from './types';

/**
 * Trạng thái shell chia cho các component con. App giữ **nguồn duy nhất** của
 * cấu hình (cookie đọc được ở SSR); shell chỉ đọc và phát yêu cầu thay đổi lên,
 * không tự lưu gì. Nhờ vậy không có hai nguồn sự thật cho cùng một cấu hình, và
 * lần render đầu ở client luôn dùng đúng giá trị mà SSR đã dùng.
 */
export interface AppShellContext {
  /** Chiều văn bản hiện tại — app suy ra từ locale và truyền vào qua prop. */
  readonly dir: ComputedRef<AppShellDirection>;
  /** Chế độ màu hiện tại (đọc từ cookie của app). */
  readonly colorMode: ComputedRef<AppShellColorMode>;
  /** Đổi chế độ màu; app ghi cookie ở tầng trên. */
  readonly setColorMode: (colorMode: AppShellColorMode) => void;
  /** Đường dẫn đang xem, để đánh dấu mục nav đang active. */
  readonly currentPath: ComputedRef<string>;
  /**
   * Trạng thái mở của command palette. Nút tìm kiếm trong sidebar, phím tắt
   * ⌘/Ctrl + K và chính dialog đều đọc/ghi cùng một ref, nên không có hai nguồn
   * sự thật cho việc palette đang mở hay đóng.
   */
  readonly paletteOpen: Ref<boolean>;
}

export const APP_SHELL_CONTEXT: InjectionKey<AppShellContext> = Symbol('AppShell');

export function provideAppShellContext(context: AppShellContext): void {
  provide(APP_SHELL_CONTEXT, context);
}

/**
 * Đọc trạng thái shell từ component con. Dùng trong `AppShellNav`,
 * `AppShellHeader`, `AppShellColorModeToggle`… Chỉ có hiệu lực khi nằm trong
 * `AppShell`.
 */
export function useAppShell(): AppShellContext {
  const context = inject(APP_SHELL_CONTEXT);

  if (!context) {
    throw new Error(
      'useAppShell() chỉ dùng được bên trong <AppShell>. Component con của shell phải được render từ AppShell, không đứng riêng.',
    );
  }

  return context;
}
