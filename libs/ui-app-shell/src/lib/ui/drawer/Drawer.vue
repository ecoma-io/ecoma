<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script lang="ts" setup>
import type { DrawerRootEmits, DrawerRootProps } from 'vaul-vue';
import { useForwardPropsEmits } from 'reka-ui';
import { DrawerRoot } from 'vaul-vue';

const { shouldScaleBackground = true, ...props } = defineProps<DrawerRootProps>();

const emits = defineEmits<DrawerRootEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <DrawerRoot
    data-slot="drawer"
    v-bind="forwarded"
    :should-scale-background="shouldScaleBackground"
  >
    <slot />
  </DrawerRoot>
</template>
