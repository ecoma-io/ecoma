<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. Port sang Drawer của reka-ui (vaul-vue đã unmaintained). -->
<script lang="ts" setup>
import type { DrawerTitleProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DrawerTitle } from 'reka-ui';
import { cn } from '../../utils';

const { class: className = undefined, ...props } = defineProps<
  DrawerTitleProps & { class?: HTMLAttributes['class'] }
>();
</script>

<template>
  <DrawerTitle
    data-slot="drawer-title"
    v-bind="props"
    :class="cn('text-foreground font-semibold', className)"
  >
    <slot />
  </DrawerTitle>
</template>
