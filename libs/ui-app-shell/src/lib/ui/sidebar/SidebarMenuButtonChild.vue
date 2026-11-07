<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import type { SidebarMenuButtonVariants } from '.';
import { Primitive } from 'reka-ui';
import { cn } from '../../utils';
import { sidebarMenuButtonVariants } from '.';

export interface SidebarMenuButtonProps extends PrimitiveProps {
  variant?: SidebarMenuButtonVariants['variant'];
  size?: SidebarMenuButtonVariants['size'];
  isActive?: boolean;
  class?: HTMLAttributes['class'];
}

const {
  variant = 'default',
  size = 'default',
  isActive = undefined,
  class: className = undefined,
  as = 'button',
  // oxlint-disable-next-line vue/max-props
} = defineProps<SidebarMenuButtonProps>();
</script>

<template>
  <Primitive
    data-slot="sidebar-menu-button"
    data-sidebar="menu-button"
    :data-size="size"
    :data-active="isActive"
    :class="cn(sidebarMenuButtonVariants({ variant, size }), className)"
    :as="as"
    :as-child="asChild"
    v-bind="$attrs"
  >
    <slot />
  </Primitive>
</template>
