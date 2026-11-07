<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script lang="ts" setup>
import type { HTMLAttributes } from 'vue';
import { cn } from '../../utils';

const { class: className = undefined } = defineProps<{
  class?: HTMLAttributes['class'];
}>();
</script>

<template>
  <div data-slot="drawer-footer" :class="cn('mt-auto flex flex-col gap-2 p-4', className)">
    <slot />
  </div>
</template>
