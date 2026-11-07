<!-- Ported from https://github.com/dianprata/nuxt-shadcn-dashboard (commit 54988681e50feaa4935828882da93faff06cf042), MIT, Copyright (c) 2024 Dian Pratama.
     Xem libs/ui-app-shell/THIRD-PARTY-NOTICES.md. -->
<script setup lang="ts">
import type { TooltipContentEmits, TooltipContentProps } from 'reka-ui';
import type { HTMLAttributes } from 'vue';
import { TooltipArrow, TooltipContent, TooltipPortal, useForwardPropsEmits } from 'reka-ui';
import { cn } from '../../utils';

defineOptions({
  inheritAttrs: false,
});

const {
  class: className = undefined,
  sideOffset = 4,
  ...props
} = defineProps<TooltipContentProps & { class?: HTMLAttributes['class'] }>();

const emits = defineEmits<TooltipContentEmits>();

const forwarded = useForwardPropsEmits(props, emits);
</script>

<template>
  <TooltipPortal>
    <TooltipContent
      data-slot="tooltip-content"
      v-bind="{ ...forwarded, ...$attrs }"
      :side-offset="sideOffset"
      :class="
        cn(
          'bg-primary text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit rounded-md px-3 py-1.5 text-xs text-balance',
          className,
        )
      "
    >
      <slot />

      <TooltipArrow
        class="bg-primary fill-primary z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px]"
      />
    </TooltipContent>
  </TooltipPortal>
</template>
