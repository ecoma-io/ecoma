<script setup lang="ts">
import {
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
  TooltipArrow,
  type TooltipContentProps,
} from "reka-ui";
import { cn } from "../../lib/cn";

/**
 * Tooltip — a short, non-interactive hint shown on hover/focus of its trigger
 * (a label for an icon-only button, a terse explanation). Built on Reka UI's
 * Tooltip: pointer + keyboard focus open it, Esc/blur close it, and it is wired
 * as `aria-describedby` — so it *supplements* an accessible name, it must never
 * be the only source of one (an icon button still needs its own `aria-label`).
 *
 * Reach for `Popover` when the content is interactive, and `DropdownMenu` for a
 * command list. The provider is bundled in so a lone Tooltip works out of the
 * box; an app with many can hoist a single Reka `TooltipProvider` higher later.
 */
withDefaults(
  defineProps<{
    content?: string;
    side?: TooltipContentProps["side"];
    sideOffset?: number;
    /** ms before the tip appears on hover (keyboard focus is immediate). */
    delay?: number;
    open?: boolean;
  }>(),
  { content: undefined, side: "top", sideOffset: 6, delay: 300, open: undefined },
);

defineEmits<{ "update:open": [value: boolean] }>();
</script>

<template>
  <TooltipProvider :delay-duration="delay">
    <TooltipRoot :open="open" @update:open="$emit('update:open', $event)">
      <TooltipTrigger as-child>
        <slot name="trigger" />
      </TooltipTrigger>

      <TooltipPortal>
        <TooltipContent
          :side="side"
          :side-offset="sideOffset"
          :class="
            cn(
              'z-50 max-w-[16rem] rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-md',
              // Scoped to the open state (see Select.vue / Popover.vue): a closed
              // tip computes animation-name: none so Reka Presence unmounts it at
              // once instead of leaving a stray node waiting on an animationend.
              // Only the hover-delayed open animates (keyboard focus is instant);
              // it grows from the anchored element via the popper origin below.
              'data-[state=delayed-open]:animate-scale-in',
            )
          "
          style="transform-origin: var(--reka-popper-transform-origin)"
        >
          <slot>{{ content }}</slot>
          <TooltipArrow class="fill-foreground" :width="10" :height="5" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
