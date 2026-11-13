/**
 * Tầng shell: bố cục dashboard hoàn chỉnh (sidebar, header, breadcrumb, nav,
 * command palette) dựng trên các primitive ở `../ui`.
 *
 * App chỉ cần một component gốc `AppShell` và dữ liệu nav của mình; mọi thứ
 * khác — cấu trúc DOM, khoảng cách, chuyển động, responsive — nằm ở đây và
 * giống nhau ở mọi app dùng nó.
 *
 * Shell **không** sở hữu: dữ liệu điều hướng, quyền hạn, xác thực, route, hay
 * cấu hình đã persist. `colorMode` vào/ra qua `v-model:color-mode` và `dir` vào
 * qua prop (nguồn sự thật là locale của app); nav vào qua prop; phần thuộc về
 * app (thương hiệu, menu tài khoản) vào qua slot.
 */
export { default as AppShell } from './AppShell.vue';
export { default as AppShellBreadcrumb } from './AppShellBreadcrumb.vue';
export { default as AppShellColorModeToggle } from './AppShellColorModeToggle.vue';
export { default as AppShellHeader } from './AppShellHeader.vue';
export { default as AppShellNav } from './AppShellNav.vue';
export { default as AppShellSidebarNavGroup } from './AppShellSidebarNavGroup.vue';
export { default as AppShellSidebarNavLink } from './AppShellSidebarNavLink.vue';
export { default as AppShellSearch } from './AppShellSearch.vue';
export { default as AppShellSidebar } from './AppShellSidebar.vue';
export { appShellBreadcrumbLinks, humanize } from './breadcrumb';
export { APP_SHELL_CONTEXT, provideAppShellContext, useAppShell } from './context';
export type { AppShellContext } from './context';
export { DEFAULT_APP_SHELL_LABELS } from './labels';
export { useAppShellCommandPaletteShortcut, useAppShellMetaSymbol } from './shortcuts';
export type {
  AppShellBreadcrumbLink,
  AppShellColorModeLabels,
  AppShellCommandGroup,
  AppShellCommandItem,
  AppShellDirection,
  AppShellLabels,
  AppShellNavEntry,
  AppShellNavGroup,
  AppShellNavItem,
  AppShellNavSection,
  AppShellSearchLabels,
} from './types';
export { isAppShellNavGroup } from './types';
