import type { Component } from 'vue';

/**
 * Một mục điều hướng **để render** — library chỉ biết cách hiển thị, không biết
 * và không sở hữu dữ liệu điều hướng. App truyền vào nhãn, đích đến và icon;
 * quyền hạn, thứ tự và nội dung là chuyện của app.
 */
export interface AppShellNavItem {
  readonly title: string;
  readonly href: string;
  /** Component icon (ví dụ `@lucide/vue`), không phải tên icon dạng chuỗi. */
  readonly icon?: Component;
  /** Nhãn nhỏ bên phải tiêu đề, ví dụ `New`. */
  readonly badge?: string;
}

/** Mục nav có mục con, render bằng `Collapsible` như nguồn. */
export interface AppShellNavGroup {
  readonly title: string;
  readonly icon?: Component;
  readonly badge?: string;
  readonly children: readonly AppShellNavItem[];
}

/** Mục nav: hoặc link phẳng, hoặc nhóm có mục con. */
export type AppShellNavEntry = AppShellNavItem | AppShellNavGroup;

/**
 * Một nhóm nav trong sidebar, tương ứng `NavMenu` của nguồn (`heading` +
 * `items`). Mỗi nhóm render thành một `SidebarGroup` có nhãn ở trên.
 */
export interface AppShellNavSection {
  readonly heading?: string;
  readonly items: readonly AppShellNavEntry[];
}

/** Nhóm kết quả trong command palette. */
export interface AppShellCommandGroup {
  readonly heading: string;
  readonly items: readonly AppShellCommandItem[];
}

/**
 * Một lệnh trong palette. Palette chỉ **điều hướng**: mọi lệnh đều có `href`.
 * Nguồn cũng vậy — nó không có lệnh nào chỉ để chạy một hành động tại chỗ, nên ở
 * đây không thêm nhánh render thứ hai cho trường hợp không có `href` (một nhánh
 * như thế sẽ tạo ra mục bấm vào không làm gì).
 */
export interface AppShellCommandItem {
  readonly title: string;
  readonly href: string;
  readonly icon?: Component;
  /** Các phím tắt hiển thị bên phải, ví dụ `['G', 'H']`. */
  readonly keys?: readonly string[];
}

/** Một mục breadcrumb đã resolve từ path. */
export interface AppShellBreadcrumbLink {
  readonly title: string;
  readonly href: string;
}

/** Kiểm tra một entry có mục con hay không (thu hẹp union). */
export function isAppShellNavGroup(entry: AppShellNavEntry): entry is AppShellNavGroup {
  return 'children' in entry;
}

/**
 * Nhãn hiển thị của bảng tuỳ chỉnh. Shell sinh sẵn tiếng Anh ở
 * `DEFAULT_APP_SHELL_LABELS`; app nào i18n thì truyền bản dịch của riêng mình.
 */
export interface AppShellSettingsLabels {
  readonly title: string;
  readonly description: string;
  readonly theming: string;
  readonly layout: string;
  readonly color: string;
  readonly direction: string;
  readonly directionLtr: string;
  readonly directionRtl: string;
}

/**
 * Nhãn hiển thị của ô tìm kiếm lệnh. `AppShellSearch` đã nhận từng nhãn riêng
 * từ trước; bộ này chỉ là cách gộp lại để `AppShell` truyền xuống một lượt.
 *
 * `dialogTitle`/`dialogDescription` là tiêu đề và mô tả của `CommandDialog` —
 * `DialogHeader` của nó nằm trong `sr-only` nên chỉ trình đọc màn hình đọc,
 * nhưng vẫn là chuỗi **người dùng nghe thấy**, nên vẫn phải dịch được.
 */
export interface AppShellSearchLabels {
  readonly buttonLabel: string;
  readonly placeholder: string;
  readonly emptyLabel: string;
  readonly dialogTitle: string;
  readonly dialogDescription: string;
}

/**
 * Toàn bộ chuỗi hiển thị của shell mà app có thể dịch. Shell **không** suy ra
 * locale nào cả: nó chỉ render chuỗi được truyền vào, nên một app không i18n
 * (llm-console, llm-seller) giữ nguyên hành vi bằng cách không truyền prop này.
 */
export interface AppShellLabels {
  readonly settings: AppShellSettingsLabels;
  readonly search: AppShellSearchLabels;
}
