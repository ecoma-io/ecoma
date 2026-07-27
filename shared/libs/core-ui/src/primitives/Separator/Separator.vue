<script setup lang="ts">
import { Separator as SeparatorRoot } from "reka-ui";
import { cn } from "../../lib/cn";

/**
 * Separator — thin visual/semantic divider between content groups (a
 * settings section break, a toolbar group boundary). Built on Reka UI's
 * Separator: `role="separator"` unless `decorative` (the common case —
 * visual dividers next to already-structured content don't need a second
 * landmark), matching `orientation` via `aria-orientation`.
 */
withDefaults(
  defineProps<{
    orientation?: "horizontal" | "vertical";
    decorative?: boolean;
  }>(),
  { orientation: "horizontal", decorative: true },
);
</script>

<template>
  <SeparatorRoot
    :orientation="orientation"
    :decorative="decorative"
    :class="
      cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px self-stretch',
      )
    "
  />
</template>
