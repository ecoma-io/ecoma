<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import { cn } from '../utils';
import { Separator } from '../ui/separator';
import { SidebarTrigger } from '../ui/sidebar';
import AppShellBreadcrumb from './AppShellBreadcrumb.vue';
import { useAppShell } from './context';
import type { AppShellBreadcrumbLink } from './types';

/**
 * Header dính trên cùng của vùng nội dung: nút mở/đóng sidebar, breadcrumb, và
 * slot bên phải cho hành động của từng app (thông báo, tài khoản…).
 *
 * `h-(--header-height)`: chiều cao là biến CSS của shell, không phải hằng số
 * trong class, để mọi chỗ cần chiều cao đó (header, khoảng bù của sidebar) đọc
 * cùng một con số.
 *
 * `md:rounded-tl-xl md:rounded-tr-xl` là góc bo của tấm nội dung trên desktop;
 * ở RTL hai class này vẫn đúng vì chúng bo cả hai góc trên, không phụ thuộc
 * chiều.
 */
const {
  links = undefined,
  homeLabel = 'Home',
  class: className = undefined,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  links?: readonly AppShellBreadcrumbLink[];
  homeLabel?: string;
  class?: string;
}>();

const { currentPath } = useAppShell();
</script>

<template>
  <header
    class="sticky top-0 md:peer-data-[variant=inset]:top-2 z-10 h-(--header-height) flex items-center gap-4 border-b bg-background px-4 md:px-6 md:rounded-tl-xl md:rounded-tr-xl"
  >
    <div class="w-full flex items-center gap-4 h-4">
      <SidebarTrigger />
      <Separator orientation="vertical" />
      <AppShellBreadcrumb :links="links" :path="currentPath" :home-label="homeLabel" />
    </div>
    <div :class="cn('ml-auto', className)">
      <slot name="actions" />
    </div>
  </header>
</template>
