<script setup lang="ts">
/* eslint vuejs-accessibility/label-has-for: ["error", { "required": "id" }] */
/*
 * The workspace default for this rule requires BOTH a `for`/id pairing AND
 * the control physically nested inside the `<label>` (`required: {every:
 * ["nesting","id"]}`). Field labels a control passed through the default
 * slot — never nested inside the `<label>` — so "nesting" can never be
 * satisfied by any slot-based composition, regardless of how the label is
 * written. The `for`/id pairing below is itself a fully valid, standard
 * accessible-name association (WCAG 1.3.1 / 4.1.2); this override scopes the
 * rule to that single valid strategy for this file only. */
import InlineError from "../InlineError/InlineError.vue";

/**
 * Field — a form-row wrapper that pairs a label + control + optional hint +
 * error, so callers stop hand-rolling label/error layout around TextField /
 * Select / Textarea / etc. Pure composition, not a reka component: the
 * default slot is the control. Setting `error` renders `InlineError` with the
 * message and suppresses `hint` (one message at a time, not both stacked).
 *
 * `for` names the control this labels (its `id`). A `<label>` only renders
 * when both `label` and `for` are set; `label` alone (no `for`) falls back to
 * a plain `<span>` so the row still reads visually without emitting an
 * unassociated label (see the rule-scoping note above the imports).
 */
withDefaults(
  defineProps<{
    label?: string;
    hint?: string;
    error?: string;
    required?: boolean;
    for?: string;
  }>(),
  {
    label: undefined,
    hint: undefined,
    error: undefined,
    required: false,
    for: undefined,
  },
);
</script>

<template>
  <div class="flex flex-col gap-1.5">
    <label v-if="label && $props.for" :for="$props.for" class="text-sm font-medium text-foreground">
      {{ label }} <span v-if="required" class="text-destructive">*</span>
    </label>
    <span v-else-if="label" class="text-sm font-medium text-foreground">
      {{ label }} <span v-if="required" class="text-destructive">*</span>
    </span>
    <slot />
    <p v-if="hint && !error" class="text-xs text-muted-foreground">{{ hint }}</p>
    <InlineError v-if="error" :message="error" />
  </div>
</template>
