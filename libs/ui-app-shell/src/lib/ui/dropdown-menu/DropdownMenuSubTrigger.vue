<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DropdownMenuSubTriggerProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { ChevronRight } from '@lucide/vue';
import { DropdownMenuSubTrigger, useForwardProps } from 'reka-ui';
import { cn } from '../../utils';

const {
  class: className = undefined,
  inset = undefined,
  ...props
  // oxlint-disable-next-line vue/max-props
} = defineProps<
  DropdownMenuSubTriggerProps & { class?: HTMLAttributes['class']; inset?: boolean }
>();

const forwardedProps = useForwardProps(props);
</script>

<template>
  <DropdownMenuSubTrigger
    data-slot="dropdown-menu-sub-trigger"
    v-bind="forwardedProps"
    :class="
      cn(
        'focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8',
        className,
      )
    "
  >
    <slot />
    <ChevronRight class="ml-auto size-4" />
  </DropdownMenuSubTrigger>
</template>
