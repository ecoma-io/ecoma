<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script lang="ts" setup>
import type { DialogOverlayProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DrawerOverlay } from 'vaul-vue';
import { cn } from '../../utils';

const { class: className = undefined, ...props } = defineProps<
  DialogOverlayProps & { class?: HTMLAttributes['class'] }
>();
</script>

<template>
  <DrawerOverlay
    data-slot="drawer-overlay"
    v-bind="props"
    :class="
      cn(
        'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/80',
        className,
      )
    "
  />
</template>
