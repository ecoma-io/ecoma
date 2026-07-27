<script setup lang="ts">
import { TriangleAlert } from "@lucide/vue";
import { cn } from "../../lib/cn";

/**
 * InlineError — the unified error contract: `text-destructive`
 * token + `role="alert"`, one component instead of the four ad-hoc shapes it
 * replaces. Field/section-level and persists until the host resolves the
 * underlying cause (no auto-dismiss timer) — contrast the document-level
 * conflict/invalid banner pattern (P10), which is dismissible/sticky at the
 * top of a whole surface. Reach for InlineError next to the control/section
 * it explains (a form field, a project card, a panel); reach for a banner
 * when the issue applies to the whole open document instead of one part of it.
 *
 * Purely presentational — no i18n import (I1): the message is a prop or the
 * default slot, and no fallback text ships with the component.
 */
withDefaults(defineProps<{ message?: string }>(), { message: undefined });
</script>

<template>
  <div
    role="alert"
    :class="
      cn(
        'flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive',
        'animate-fade-rise',
      )
    "
  >
    <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <slot>{{ message }}</slot>
    </div>
    <div v-if="$slots.action" class="shrink-0"><slot name="action" /></div>
  </div>
</template>
