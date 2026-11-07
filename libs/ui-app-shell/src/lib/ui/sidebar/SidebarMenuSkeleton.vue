<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { computed } from 'vue';
import { Skeleton } from '../skeleton';
import { cn } from '../../utils';

const {
  showIcon = undefined,
  class: className = undefined,
  // oxlint-disable-next-line vue/max-props
} = defineProps<{
  showIcon?: boolean;
  class?: HTMLAttributes['class'];
}>();

const width = computed(() => {
  return `${Math.floor(Math.random() * 40) + 50}%`;
});
</script>

<template>
  <div
    data-slot="sidebar-menu-skeleton"
    data-sidebar="menu-skeleton"
    :class="cn('flex h-8 items-center gap-2 rounded-md px-2', className)"
  >
    <Skeleton v-if="showIcon" class="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />

    <Skeleton
      class="h-4 max-w-(--skeleton-width) flex-1"
      data-sidebar="menu-skeleton-text"
      :style="{ '--skeleton-width': width }"
    />
  </div>
</template>
