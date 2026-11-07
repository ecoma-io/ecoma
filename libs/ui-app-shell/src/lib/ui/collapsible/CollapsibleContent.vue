<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { CollapsibleContentProps } from 'reka-ui';
import { CollapsibleContent } from 'reka-ui';

const { ...props } = defineProps<CollapsibleContentProps>();
</script>

<template>
  <CollapsibleContent data-slot="collapsible-content" v-bind="props">
    <slot />
  </CollapsibleContent>
</template>
