<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from "reka-ui";
import { cn } from "../../lib/cn";

/**
 * Switch — toggles a boolean setting that takes effect immediately (no "Save").
 * Built on Reka UI's Switch for role="switch" + aria-checked + Space/Enter.
 * Label/description live on the surrounding setting row (aria-labelledby).
 */
withDefaults(
  defineProps<{
    modelValue?: boolean;
    disabled?: boolean;
  }>(),
  { modelValue: false, disabled: false },
);

defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <SwitchRoot
    :model-value="modelValue"
    :disabled="disabled"
    :class="
      cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent',
        'transition-[background-color,filter,box-shadow] duration-instant ease-out',
        'hover:brightness-95',
        // Checked = a human decision (Alloy law): the track fills flat steel.
        'data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted-foreground/30',
        // Focus opens the alloy: the brand ring blooms.
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:shadow-halo',
        'disabled:cursor-not-allowed disabled:opacity-50',
      )
    "
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <SwitchThumb
      style="
        transition:
          left var(--dur-instant) var(--ease-out),
          transform var(--dur-fast) var(--ease-spring);
      "
      :class="
        cn(
          'absolute top-1/2 left-0.5 block h-4 w-4 -translate-y-1/2 rounded-full bg-background shadow-sm',
          'active:scale-x-[1.15] active:scale-y-[0.85]',
          'data-[state=checked]:left-[1.125rem]',
        )
      "
    />
  </SwitchRoot>
</template>
