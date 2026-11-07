<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { TooltipProviderProps } from 'reka-ui';
import { TooltipProvider } from 'reka-ui';

const { delayDuration = 0, ...props } = defineProps<TooltipProviderProps>();
</script>

<template>
  <TooltipProvider v-bind="props" :delay-duration="delayDuration">
    <slot />
  </TooltipProvider>
</template>
