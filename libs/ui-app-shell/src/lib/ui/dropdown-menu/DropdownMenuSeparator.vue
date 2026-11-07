<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DropdownMenuSeparatorProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DropdownMenuSeparator } from 'reka-ui';
import { cn } from '../../utils';

const { class: className = undefined, ...props } = defineProps<
  DropdownMenuSeparatorProps & {
    class?: HTMLAttributes['class'];
  }
>();
</script>

<template>
  <DropdownMenuSeparator
    data-slot="dropdown-menu-separator"
    v-bind="props"
    :class="cn('bg-border -mx-1 my-1 h-px', className)"
  />
</template>
