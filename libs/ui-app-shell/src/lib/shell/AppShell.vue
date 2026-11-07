<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { ConfigProvider } from 'reka-ui';
import { computed, ref } from 'vue';
import type { AppShellDirection, AppShellPreferences, AppShellThemeColor } from '../preferences';
import { SidebarInset, SidebarProvider } from '../ui/sidebar';
import AppShellHeader from './AppShellHeader.vue';
import AppShellSettingsPanel from './AppShellSettingsPanel.vue';
import AppShellSidebar from './AppShellSidebar.vue';
import { provideAppShellContext } from './context';
import { DEFAULT_APP_SHELL_LABELS } from './labels';
import { useAppShellCommandPaletteShortcut } from './shortcuts';
import type {
  AppShellBreadcrumbLink,
  AppShellCommandGroup,
  AppShellLabels,
  AppShellNavEntry,
  AppShellNavSection,
} from './types';

/**
 * Root của shell: `SidebarProvider` + sidebar + vùng nội dung, đúng cấu trúc
 * `layouts/default.vue` của nguồn.
 *
 * Không nhận `children`/slot mặc định nào khác ngoài nội dung trang, và **không**
 * sở hữu cấu hình: `preferences` vào bằng prop và đi ra bằng
 * `update:preferences`, nên app là nơi duy nhất biết cookie (`v-model:preferences`
 * là cách dùng chuẩn). Library không đọc/ghi cookie, không đọc route, không giữ
 * bản sao nào của cấu hình — hết reload vẫn chỉ có một nguồn.
 *
 * Purity đổi lại một chút phiền cho nơi gọi: app phải tự render `<html>` (thuộc
 * tính `dir`/class `dark`) từ cùng cấu hình đó qua `useHead`, vì library không
 * được chạm vào document và cũng không chạy được SSR nếu tự gắn class sau mount.
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
 *   đọc thuộc tính `dir` trên `<html>`. Thiếu nó, đổi sang RTL chỉ đổi hướng
 *   chữ còn menu vẫn bung về bên trái — đúng kiểu "RTL chỉ đổi phía sidebar" mà
 *   yêu cầu cấm.
 * - `vaul-drawer-wrapper` trên phần tử bao ngoài: Drawer trên mobile thu nhỏ
 *   phần nội dung phía sau theo attribute này; không có nó thì drawer mở ra
 *   nhưng không có hiệu ứng lùi nền của nguồn.
 *
 * `labels` là prop duy nhất shell nhận về **hiển thị**: các chuỗi người dùng
 * thấy trong bảng tuỳ chỉnh và ô tìm kiếm. Shell không biết locale, không gọi
 * API dịch và không đổi chuỗi — app i18n truyền vào, app còn lại không truyền
 * và nhận đúng chuỗi tiếng Anh cũ (`DEFAULT_APP_SHELL_LABELS`). Nhãn là prop
 * chứ không phải provide/inject vì chúng đi theo đúng cây của chính component,
 * và một `AppShell` duy nhất trong mỗi app.
 */
const {
  preferences,
  nav,
  bottomItems = undefined,
  commands = undefined,
  links = undefined,
  currentPath = '/',
  homeLabel = 'Home',
  labels = DEFAULT_APP_SHELL_LABELS,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  preferences: AppShellPreferences;
  nav: readonly AppShellNavSection[];
  bottomItems?: readonly AppShellNavEntry[];
  commands?: readonly AppShellCommandGroup[];
  links?: readonly AppShellBreadcrumbLink[];
  currentPath?: string;
  homeLabel?: string;
  labels?: AppShellLabels;
}>();

const emit = defineEmits<{
  (event: 'update:preferences', value: AppShellPreferences): void;
}>();

const paletteOpen = ref(false);

// Phím tắt ⌘/Ctrl + K do shell gắn một lần ở đây, không gắn ở nút tìm kiếm:
// nút đó nằm trong sidebar nên biến mất khi sidebar thu gọn, còn phím tắt thì
// phải luôn hoạt động.
useAppShellCommandPaletteShortcut(paletteOpen);

provideAppShellContext({
  preferences: computed(() => preferences),
  setThemeColor: (themeColor: AppShellThemeColor) => {
    emit('update:preferences', { ...preferences, themeColor });
  },
  setDirection: (direction: AppShellDirection) => {
    emit('update:preferences', { ...preferences, direction });
  },
  currentPath: computed(() => currentPath),
  paletteOpen,
});
</script>

<template>
  <ConfigProvider :dir="preferences.direction">
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
        <AppShellSettingsPanel :labels="labels.settings" />
      </SidebarProvider>
    </div>
  </ConfigProvider>
</template>
