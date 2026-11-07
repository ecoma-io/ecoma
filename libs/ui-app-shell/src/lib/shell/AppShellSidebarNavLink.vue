<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { computed } from 'vue';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
  type SidebarMenuButtonVariants,
} from '../ui/sidebar';
import { useAppShell } from './context';
import type { AppShellNavItem } from './types';

/**
 * Một mục nav phẳng. Nguồn so `item.link === $route.path` để đánh dấu mục đang
 * xem; ở đây cùng phép so đó nhưng lấy path từ context của `AppShell` (app
 * truyền vào) thay vì gọi `useRoute()` trong library — như vậy component vẫn
 * thuần dữ liệu vào / DOM ra và test được mà không cần router.
 *
 * `active` truyền xuống `SidebarMenuButton` dưới dạng `data-active`, đúng
 * attribute mà `sidebarMenuButtonVariants` dùng để tô nền mục đang active.
 *
 * Click đóng drawer trên mobile (`setOpenMobile(false)`) — không có bước này,
 * chọn xong một mục thì drawer vẫn che nội dung vừa điều hướng tới.
 */
const {
  item,
  size = 'default',
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  item: AppShellNavItem;
  size?: SidebarMenuButtonVariants['size'];
}>();

const { currentPath } = useAppShell();
const { setOpenMobile } = useSidebar();

const isActive = computed(() => item.href === currentPath.value);
</script>

<template>
  <SidebarMenu>
    <SidebarMenuItem>
      <SidebarMenuButton as-child :tooltip="item.title" :size="size" :data-active="isActive">
        <NuxtLink :to="item.href" @click="setOpenMobile(false)">
          <component :is="item.icon" v-if="item.icon" />
          <span>{{ item.title }}</span>
          <span
            v-if="item.badge"
            class="rounded-md bg-[#adfa1d] px-1.5 py-0.5 text-xs text-black leading-none group-hover:no-underline"
          >
            {{ item.badge }}
          </span>
        </NuxtLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  </SidebarMenu>
</template>
