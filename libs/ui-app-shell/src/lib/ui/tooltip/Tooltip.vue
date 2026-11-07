<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { TooltipRootEmits, TooltipRootProps } from 'reka-ui';
import { TooltipRoot, useForwardPropsEmits } from 'reka-ui';

const { ...props } = defineProps<TooltipRootProps>();
const emits = defineEmits<TooltipRootEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <TooltipRoot data-slot="tooltip" v-bind="forwarded">
    <slot />
  </TooltipRoot>
</template>
