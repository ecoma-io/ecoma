<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. Port sang Drawer của reka-ui (vaul-vue đã unmaintained).
     Lớp motion (transform theo `--drawer-swipe-*` + animation theo `data-state`) nằm trong
     `src/styles/app-shell.css` — reka-ui Drawer là headless. Selector vị trí đổi từ
     `data-[vaul-drawer-direction=…]` (vaul) sang `data-[swipe-direction=…]` (reka-ui). -->
<script lang="ts" setup>
import type { DialogContentEmits, DialogContentProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DrawerContent, DrawerPortal, useForwardPropsEmits } from 'reka-ui';
import { cn } from '../../utils';
import DrawerOverlay from './DrawerOverlay.vue';

const { class: className = undefined, ...props } = defineProps<
  DialogContentProps & { class?: HTMLAttributes['class'] }
>();
const emits = defineEmits<DialogContentEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <DrawerPortal>
    <DrawerOverlay />
    <DrawerContent
      data-slot="drawer-content"
      v-bind="forwarded"
      :class="
        cn(
          'group/drawer-content bg-background fixed z-50 flex h-auto flex-col',
          'data-[swipe-direction=top]:inset-x-0 data-[swipe-direction=top]:top-0 data-[swipe-direction=top]:mb-24 data-[swipe-direction=top]:max-h-[80vh] data-[swipe-direction=top]:rounded-b-lg',
          'data-[swipe-direction=bottom]:inset-x-0 data-[swipe-direction=bottom]:bottom-0 data-[swipe-direction=bottom]:mt-24 data-[swipe-direction=bottom]:max-h-[80vh] data-[swipe-direction=bottom]:rounded-t-lg',
          'data-[swipe-direction=right]:inset-y-0 data-[swipe-direction=right]:right-0 data-[swipe-direction=right]:w-3/4 data-[swipe-direction=right]:sm:max-w-sm',
          'data-[swipe-direction=left]:inset-y-0 data-[swipe-direction=left]:left-0 data-[swipe-direction=left]:w-3/4 data-[swipe-direction=left]:sm:max-w-sm',
          className,
        )
      "
    >
      <div
        class="bg-muted mx-auto mt-4 hidden h-2 w-[100px] shrink-0 rounded-full group-data-[swipe-direction=bottom]/drawer-content:block"
      />
      <slot />
    </DrawerContent>
  </DrawerPortal>
</template>
