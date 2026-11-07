<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { DropdownMenuContentEmits, DropdownMenuContentProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { DropdownMenuContent, DropdownMenuPortal, useForwardPropsEmits } from 'reka-ui';
import { cn } from '../../utils';

const {
  class: className = undefined,
  sideOffset = 4,
  ...props
} = defineProps<DropdownMenuContentProps & { class?: HTMLAttributes['class'] }>();
const emits = defineEmits<DropdownMenuContentEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <DropdownMenuPortal>
    <DropdownMenuContent
      data-slot="dropdown-menu-content"
      v-bind="forwarded"
      :side-offset="sideOffset"
      :class="
        cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--reka-dropdown-menu-content-available-height) min-w-32 origin-(--reka-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md',
          className,
        )
      "
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>
