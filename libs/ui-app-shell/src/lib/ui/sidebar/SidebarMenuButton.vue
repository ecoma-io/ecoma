<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { Component } from 'vue';
import type { SidebarMenuButtonProps } from './SidebarMenuButtonChild.vue';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import SidebarMenuButtonChild from './SidebarMenuButtonChild.vue';
import { useSidebar } from './utils';

defineOptions({
  inheritAttrs: false,
});

const {
  tooltip = undefined,
  as = 'button',
  variant = 'default',
  size = 'default',
  ...props
} = defineProps<
  SidebarMenuButtonProps & {
    tooltip?: string | Component;
  }
>();

const { isMobile, state } = useSidebar();
</script>

<template>
  <SidebarMenuButtonChild
    v-if="!tooltip"
    v-bind="{ ...props, ...$attrs }"
    :variant="variant"
    :size="size"
    :as="as"
  >
    <slot />
  </SidebarMenuButtonChild>

  <Tooltip v-else>
    <TooltipTrigger as-child>
      <SidebarMenuButtonChild
        v-bind="{ ...props, ...$attrs }"
        :variant="variant"
        :size="size"
        :as="as"
      >
        <slot />
      </SidebarMenuButtonChild>
    </TooltipTrigger>
    <TooltipContent side="right" align="center" :hidden="state !== 'collapsed' || isMobile">
      <template v-if="typeof tooltip === 'string'">
        {{ tooltip }}
      </template>
      <component :is="tooltip" v-else />
    </TooltipContent>
  </Tooltip>
</template>
