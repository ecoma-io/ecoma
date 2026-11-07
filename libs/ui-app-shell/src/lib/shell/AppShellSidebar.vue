<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { computed } from 'vue';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from '../ui/sidebar';
import AppShellNav from './AppShellNav.vue';
import AppShellSearch from './AppShellSearch.vue';
import { useAppShell } from './context';
import { DEFAULT_APP_SHELL_LABELS } from './labels';
import type {
  AppShellCommandGroup,
  AppShellLabels,
  AppShellNavEntry,
  AppShellNavSection,
} from './types';

/**
 * Sidebar của shell: thương hiệu của app, command palette, nav, chân trang.
 *
 * Hai điểm khác nguồn, đều do contract của Ecoma (§2 của yêu cầu):
 *
 * - `variant` cố định `sidebar` và `collapsible` cố định `offcanvas`, không lấy
 *   từ cấu hình. Nguồn cho người dùng chọn `floating`/`inset` và
 *   `offcanvas`/`icon`; ở đây không còn đường nào đổi hai giá trị đó.
 * - `side` **suy ra từ chiều văn bản**, không lưu riêng: `rtl` thì sidebar nằm
 *   bên phải. Nhờ vậy không có cặp giá trị nào mâu thuẫn nhau (direction `ltr`
 *   nhưng sidebar `right`) và không cần di trú thêm một trường.
 *
 * Thương hiệu và chân trang là slot vì chúng thuộc về app: tên sản phẩm, logo,
 * menu tài khoản, đăng xuất — library không biết và không nên biết.
 */
const {
  nav,
  bottomItems = undefined,
  commands = undefined,
  labels = DEFAULT_APP_SHELL_LABELS,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  nav: readonly AppShellNavSection[];
  bottomItems?: readonly AppShellNavEntry[];
  commands?: readonly AppShellCommandGroup[];
  labels?: AppShellLabels;
}>();

const { preferences } = useAppShell();

const side = computed(() => (preferences.value.direction === 'rtl' ? 'right' : 'left'));
</script>

<template>
  <Sidebar variant="sidebar" collapsible="offcanvas" :side="side">
    <SidebarHeader>
      <slot name="brand" />
      <!--
        Chỉ hiện nút tìm kiếm khi app có lệnh để tìm: một palette rỗng tệ hơn
        không có palette, vì người dùng bấm vào rồi mới biết không có gì.
        Nhãn của nó đi cùng props sẵn có của `AppShellSearch`; shell không tự
        đổi chuỗi, app truyền xuống qua `labels` nếu mình có i18n.
      -->
      <AppShellSearch
        v-if="commands && commands.length > 0"
        :groups="commands"
        :label="labels.search.buttonLabel"
        :placeholder="labels.search.placeholder"
        :empty-label="labels.search.emptyLabel"
        :dialog-title="labels.search.dialogTitle"
        :dialog-description="labels.search.dialogDescription"
      />
    </SidebarHeader>
    <SidebarContent>
      <AppShellNav
        v-for="(section, index) in nav"
        :key="index"
        :heading="section.heading"
        :items="section.items"
      />
      <AppShellNav
        v-if="bottomItems && bottomItems.length > 0"
        class="mt-auto"
        :items="bottomItems"
        size="sm"
      />
    </SidebarContent>
    <SidebarFooter>
      <slot name="footer" />
    </SidebarFooter>
    <SidebarRail />
  </Sidebar>
</template>
