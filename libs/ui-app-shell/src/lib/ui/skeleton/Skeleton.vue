<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '../../utils';

interface SkeletonProps {
  class?: HTMLAttributes['class'];
}

const { class: className = undefined } = defineProps<SkeletonProps>();
</script>

<template>
  <div data-slot="skeleton" :class="cn('animate-pulse rounded-md bg-primary/10', className)" />
</template>
