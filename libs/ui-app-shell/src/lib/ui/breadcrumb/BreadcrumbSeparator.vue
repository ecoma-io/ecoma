<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script lang="ts" setup>
import type { HTMLAttributes } from 'vue';
import { ChevronRight } from '@lucide/vue';
import { cn } from '../../utils';

const { class: className = undefined } = defineProps<{
  class?: HTMLAttributes['class'];
}>();
</script>

<template>
  <li
    data-slot="breadcrumb-separator"
    role="presentation"
    aria-hidden="true"
    :class="cn('[&>svg]:size-3.5', className)"
  >
    <slot>
      <ChevronRight />
    </slot>
  </li>
</template>
