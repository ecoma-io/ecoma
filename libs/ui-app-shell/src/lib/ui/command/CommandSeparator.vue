<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { SeparatorProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { Separator } from 'reka-ui';
import { cn } from '../../utils';

const { class: className = undefined, ...props } = defineProps<
  SeparatorProps & { class?: HTMLAttributes['class'] }
>();
</script>

<template>
  <Separator
    data-slot="command-separator"
    v-bind="props"
    :class="cn('bg-border -mx-1 h-px', className)"
  >
    <slot />
  </Separator>
</template>
