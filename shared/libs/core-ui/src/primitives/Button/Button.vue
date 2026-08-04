<script lang="ts">
import { cva, type VariantProps } from "class-variance-authority";

/**
 * Button — the workhorse. Encodes the Loom press language:
 *   • hover lifts by fill, not shadow
 *   • active presses down (scale 0.97) — physical, causal feedback
 *   • focus blooms the brand ring
 *   • loading plays a kinetic swap under the shimmer: the label rolls
 *     up and out, a progress arc springs in, the loading text rises last —
 *     both layers share one grid cell so the width never jumps mid-film
 *
 * The 50% dim belongs to a *disabled* button only — it is applied in the
 * template off the `disabled` prop, not off the DOM disabled state, because
 * a loading button is also DOM-disabled yet must read as "working", not
 * "unavailable".
 */
export const buttonVariants = cva(
  [
    "relative inline-flex items-center justify-center gap-2 whitespace-nowrap select-none",
    "rounded-md text-sm font-medium",
    "[transition:transform_var(--dur-fast)_var(--ease-spring),background-color_var(--dur-fast)_var(--ease-out),color_var(--dur-fast)_var(--ease-out),box-shadow_var(--dur-fast)_var(--ease-out)]",
    "active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:shadow-halo",
    "disabled:pointer-events-none",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        subtle: "bg-transparent text-foreground hover:bg-subtle",
        outline: "border border-input bg-transparent text-foreground hover:bg-subtle",
        ghost: "bg-transparent text-muted-foreground hover:bg-subtle hover:text-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-11 px-6 text-base",
        icon: "h-9 w-9 p-0",
        // Square icon button for dense rows, matching `sm`'s height so a row
        // action lines up with a row's text controls. Still 32px — well over
        // the 24px minimum target size (WCAG 2.2 SC 2.5.8) — so density here
        // costs no reachability. Exists because consumers were reaching for
        // `size="icon"` and then hand-overriding `class="h-8 w-8"`, which
        // silently re-litigates the target-size question at every call site.
        "icon-sm": "h-8 w-8 p-0",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;
</script>

<script setup lang="ts">
import { cn } from "../../lib/cn";

withDefaults(
  defineProps<{
    variant?: ButtonVariants["variant"];
    size?: ButtonVariants["size"];
    /** Locks the button and plays the kinetic swap (label → arc + loadingText). */
    loading?: boolean;
    /** Text shown next to the progress arc while loading (e.g. "Đang lưu…"). */
    loadingText?: string;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
  }>(),
  { variant: "primary", size: "md", loading: false, disabled: false, type: "button" },
);
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :data-loading="loading || undefined"
    :aria-busy="loading || undefined"
    :class="cn(buttonVariants({ variant, size }), 'group', disabled && 'opacity-50')"
    style="
      transition:
        transform var(--dur-fast) var(--ease-spring),
        background-color var(--dur-fast) var(--ease-out),
        color var(--dur-fast) var(--ease-out),
        box-shadow var(--dur-fast) var(--ease-out);
    "
  >
    <!-- Shimmer sweep while loading -->
    <span
      v-if="loading"
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 rounded-md bg-[linear-gradient(110deg,transparent_35%,hsl(var(--primary)/0.25)_50%,transparent_65%)] bg-[length:220%_100%] animate-shimmer"
    />
    <!-- Kinetic swap: both layers live in the same grid cell, so the button
         keeps the width of the widest one and nothing jumps mid-swap. Only
         the layer for the current state is exposed to assistive tech; the
         other is aria-hidden (opacity alone does not hide it from AT). -->
    <span class="inline-grid place-items-center">
      <!-- Beat 1 — the label rolls up and out -->
      <span
        :aria-hidden="loading || undefined"
        class="[grid-area:1/1] inline-flex items-center gap-2 transition-[opacity,transform] duration-fast ease-out group-data-[loading]:-translate-y-1 group-data-[loading]:opacity-0"
      >
        <slot />
      </span>
      <span
        :aria-hidden="!loading || undefined"
        class="pointer-events-none [grid-area:1/1] inline-flex items-center gap-2"
      >
        <!-- Beat 2 — the progress arc springs in from below. The spinning svg
             sits inside a wrapper because animate-spin owns `transform`: the
             entry scale/translate must live on a separate element or the spin
             keyframe would overwrite them. Same arc as the standalone Spinner,
             inlined aria-hidden: Spinner's role="status" contract is wrong
             inside an aria-busy button (double announcement). -->
        <span
          class="transition-[opacity,transform] duration-fast ease-spring opacity-0 scale-50 translate-y-1 group-data-[loading]:translate-y-0 group-data-[loading]:scale-100 group-data-[loading]:opacity-100"
        >
          <svg class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle class="stroke-current opacity-25" cx="12" cy="12" r="10" stroke-width="4" />
            <path
              class="fill-current opacity-75"
              d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        </span>
        <!-- Beat 3 — the loading text rises last. The stagger delay applies on
             entry only (exit keeps delay 0 so the film cuts out clean), and is
             cancelled under reduced motion so the instant swap is not lagged. -->
        <span
          v-if="loadingText"
          class="transition-[opacity,transform] duration-100 ease-out opacity-0 translate-y-1 group-data-[loading]:translate-y-0 group-data-[loading]:opacity-100 group-data-[loading]:delay-75 motion-reduce:group-data-[loading]:delay-0"
        >
          {{ loadingText }}
        </span>
      </span>
    </span>
  </button>
</template>
