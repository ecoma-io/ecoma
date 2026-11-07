<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DialogCloseProps } from 'reka-ui';
import { DialogClose } from 'reka-ui';

const { ...props } = defineProps<DialogCloseProps>();
</script>

<template>
  <DialogClose data-slot="sheet-close" v-bind="props">
    <slot />
  </DialogClose>
</template>
