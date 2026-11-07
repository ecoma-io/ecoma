<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { ScrollAreaScrollbarProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { ScrollAreaScrollbar, ScrollAreaThumb } from 'reka-ui';
import { cn } from '../../utils';

const {
  class: className = undefined,
  orientation = 'vertical',
  ...props
} = defineProps<ScrollAreaScrollbarProps & { class?: HTMLAttributes['class'] }>();
</script>

<template>
  <ScrollAreaScrollbar
    data-slot="scroll-area-scrollbar"
    v-bind="props"
    :orientation="orientation"
    :class="
      cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )
    "
  >
    <ScrollAreaThumb data-slot="scroll-area-thumb" class="bg-border relative flex-1 rounded-full" />
  </ScrollAreaScrollbar>
</template>
