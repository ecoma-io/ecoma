<script lang="ts">
import { cva, type VariantProps } from "class-variance-authority";

// A faint light band sweeps a muted base (background-color muted + a moving
// transparent→light→transparent gradient image) — the shimmer language,
// kept neutral and low-contrast so a loading page reads as "coming", not busy.
// Under prefers-reduced-motion the sweep simply stops on a flat muted block.
export const skeletonVariants = cva(
  "bg-muted bg-[linear-gradient(90deg,transparent_0%,hsl(var(--foreground)/0.06)_50%,transparent_100%)] bg-[length:200%_100%] animate-shimmer",
  {
    variants: {
      variant: {
        text: "h-4 rounded",
        circle: "rounded-full",
        rect: "rounded-md",
      },
    },
    defaultVariants: { variant: "text" },
  },
);

export type SkeletonVariants = VariantProps<typeof skeletonVariants>;
</script>

<script setup lang="ts">
import { cn } from "../../lib/cn";

/**
 * Skeleton — content-loading placeholder for a KNOWN layout (a card, a list
 * row, an avatar) so the page's shape reads as "coming" instead of jumping
 * once real content lands. For an indeterminate wait with no layout shape
 * yet, use Spinner instead. Purely decorative (`aria-hidden`) — the loading
 * state itself is announced elsewhere (e.g. a Spinner or a live region), not
 * by the placeholder shapes. Width/height are the caller's concern via a
 * passthrough `class` (e.g. `class="h-10 w-10"`).
 */
withDefaults(defineProps<{ variant?: SkeletonVariants["variant"] }>(), { variant: "text" });
</script>

<template>
  <div aria-hidden="true" :class="cn(skeletonVariants({ variant }))" />
</template>
