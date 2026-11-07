<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { ScrollAreaRootProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { ScrollAreaCorner, ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui';
import { cn } from '../../utils';
import ScrollBar from './ScrollBar.vue';

const { class: className = undefined, ...props } = defineProps<
  ScrollAreaRootProps & { class?: HTMLAttributes['class'] }
>();
</script>

<template>
  <ScrollAreaRoot data-slot="scroll-area" v-bind="props" :class="cn('relative', className)">
    <ScrollAreaViewport
      data-slot="scroll-area-viewport"
      class="focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
    >
      <slot />
    </ScrollAreaViewport>
    <ScrollBar />
    <ScrollAreaCorner />
  </ScrollAreaRoot>
</template>
