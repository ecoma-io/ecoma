<script setup lang="ts">
import { CheckboxIndicator, CheckboxRoot } from "reka-ui";
import { Check, Minus } from "@lucide/vue";
import { cn } from "../../lib/cn";

/**
 * Checkbox — a single boolean choice inside a form (as opposed to Switch,
 * which flips a setting immediately, no form/"Save" involved). Built on Reka
 * UI's Checkbox (role="checkbox" + aria-checked, Space toggles); also
 * supports the third "indeterminate" state for a parent checkbox over a
 * partially-selected group — shown as a dash instead of a check.
 *
 * An inline `label` wraps the control in a real `<label>` (a11y name comes
 * free); omit it and pass `ariaLabel`/`ariaLabelledby` instead when the
 * visible label lives elsewhere (e.g. a table header cell).
 */
const props = withDefaults(
  defineProps<{
    modelValue?: boolean | "indeterminate";
    disabled?: boolean;
    label?: string;
    ariaLabel?: string;
    ariaLabelledby?: string;
  }>(),
  {
    modelValue: false,
    disabled: false,
    label: undefined,
    ariaLabel: undefined,
    ariaLabelledby: undefined,
  },
);

defineEmits<{ "update:modelValue": [value: boolean | "indeterminate"] }>();

const boxClass = cn(
  "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-input bg-background",
  // Transform (the press squish) rides --ease-spring for a restrained release,
  // while fill/border stay on the instant --ease-out — the "springy transform,
  // steady color" split (boxStyle below), same language as Button/Switch.
  "active:scale-90",
  // Checked = a human decision (Loom law): the box fills flat warp.
  "data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
  "data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground",
  // Focus draws the weave tight: the brand ring blooms.
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:shadow-halo",
  "disabled:cursor-not-allowed",
);

const boxStyle =
  "transition: transform var(--dur-fast) var(--ease-spring), background-color var(--dur-instant) var(--ease-out), border-color var(--dur-instant) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);";
</script>

<template>
  <!-- CheckboxRoot is a labelable <button role="checkbox">, so wrapping it in
       <label> names it exactly like a native control; the rule's nesting/id
       heuristic just doesn't recognize reka-ui's custom element as a
       "control" (pre-existing false positive on this same shape in
       Field.vue's for-only <label>). -->
  <!-- eslint-disable-next-line vuejs-accessibility/label-has-for -->
  <label
    v-if="label"
    :class="
      cn(
        'inline-flex items-center gap-2 text-sm text-foreground',
        // Disabled text stays readable (AA on the light ground) — only the box dims.
        props.disabled ? 'cursor-not-allowed text-muted-foreground' : 'cursor-pointer',
      )
    "
  >
    <CheckboxRoot
      :model-value="modelValue"
      :disabled="disabled"
      :class="cn(boxClass, 'disabled:opacity-50')"
      :style="boxStyle"
      @update:model-value="$emit('update:modelValue', $event)"
    >
      <template #default="{ state }">
        <!-- The tick pops in with scale-in — a small causal "it's checked now".
             stroke-width 2.5 is the Iconography ≤12px rule, not a local taste:
             the inherited 1.5 renders 0.75 device px at 12 and reads washed
             out inside the filled box. Both branches carry it identically. -->
        <CheckboxIndicator class="flex animate-scale-in items-center justify-center text-current">
          <Minus v-if="state === 'indeterminate'" class="h-3 w-3" :stroke-width="2.5" />
          <Check v-else class="h-3 w-3" :stroke-width="2.5" />
        </CheckboxIndicator>
      </template>
    </CheckboxRoot>
    {{ label }}
  </label>
  <!-- The control always dims itself when disabled; label text stays
       readable muted — same stance in both branches. -->
  <CheckboxRoot
    v-else
    :model-value="modelValue"
    :disabled="disabled"
    :aria-label="ariaLabel"
    :aria-labelledby="ariaLabelledby"
    :class="cn(boxClass, 'disabled:opacity-50')"
    :style="boxStyle"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template #default="{ state }">
      <CheckboxIndicator class="flex animate-scale-in items-center justify-center text-current">
        <Minus v-if="state === 'indeterminate'" class="h-3 w-3" :stroke-width="2.5" />
        <Check v-else class="h-3 w-3" :stroke-width="2.5" />
      </CheckboxIndicator>
    </template>
  </CheckboxRoot>
</template>
