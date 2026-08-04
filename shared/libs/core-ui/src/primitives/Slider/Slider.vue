<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { SliderRoot, SliderTrack, SliderRange, SliderThumb } from "reka-ui";
import { cn } from "../../lib/cn";
import { useSplitAttrs } from "../../lib/attrs";

// Unlike SelectRoot (renders no DOM node at all), SliderRoot renders a real
// element — the one a caller's `class` (sizing/margin, e.g. `flex-1` to grow
// in a toolbar) must land on, or it's dead weight on the thumb (a 16px,
// absolutely-positioned circle unaffected by flex sizing). Non-class attrs
// (aria-labelledby, data-testid) still route to the thumb — the actual
// role="slider" element — same reasoning as Select's trigger routing.
defineOptions({ inheritAttrs: false });
const { attrs, rest: thumbAttrs } = useSplitAttrs();

/**
 * Slider — a bounded continuous value (0.2 canonical case: media volume,
 * `VideoElementSchema.volume` 0–1). Built on Reka UI's Slider: role="slider",
 * pointer-drag + arrow-key/Home/End stepping, and its own I2 transient/
 * committed split — `update:modelValue` while dragging, `valueCommit` at
 * gesture end (drag release; each keyboard nudge commits too, since a
 * keypress has no separate "release").
 *
 * Reka's Slider has no drag-abort path of its own (SliderImpl handles only
 * pointerdown/move/up; `handleSlideEnd` commits whenever the release value
 * differs from its pointerdown snapshot) — so Escape or a browser
 * pointercancel mid-drag would still journal one transaction on release,
 * breaking the cancelled-gesture contract every other widget honors (I2).
 * The bail-out below mirrors `NumberField`'s scrub abort: reset `lastValue`
 * to the committed prop (Reka's release-time comparison then sees no change
 * and never fires `valueCommit`) and swallow the still-captured pointer's
 * remaining move ticks until it releases.
 *
 * That split only fires correctly, though, if `SliderRoot`'s own
 * `model-value` prop actually advances during the drag: internally it treats
 * a defined `model-value` as fully host-controlled (`useVModel(..., {passive:
 * props.modelValue === undefined})`), so its release-time `hasChanged` check
 * (`currentModelValue` vs. the value snapshotted at pointerdown) reads
 * through to whatever this component feeds it as `model-value` — never
 * `props.modelValue` directly. Per I2, the host only echoes the COMMITTED
 * value back down (`workspace.previewPatchElement` never touches the store's
 * committed model), so a naive `props.modelValue` passthrough stays frozen
 * at the pre-drag value for the whole gesture: `hasChanged` is always false
 * at release and `valueCommit` never fires — the change is silently dropped.
 * `lastValue` below buffers Reka's own transient ticks back into its
 * `model-value`, the same fix `NumberField` already applies to
 * `NumberFieldRoot` for the identical reason. Keyboard stepping needs no such
 * buffering: Reka's `updateValues({ commit: true })` compares the freshly
 * computed value against the (still old) backing value inside one
 * synchronous call, so it already commits correctly with or without a
 * buffered echo. Single-thumb only: Reka's model is `number[]`, we expose
 * a scalar `number`.
 */
const props = withDefaults(
  defineProps<{
    modelValue?: number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
  }>(),
  { modelValue: undefined, min: 0, max: 1, step: 0.01, disabled: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: number];
  commit: [value: number];
}>();

// The value fed to `SliderRoot`'s own `model-value` (see the block comment
// above) — seeded from the prop, then advanced on every Reka-emitted tick so
// Reka's release-time `hasChanged` check sees the drag's real end position,
// not the frozen pre-drag prop.
const lastValue = ref(props.modelValue);
watch(
  () => props.modelValue,
  (value) => {
    lastValue.value = value;
  },
);

const values = computed(() => (lastValue.value === undefined ? [] : [lastValue.value]));

function onUpdate(next: number[] | undefined) {
  const value = next?.[0];
  if (value === undefined || aborted) return;
  lastValue.value = value;
  emit("update:modelValue", value);
}

function onCommit(next: number[]) {
  if (next[0] !== undefined && !aborted) emit("commit", next[0]);
}

// Bail-out path (see the block comment above). Window listeners live only
// for the duration of one pointer gesture, same as NumberField's scrub.
let aborted = false;
let teardownDrag: (() => void) | undefined;

function resetToCommitted() {
  if (lastValue.value === props.modelValue) return;
  lastValue.value = props.modelValue;
  // One transient tick carrying the committed value lets the host restore
  // the pre-drag visual — still never journaled (I2).
  if (props.modelValue !== undefined) emit("update:modelValue", props.modelValue);
}

function onRootPointerDown() {
  if (props.disabled) return;
  aborted = false;
  const onDragKeydown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape" || aborted) return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    // The pointer stays captured by Reka until release — `aborted` keeps the
    // remaining move ticks from resurrecting the gesture.
    aborted = true;
    resetToCommitted();
  };
  const onPointerUp = () => {
    // Runs after Reka's own element-level release handling, so a swallowed
    // gesture is already settled by the time we re-arm.
    teardownDrag?.();
    aborted = false;
  };
  const onPointerCancel = () => {
    teardownDrag?.();
    aborted = false; // a cancelled pointer emits no further ticks
    resetToCommitted();
  };
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  window.addEventListener("keydown", onDragKeydown, true);
  teardownDrag = () => {
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onDragKeydown, true);
    teardownDrag = undefined;
  };
}

onBeforeUnmount(() => teardownDrag?.());
</script>

<template>
  <SliderRoot
    :model-value="values"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    :class="
      cn(
        'relative flex w-full touch-none items-center py-2 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        attrs.class as string,
      )
    "
    @pointerdown="onRootPointerDown"
    @update:model-value="onUpdate"
    @value-commit="onCommit"
  >
    <SliderTrack class="relative h-1.5 w-full grow rounded-full bg-muted">
      <!-- The filled range is the human-set value — flat warp fill (Loom law). -->
      <SliderRange class="absolute h-full rounded-full bg-primary" />
    </SliderTrack>
    <SliderThumb
      v-bind="thumbAttrs"
      class="block h-4 w-4 rounded-full border-2 border-primary bg-background shadow-sm transition-transform duration-fast ease-spring hover:scale-110 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:shadow-halo data-[disabled]:pointer-events-none"
    />
  </SliderRoot>
</template>
