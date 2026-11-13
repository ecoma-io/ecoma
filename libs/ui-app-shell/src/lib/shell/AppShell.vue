<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { ConfigProvider } from 'reka-ui';
import { computed, ref, watch } from 'vue';
import { appShellApplyColorMode } from '../color-mode';
import type { AppShellColorMode } from '../color-mode';
import { SidebarInset, SidebarProvider } from '../ui/sidebar';
import AppShellHeader from './AppShellHeader.vue';
import AppShellSidebar from './AppShellSidebar.vue';
import { provideAppShellContext } from './context';
import { DEFAULT_APP_SHELL_LABELS } from './labels';
import { useAppShellCommandPaletteShortcut } from './shortcuts';
import type {
  AppShellBreadcrumbLink,
  AppShellCommandGroup,
  AppShellDirection,
  AppShellLabels,
  AppShellNavEntry,
  AppShellNavSection,
} from './types';

/**
 * Root của shell: `SidebarProvider` + sidebar + vùng nội dung, đúng cấu trúc
 * `layouts/default.vue` của nguồn.
 *
 * Không nhận `children`/slot mặc định nào khác ngoài nội dung trang, và **không**
 * sở hữu cấu hình: `dir`/`colorMode` vào bằng prop và `colorMode` đi ra bằng
 * `update:colorMode`, nên app là nơi duy nhất biết cookie (`v-model:color-mode`
 * là cách dùng chuẩn). Library không đọc/ghi cookie, không đọc route, không giữ
 * bản sao nào của cấu hình — hết reload vẫn chỉ có một nguồn.
 *
 * Hai nguồn sự thật của hai cấu hình, đúng theo issue #213:
 *
 * - `dir` là thuộc tính của **ngôn ngữ**: app suy ra từ locale registry (cùng
 *   nguồn với `<html lang>`) và truyền xuống. Shell không có đường nào đổi nó —
 *   không còn setting LTR/RTL.
 * - `colorMode` là lựa chọn người dùng duy nhất còn lại (light/dark/system).
 *   Class `dark` trên `<html>` **không** do render của Vue đặt: lúc tải trang,
 *   script bootstrap (`APP_SHELL_COLOR_MODE_BOOTSTRAP_SCRIPT`, app chèn tĩnh vào
 *   `app.head` trong `nuxt.config` — không qua `useHead`, vì app shell chạy
 *   `ssr: false` và `useHead` chỉ áp dụng sau mount) quyết định trước first
 *   paint; sau hydration, watcher bên dưới mới cập nhật class khi người dùng
 *   đổi mode. Vue/unhead không quản lý class này, nên hydration không bao giờ
 *   dispute với script.
 *
 * `SidebarProvider` nằm trong template của chính component này, nên mọi thứ cần
 * ngữ cảnh sidebar (`SidebarTrigger`, `SidebarInset`, các mục nav gọi
 * `setOpenMobile`) đều là con của nó theo đúng thứ tự, không cần thêm bước nào.
 *
 * Hai thứ khác của `app.vue` nguồn được kéo vào đây vì chúng là **cơ chế của
 * shell**, không phải nội dung của app mẫu:
 *
 * - `ConfigProvider :dir` của reka: RTL của các primitive (dropdown, sheet,
 *   tooltip, sub-menu) do reka quyết định theo `dir` nhận được, chứ không tự
 *   đọc thuộc tính `dir` trên `<html>`. Thiếu nó, đổi locale sang ngôn ngữ RTL
 *   chỉ đổi hướng chữ còn menu vẫn bung về bên trái.
 * - `vaul-drawer-wrapper` trên phần tử bao ngoài: Drawer trên mobile thu nhỏ
 *   phần nội dung phía sau theo attribute này; không có nó thì drawer mở ra
 *   nhưng không có hiệu ứng lùi nền của nguồn.
 *
 * `labels` là prop duy nhất shell nhận về **hiển thị**: các chuỗi người dùng
 * thấy ở nút đổi mode và ô tìm kiếm. Shell không biết locale, không gọi API dịch
 * và không đổi chuỗi — app i18n truyền vào, app còn lại không truyền và nhận
 * đúng chuỗi tiếng Anh cũ (`DEFAULT_APP_SHELL_LABELS`). Nhãn là prop chứ không
 * phải provide/inject vì chúng đi theo đúng cây của chính component, và một
 * `AppShell` duy nhất trong mỗi app.
 */
const {
  dir = 'ltr',
  colorMode = 'system',
  nav,
  bottomItems = undefined,
  commands = undefined,
  links = undefined,
  currentPath = '/',
  homeLabel = 'Home',
  labels = DEFAULT_APP_SHELL_LABELS,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  /** Chiều văn bản — app suy ra từ locale, shell chỉ orient theo giá trị này. */
  dir?: AppShellDirection;
  /** Chế độ màu — app đọc từ cookie, mặc định đi theo hệ điều hành. */
  colorMode?: AppShellColorMode;
  nav: readonly AppShellNavSection[];
  bottomItems?: readonly AppShellNavEntry[];
  commands?: readonly AppShellCommandGroup[];
  links?: readonly AppShellBreadcrumbLink[];
  currentPath?: string;
  homeLabel?: string;
  labels?: AppShellLabels;
}>();

const emit = defineEmits<{
  (event: 'update:colorMode', value: AppShellColorMode): void;
}>();

const paletteOpen = ref(false);

// Phím tắt ⌘/Ctrl + K do shell gắn một lần ở đây, không gắn ở nút tìm kiếm:
// nút đó nằm trong sidebar nên biến mất khi sidebar thu gọn, còn phím tắt thì
// phải luôn hoạt động.
useAppShellCommandPaletteShortcut(paletteOpen);

// Không `immediate`: lúc hydration class đã đúng do script bootstrap đặt, và
// watcher chỉ có việc cập nhật khi người dùng đổi mode *sau* đó. Chạy ở SSR
// cũng vô hại — `appShellApplyColorMode` tự thoát khi không có document.
watch(
  () => colorMode,
  (mode) => {
    appShellApplyColorMode(mode);
  },
);

provideAppShellContext({
  dir: computed(() => dir),
  colorMode: computed(() => colorMode),
  setColorMode: (mode: AppShellColorMode) => {
    emit('update:colorMode', mode);
  },
  currentPath: computed(() => currentPath),
  paletteOpen,
});
</script>

<template>
  <ConfigProvider :dir="dir">
    <div vaul-drawer-wrapper class="relative">
      <SidebarProvider>
        <AppShellSidebar
          :nav="nav"
          :bottom-items="bottomItems"
          :commands="commands"
          :labels="labels"
        >
          <template #brand>
            <slot name="brand" />
          </template>
          <template #footer>
            <slot name="footer" />
          </template>
        </AppShellSidebar>
        <SidebarInset>
          <AppShellHeader :links="links" :home-label="homeLabel">
            <template #actions>
              <slot name="actions" />
            </template>
          </AppShellHeader>
          <div class="flex flex-col flex-1">
            <div class="@container/main p-4 lg:p-6 grow">
              <slot />
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  </ConfigProvider>
</template>
