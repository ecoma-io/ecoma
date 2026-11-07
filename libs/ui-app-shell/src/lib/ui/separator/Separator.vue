<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { SeparatorProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { Separator } from 'reka-ui';
import { cn } from '../../utils';

const {
  class: className = undefined,
  orientation = 'horizontal',
  decorative = true,
  ...props
} = defineProps<SeparatorProps & { class?: HTMLAttributes['class'] }>();
</script>

<template>
  <Separator
    data-slot="separator-root"
    v-bind="props"
    :orientation="orientation"
    :decorative="decorative"
    :class="
      cn(
        'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )
    "
  />
</template>
