<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '../../utils';

const { class: className = undefined } = defineProps<{
  class?: HTMLAttributes['class'];
}>();
</script>

<template>
  <div
    data-slot="sidebar-group"
    data-sidebar="group"
    :class="cn('relative flex w-full min-w-0 flex-col p-2', className)"
  >
    <slot />
  </div>
</template>
