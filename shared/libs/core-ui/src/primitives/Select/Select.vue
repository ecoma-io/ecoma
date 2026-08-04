<script lang="ts">
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
</script>

<script setup lang="ts">
import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPortal,
  SelectContent,
  SelectViewport,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
} from "reka-ui";
import { Check, ChevronDown } from "@lucide/vue";
import { cn } from "../../lib/cn";
import { listStaggerDelay } from "../../lib/motion";
import { useSplitAttrs } from "../../lib/attrs";

// SelectRoot renders no DOM node, so route fallthrough attrs (data-testid,
// aria-*) to the interactive trigger instead of dropping them. `class` is
// pulled out and merged through `cn()` (Tailwind-aware, last-wins) rather
// than left in the `v-bind="$attrs"` spread — spreading `class` alongside
// SelectTrigger's own `:class` binding only concatenates the two class lists
// (Vue's generic prop merge, not Tailwind-aware), so a caller's sizing class
// (e.g. `w-28`) can silently lose the cascade to the trigger's own `w-full`
// depending on Tailwind's generated declaration order — as it did here.
defineOptions({ inheritAttrs: false });
const { attrs, rest: triggerAttrs } = useSplitAttrs();

/**
 * Select — pick one value from a closed list (~3–15 items) via a compact
 * trigger + popover listbox. Built on Reka UI's Select: arrow-key navigation,
 * typeahead, Esc-to-close, aria-expanded/haspopup="listbox". Loom tokens.
 */
withDefaults(
  defineProps<{
    modelValue?: string;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    /** Error state: paints the destructive border/ring and sets aria-invalid. */
    invalid?: boolean;
    /** Heights match TextField's scale so mixed form rows stay aligned. */
    size?: "sm" | "md" | "lg";
  }>(),
  {
    modelValue: undefined,
    placeholder: undefined,
    disabled: false,
    invalid: false,
    size: "md",
  },
);

defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <SelectRoot
    :model-value="modelValue"
    :disabled="disabled"
    @update:model-value="$emit('update:modelValue', String($event))"
  >
    <SelectTrigger
      v-bind="triggerAttrs"
      :aria-invalid="invalid || undefined"
      :data-invalid="invalid || undefined"
      :class="
        cn(
          'group inline-flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background text-foreground',
          'transition-[color,background-color,box-shadow] duration-fast ease-out hover:bg-subtle',
          // Rim-lit at rest, the weave blooms on focus (Signature law).
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          !invalid && 'focus-visible:shadow-halo',
          size === 'sm' && 'h-8 px-2.5 text-xs',
          size === 'md' && 'h-9 px-3 text-sm',
          size === 'lg' && 'h-11 px-4 text-base',
          invalid && 'border-destructive focus-visible:outline-destructive',
          'disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground',
          attrs.class as string,
        )
      "
    >
      <SelectValue :placeholder="placeholder" />
      <SelectIcon class="shrink-0 text-muted-foreground">
        <ChevronDown
          class="h-4 w-4 transition-transform duration-fast ease-out group-data-[state=open]:rotate-180"
        />
      </SelectIcon>
    </SelectTrigger>

    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="6"
        :class="
          cn(
            'z-50 min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md',
            // Scoped to the open state, never unconditional: Reka's Presence
            // keeps the closed content mounted (an invisible input-blocking
            // overlay) while it waits for an animationend that a mount-only
            // animation never fires again — scoping makes the closed element
            // compute animation-name: none, which is Presence's unconditional
            // immediate-unmount branch (usePresence.ts getAnimationName).
            'data-[state=open]:animate-fade-rise',
          )
        "
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="(opt, i) in options"
            :key="opt.value"
            :value="opt.value"
            :disabled="opt.disabled"
            :style="{ animationDelay: listStaggerDelay(i) }"
            :class="
              cn(
                'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-3 py-1.5 pr-8 text-sm text-foreground outline-none',
                'transition-colors duration-fast ease-out',
                'animate-fade-rise',
                'data-[highlighted]:bg-subtle',
                'data-[state=checked]:bg-primary-muted data-[state=checked]:text-primary',
                'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
              )
            "
          >
            <SelectItemText>{{ opt.label }}</SelectItemText>
            <SelectItemIndicator class="absolute right-2 inline-flex items-center">
              <Check class="h-4 w-4" />
            </SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
