<script lang="ts">
import { cva, type VariantProps } from "class-variance-authority";

/**
 * Surface — the panel/card primitive. Elevation is expressed by hairline
 * borders and background lightness, not heavy shadows (Alloy principle:
 * "hairline over shadow"): on the paper-light ground a white `card` already
 * reads as raised, so only `overlay` carries a real shadow.
 */
export const surfaceVariants = cva("rounded-lg transition-colors duration-fast", {
  variants: {
    variant: {
      card: "bg-card text-card-foreground border border-border",
      muted: "bg-muted text-foreground border border-transparent",
      overlay: "bg-popover text-popover-foreground border border-border shadow-md",
    },
    pad: { none: "p-0", sm: "p-3", md: "p-4", lg: "p-6" },
    // The ONE hover/press language for clickable rows and cards (a list row,
    // a picker card): lift by fill, hairline asserts, cursor signals — so
    // views stop hand-rolling their own `hover:bg-subtle` treatments. The
    // Surface stays a div; the host owns the actual click/role/tabindex.
    interactive: {
      true: "cursor-pointer hover:bg-subtle/60 hover:border-border-strong active:bg-subtle",
    },
  },
  defaultVariants: { variant: "card", pad: "md" },
});

export type SurfaceVariants = VariantProps<typeof surfaceVariants>;
</script>

<script setup lang="ts">
import { cn } from "../../lib/cn";

withDefaults(
  defineProps<{
    variant?: SurfaceVariants["variant"];
    pad?: SurfaceVariants["pad"];
    /** Clickable-surface language: hover fill lift, strong hairline, cursor. The host owns the click handler. */
    interactive?: boolean;
  }>(),
  { variant: "card", pad: "md", interactive: false },
);
</script>

<template>
  <div :class="cn(surfaceVariants({ variant, pad, interactive }))"><slot /></div>
</template>
