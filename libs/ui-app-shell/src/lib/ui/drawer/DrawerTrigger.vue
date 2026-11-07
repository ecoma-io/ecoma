<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script lang="ts" setup>
import type { DrawerTriggerProps } from 'vaul-vue';
import { DrawerTrigger } from 'vaul-vue';

const { ...props } = defineProps<DrawerTriggerProps>();
</script>

<template>
  <DrawerTrigger data-slot="drawer-trigger" v-bind="props">
    <slot />
  </DrawerTrigger>
</template>
