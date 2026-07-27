<script lang="ts">
export type ToastVariant = "info" | "success" | "warning" | "destructive" | "ai";
</script>

<script setup lang="ts">
import { ToastProvider, ToastViewport } from "reka-ui";
import ToastItem from "./ToastItem.vue";

/**
 * Toast — a transient, self-dismissing notification the user need not act on
 * (a save confirmed, an export finished, a recoverable error). Built on Reka
 * UI's Toast: it announces to assistive tech (`role`/`aria-live`), pauses on
 * hover/focus, and is swipe/Esc dismissible.
 *
 * Presentational and self-contained — the provider + viewport are bundled so a
 * single Toast works standalone (the card itself lives in the internal
 * `ToastItem`), and it stays free of any queue logic: the host owns *when*
 * toasts open (this primitive renders one). An app showing many at once keeps
 * its own queue and renders it through the `ToastStack` block, which shares
 * ONE provider/viewport so simultaneous toasts stack instead of overlapping —
 * the queue itself stays a host concern, deliberately not baked into the
 * design-system unit.
 *
 * For a blocking confirmation use `Dialog`; for a persistent field/section error
 * that must stay until resolved use `InlineError`.
 */
withDefaults(
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
</script>

<template>
  <ToastProvider>
    <ToastItem
      :open="open"
      :title="title"
      :description="description"
      :variant="variant"
      :duration="duration"
      :closable="closable"
      :action-label="actionLabel"
      @update:open="$emit('update:open', $event)"
      @action="$emit('action')"
    />

    <ToastViewport
      class="fixed bottom-0 right-0 z-[100] flex w-[min(92vw,24rem)] flex-col gap-2 p-4 outline-none"
    />
  </ToastProvider>
</template>
