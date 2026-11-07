<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { SidebarGroup, SidebarGroupLabel, type SidebarMenuButtonVariants } from '../ui/sidebar';
import { cn } from '../utils';
import AppShellSidebarNavGroup from './AppShellSidebarNavGroup.vue';
import AppShellSidebarNavLink from './AppShellSidebarNavLink.vue';
import { isAppShellNavGroup, type AppShellNavEntry } from './types';

/**
 * Render một nhóm nav của sidebar: tiêu đề nhóm (nếu có) và danh sách mục.
 *
 * Nguồn chọn component theo `'children' in item` qua `resolveComponent()` (tra
 * component theo **chuỗi tên**); ở đây dùng đúng hai component đã import nên
 * không có bước tra tên lúc runtime. Cùng kết quả render, nhưng sai tên thì
 * lỗi biên dịch thay vì render rỗng.
 *
 * Dữ liệu nav là của app: library không đọc menu, không biết quyền, không biết
 * route — chỉ nhận mảng đã resolve.
 *
 * `class` để nơi gọi đặt nhóm này vào vị trí của nó trong `SidebarContent`
 * (nguồn dùng `class="mt-auto"` cho nhóm mục cuối, đẩy nhóm đó xuống đáy).
 */
const {
  heading = undefined,
  items,
  size = 'default',
  class: className = undefined,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  heading?: string;
  items: readonly AppShellNavEntry[];
  size?: SidebarMenuButtonVariants['size'];
  class?: string;
}>();
</script>

<template>
  <SidebarGroup :class="cn(className)">
    <SidebarGroupLabel v-if="heading">
      {{ heading }}
    </SidebarGroupLabel>
    <template v-for="(entry, index) in items" :key="index">
      <AppShellSidebarNavGroup v-if="isAppShellNavGroup(entry)" :group="entry" :size="size" />
      <AppShellSidebarNavLink v-else :item="entry" :size="size" />
    </template>
  </SidebarGroup>
</template>
