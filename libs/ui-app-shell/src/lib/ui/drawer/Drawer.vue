<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md.
     Port sang Drawer của reka-ui (vaul-vue đã unmaintained): cùng vai trò
     wrapper, bỏ prop `shouldScaleBackground` (cơ chế riêng của vaul, reka-ui
     không có — hiệu ứng scale nền mobile giờ là trách nhiệm consumer qua
     `DrawerIndent`). -->
<script lang="ts" setup>
import type { DrawerRootEmits, DrawerRootProps } from 'reka-ui';
import { DrawerRoot, useForwardPropsEmits } from 'reka-ui';

const { ...props } = defineProps<DrawerRootProps>();

const emits = defineEmits<DrawerRootEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <DrawerRoot data-slot="drawer" v-bind="forwarded">
    <slot />
  </DrawerRoot>
</template>
