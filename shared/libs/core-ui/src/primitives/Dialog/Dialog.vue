<script setup lang="ts">
import {
  DialogRoot,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "reka-ui";
import { X } from "@lucide/vue";
import { cn } from "../../lib/cn";

/**
 * Dialog — a modal task surface that blocks the rest of the UI until resolved
 * (confirm a destructive action, a focused form). Built on Reka UI's Dialog:
 * focus trap, Esc-to-close, `aria-modal`, and the title wired as the accessible
 * name. Loom tokens.
 *
 * Reach for `Popover` instead when the panel is non-blocking secondary content,
 * and `Toast` for a transient notification the user need not act on. The title
 * is a required prop, not optional chrome: Reka warns (and screen readers lose
 * the accessible name) without a `DialogTitle`, so it is always rendered — pass
 * `hideTitle` to keep it for assistive tech while removing it visually.
 *
 * `size` widens the content panel for task surfaces that outgrow the confirm
 * box: `md` (default, 32rem) for confirms and short forms, `lg` (44rem) for
 * multi-section forms, `xl` (64rem) for authoring surfaces (an editor living
 * in a dialog). Width stays the primitive's decision — no class passthrough.
 */
const SIZE_CLASS = {
  md: "w-[min(92vw,32rem)]",
  lg: "w-[min(92vw,44rem)]",
  xl: "w-[min(94vw,64rem)]",
} as const;

withDefaults(
  defineProps<{
    open?: boolean;
    title: string;
    description?: string;
    /** Keep the title for screen readers but drop it from the visual layout. */
    hideTitle?: boolean;
    /** Show the top-right close affordance (Esc and overlay click always work). */
    closable?: boolean;
    /** Content width: md = confirm/short form, lg = multi-section form, xl = authoring surface. */
    size?: "md" | "lg" | "xl";
  }>(),
  { open: undefined, description: undefined, hideTitle: false, closable: true, size: "md" },
);

defineEmits<{ "update:open": [value: boolean] }>();
</script>

<template>
  <DialogRoot :open="open" @update:open="$emit('update:open', $event)">
    <DialogTrigger v-if="$slots.trigger" as-child>
      <slot name="trigger" />
    </DialogTrigger>

    <DialogPortal>
      <!-- 70% scrim: heavy enough that the page behind reads as context, not
           competing content (60% left it legible through the overlay). -->
      <DialogOverlay class="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-fade" />
      <DialogContent
        :class="
          cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            SIZE_CLASS[size],
            'rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg outline-none',
            // Scoped to the open state, never unconditional: keeps Reka's
            // Presence from stranding a closed, input-blocking overlay while it
            // waits for an animationend a mount-only animation never re-fires
            // (see the same note in Select.vue / Popover.vue).
            'data-[state=open]:animate-scale-in',
          )
        "
      >
        <DialogTitle :class="cn('text-base font-semibold', hideTitle && 'sr-only')">
          {{ title }}
        </DialogTitle>
        <DialogDescription v-if="description" class="mt-1 text-sm text-muted-foreground">
          {{ description }}
        </DialogDescription>

        <div :class="cn((description || !hideTitle) && 'mt-4')">
          <slot />
        </div>

        <div v-if="$slots.footer" class="mt-6 flex items-center justify-end gap-2">
          <slot name="footer" />
        </div>

        <DialogClose
          v-if="closable"
          aria-label="Đóng"
          class="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast ease-out hover:bg-subtle hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <X class="h-4 w-4" />
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
