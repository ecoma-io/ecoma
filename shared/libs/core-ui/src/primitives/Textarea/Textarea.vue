<script setup lang="ts">
import { cn } from "../../lib/cn";
import { useSplitAttrs } from "../../lib/attrs";

/**
 * Textarea — multi-line text entry. A native `<textarea>`, single node (no
 * wrapper — unlike TextField there are no `#leading`/`#trailing` adornments to
 * frame), so `class` and the rest of the fallthrough attrs both target the
 * same element; still routed through `useSplitAttrs()` for the same reason as
 * every other primitive — a caller's `class` needs a Tailwind-aware `cn()`
 * merge, not raw `v-bind` clobbering. The accessible name is a first-class
 * prop pair (`aria-label`/`aria-labelledby`, camelized by Vue) bound onto the
 * textarea explicitly, same contract as TextField.
 */
defineOptions({ inheritAttrs: false });
const { attrs, rest: textareaAttrs } = useSplitAttrs();

withDefaults(
  defineProps<{
    modelValue?: string;
    placeholder?: string;
    disabled?: boolean;
    /** Error state: paints the destructive border/ring and sets aria-invalid. */
    invalid?: boolean;
    rows?: number;
    resize?: "none" | "vertical";
    ariaLabel?: string;
    ariaLabelledby?: string;
  }>(),
  {
    modelValue: undefined,
    placeholder: undefined,
    disabled: false,
    invalid: false,
    rows: 3,
    resize: "vertical",
    ariaLabel: undefined,
    ariaLabelledby: undefined,
  },
);

defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <textarea
    v-bind="textareaAttrs"
    :aria-label="ariaLabel"
    :aria-labelledby="ariaLabelledby"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :rows="rows"
    :aria-invalid="invalid || undefined"
    :class="
      cn(
        'rounded-md border border-input bg-background text-foreground px-3 py-2 text-sm',
        'transition-[color,background-color,border-color,box-shadow] duration-fast ease-out',
        // Rim-lit at rest, alloy bloom on focus (Signature law).
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        !invalid && 'focus-visible:shadow-halo',
        'placeholder:text-muted-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50',
        invalid && 'border-destructive focus-visible:outline-destructive',
        resize === 'none' ? 'resize-none' : 'resize-y',
        attrs.class as string,
      )
    "
    @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>
