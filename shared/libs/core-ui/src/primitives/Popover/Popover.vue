<script setup lang="ts">
import {
  PopoverRoot,
  PopoverTrigger,
  PopoverPortal,
  PopoverContent,
  PopoverArrow,
  type PopoverContentProps,
} from "reka-ui";
import { cn } from "../../lib/cn";

/**
 * Popover — a floating panel anchored to a trigger for secondary content the
 * user opts into (filters, a colour picker, a details card). Built on Reka
 * UI's Popover: focus moves into the panel, Esc/outside-click closes,
 * `aria-expanded`/`aria-controls` wired. Alloy tokens.
 *
 * Compared to the neighbours: reach for `DropdownMenu` when the panel is a list
 * of *commands* (roving focus, typeahead), `Tooltip` for a non-interactive hint
 * on hover/focus, and `Dialog` when the task must block the rest of the UI.
 *
 * `#trigger` is rendered `as-child` so the caller's own Button *is* the
 * trigger (no wrapper element swallows its accessible name); the default slot
 * is the panel body.
 */
withDefaults(
  defineProps<{
    open?: boolean;
    side?: PopoverContentProps["side"];
    align?: PopoverContentProps["align"];
    sideOffset?: number;
    /** Hide the little pointer notch when the panel reads better flush. */
    arrow?: boolean;
  }>(),
  { open: undefined, side: "bottom", align: "center", sideOffset: 6, arrow: true },
);

defineEmits<{ "update:open": [value: boolean] }>();
</script>

<template>
  <PopoverRoot :open="open" @update:open="$emit('update:open', $event)">
    <PopoverTrigger as-child>
      <slot name="trigger" />
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        :side="side"
        :align="align"
        :side-offset="sideOffset"
        :class="
          cn(
            'z-50 min-w-[12rem] max-w-[min(90vw,22rem)] rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-md outline-none',
            // Scoped to the open state, never unconditional: Reka's Presence
            // keeps the closed content mounted while it waits for an
            // animationend a mount-only animation never fires again — scoping
            // makes the closed element compute animation-name: none, Presence's
            // immediate-unmount branch (see the same note in Select.vue). The
            // panel grows from the trigger via the popper transform-origin below.
            'data-[state=open]:animate-scale-in',
          )
        "
        style="transform-origin: var(--reka-popper-transform-origin)"
      >
        <slot />
        <PopoverArrow v-if="arrow" class="fill-popover" :width="12" :height="6" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
