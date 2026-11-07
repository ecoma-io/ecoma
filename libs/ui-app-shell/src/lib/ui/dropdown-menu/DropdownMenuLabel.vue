<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DropdownMenuLabelProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DropdownMenuLabel, useForwardProps } from 'reka-ui';
import { cn } from '../../utils';

const {
  class: className = undefined,
  inset = undefined,
  ...props
  // oxlint-disable-next-line vue/max-props
} = defineProps<DropdownMenuLabelProps & { class?: HTMLAttributes['class']; inset?: boolean }>();

const forwardedProps = useForwardProps(props);
</script>

<template>
  <DropdownMenuLabel
    data-slot="dropdown-menu-label"
    :data-inset="inset ? '' : undefined"
    v-bind="forwardedProps"
    :class="cn('px-2 py-1.5 text-sm font-medium data-[inset]:pl-8', className)"
  >
    <slot />
  </DropdownMenuLabel>
</template>
