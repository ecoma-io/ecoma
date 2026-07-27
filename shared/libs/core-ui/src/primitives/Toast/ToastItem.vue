<script setup lang="ts">
import { computed } from "vue";
import { ToastRoot, ToastTitle, ToastDescription, ToastAction, ToastClose } from "reka-ui";
import { Info, CircleCheck, TriangleAlert, CircleX, Sparkles, X } from "@lucide/vue";
import { cn } from "../../lib/cn";
import type { ToastVariant } from "./Toast.vue";

/**
 * ToastItem — one toast card (ToastRoot + Alloy treatment), INTERNAL to
 * the design system. It must live inside a `ToastProvider` whose
 * `ToastViewport` it teleports into: `Toast` bundles that pair for the
 * standalone case, `ToastStack` (blocks) shares one pair across a host queue
 * so simultaneous toasts stack in the single viewport instead of overlapping.
 * Not exported from the barrel — hosts use `Toast` or `ToastStack`.
 */
const props = withDefaults(
  defineProps<{
    open?: boolean;
    title: string;
    description?: string;
    variant?: ToastVariant;
    /** ms before auto-dismiss; the Reka default pauses on hover/focus. */
    duration?: number;
    closable?: boolean;
    /** Renders a single inline action button; emits `action` when pressed. */
    actionLabel?: string;
  }>(),
  {
    open: undefined,
    description: undefined,
    variant: "info",
    duration: 5000,
    closable: true,
    actionLabel: undefined,
  },
);

defineEmits<{ "update:open": [value: boolean]; action: [] }>();

const accent = computed(
  () =>
    ({
      info: { icon: Info, color: "text-info" },
      success: { icon: CircleCheck, color: "text-success" },
      warning: { icon: TriangleAlert, color: "text-warning" },
      destructive: { icon: CircleX, color: "text-destructive" },
      ai: { icon: Sparkles, color: "text-primary" },
    })[props.variant],
);
</script>

<template>
  <!-- The slide-in animation rides this inner card, never ToastRoot: Reka
       drives ToastRoot's own transform for the swipe-to-dismiss gesture, so a
       filled entrance transform there would freeze the swipe. ToastRoot itself
       carries no animation, so Reka Presence unmounts it immediately on close. -->
  <ToastRoot
    :open="open"
    :duration="duration"
    class="outline-none"
    @update:open="$emit('update:open', $event)"
  >
    <div
      :class="
        cn(
          'relative flex animate-toast-in items-start gap-3 rounded-md border border-border bg-popover p-3 pr-8 text-popover-foreground shadow-lg',
          // Agent emission (Signature law): an AI-authored toast breathes a
          // Conduct pulse — the one variant driven by an agent, made visible.
          variant === 'ai' && 'border-primary/40',
        )
      "
    >
      <span
        v-if="variant === 'ai'"
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 rounded-md animate-conduct"
      />
      <component
        :is="accent.icon"
        :class="cn('mt-0.5 h-4 w-4 shrink-0', accent.color)"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <ToastTitle class="text-sm font-medium">{{ title }}</ToastTitle>
        <ToastDescription v-if="description" class="mt-0.5 text-xs text-muted-foreground">
          {{ description }}
        </ToastDescription>
      </div>

      <ToastAction v-if="actionLabel" :alt-text="actionLabel" as-child @click="$emit('action')">
        <button
          type="button"
          class="shrink-0 rounded-sm px-2 py-1 text-xs font-medium text-primary transition-colors duration-fast ease-out hover:bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {{ actionLabel }}
        </button>
      </ToastAction>

      <ToastClose
        v-if="closable"
        aria-label="Đóng"
        class="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-fast ease-out hover:bg-subtle hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <X class="h-3.5 w-3.5" />
      </ToastClose>
    </div>
  </ToastRoot>
</template>
