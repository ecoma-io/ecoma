<script lang="ts">
import { cva, type VariantProps } from "class-variance-authority";

export const spinnerVariants = cva("animate-spin text-current", {
  variants: {
    size: {
      sm: "h-4 w-4",
      md: "h-5 w-5",
      lg: "h-8 w-8",
    },
  },
  defaultVariants: { size: "md" },
});

export type SpinnerVariants = VariantProps<typeof spinnerVariants>;
</script>

<script setup lang="ts">
import { cn } from "../../lib/cn";

/**
 * Spinner — indeterminate loading indicator: the wait has no known length or
 * layout shape yet (e.g. waiting on a network request). Once the layout IS
 * known (a card, a list row), use Skeleton instead so the placeholder already
 * reads as the coming content.
 *
 * The root carries `role="status"` + `aria-label` (from `label`) so screen
 * readers announce the wait; the decorative SVG arc is `aria-hidden` since
 * the label already carries the meaning. Color inherits from the caller via
 * `text-current`/`stroke-current`/`fill-current` — set text color on an
 * ancestor, never hardcode it here.
 */
withDefaults(
  defineProps<{
    size?: SpinnerVariants["size"];
    label?: string;
  }>(),
  { size: "md", label: "Đang tải" },
);
</script>

<template>
  <span role="status" :aria-label="label" class="inline-flex">
    <svg :class="cn(spinnerVariants({ size }))" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle class="stroke-current opacity-25" cx="12" cy="12" r="10" stroke-width="4" />
      <path class="fill-current opacity-75" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  </span>
</template>
