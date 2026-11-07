<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DropdownMenuTriggerProps } from 'reka-ui';
import { DropdownMenuTrigger, useForwardProps } from 'reka-ui';

const { ...props } = defineProps<DropdownMenuTriggerProps>();

const forwardedProps = useForwardProps(props);
</script>

<template>
  <DropdownMenuTrigger data-slot="dropdown-menu-trigger" v-bind="forwardedProps">
    <slot />
  </DropdownMenuTrigger>
</template>
