<script setup lang="ts">
import { ref, watch, onUnmounted } from "vue";
import {
  NumberFieldRoot,
  NumberFieldInput,
  NumberFieldIncrement,
  NumberFieldDecrement,
} from "reka-ui";
import { ChevronUp, ChevronDown } from "@lucide/vue";
import { cn } from "../../lib/cn";
import { useSplitAttrs } from "../../lib/attrs";

// NumberFieldRoot renders a non-focusable role="group" wrapper; route
// fallthrough attrs (aria-labelledby, data-testid) to the actual spinbutton
// (NumberFieldInput) instead, same reasoning as Select's trigger routing.
// `class` is the exception (same fix as Slider/Select): a caller's sizing or
// layout class must land on the rendered root — the element that actually
// participates in the parent's layout — merged through `cn()` (Tailwind-aware,
// last-wins) so e.g. a caller's `w-24` beats the root's own `w-full`.
defineOptions({ inheritAttrs: false });
const { attrs, rest: inputAttrs } = useSplitAttrs();

/**
 * NumberField — a constrained, scrub-draggable number input; the backbone of
 * Inspector (x/y/width/height/rotation/fontSize/startFrame/…). Built on Reka
 * UI's NumberField (spinbutton a11y, typed-value parsing/clamping) with a
 * horizontal scrub-drag gesture layered on top — Reka has no drag primitive,
 * and Reka's own arrow-key handling has no Shift multiplier, so both are
 * implemented here.
 *
 * Event contract (I2): `@update:modelValue` is transient — every drag tick,
 * arrow-key tick, or Enter/blur-applied edit. `@commit` fires once per
 * gesture boundary — drag release, blur, or Enter — so one long drag or one
 * edit session is one undo checkpoint (I9), not one per pixel/keystroke.
 */
const props = withDefaults(
  defineProps<{
    modelValue?: number;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    disabled?: boolean;
    /** Error state: paints the destructive border/ring and sets aria-invalid. */
    invalid?: boolean;
  }>(),
  {
    modelValue: undefined,
    min: undefined,
    max: undefined,
    step: 1,
    unit: undefined,
    disabled: false,
    invalid: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: number];
  commit: [value: number];
}>();

function clampValue(value: number): number {
  const step = props.step || 1;
  const stepped = Math.round(value / step) * step;
  const withMin = props.min !== undefined ? Math.max(props.min, stepped) : stepped;
  return props.max !== undefined ? Math.min(props.max, withMin) : withMin;
}

// The single source of truth for "the last value we know about", updated
// synchronously the moment it changes (either Reka's own emit, or our own
// scrub/Shift-tick math) — NOT re-derived from `props.modelValue` at commit
// time, because that prop only reflects a new value after the host's v-model
// round-trip re-renders us, which is async relative to the same-tick
// blur/keydown handling below.
//
// It is also what NumberFieldRoot's `model-value` binds to (not
// `props.modelValue`): with a defined prop, Reka's useVModel is fully
// controlled — handleIncrease reads the prop, so a host that (correctly, per
// I2) withholds transient echoes until commit would freeze every arrow tick
// at start+1 and the display at the gesture's start value. Binding lastValue
// keeps ticks accumulating and the readout live within a gesture, while the
// host still only sees transient emits until the boundary commit.
const lastValue = ref(props.modelValue);

// The value the host last acknowledged as committed. `@commit` only fires
// when `lastValue` differs from it — the same hasChanged rule Reka's Slider
// uses — so overlapping gesture boundaries (Enter then blur, drag-release
// then blur) and no-edit focus passes (Tab in, Tab out) produce zero extra
// commits, keeping one edit session = one undo checkpoint (I2/I9).
const lastCommittedValue = ref(props.modelValue);

// True while an uncommitted edit is in flight. External prop changes only
// re-baseline `lastCommittedValue` when nothing is pending — otherwise the
// host echoing our own transient v-model emits back down would make the
// pending edit look already-committed and swallow its `@commit`.
let editPending = false;

watch(
  () => props.modelValue,
  (value) => {
    lastValue.value = value;
    if (!editPending) lastCommittedValue.value = value;
  },
);

function onUpdate(value: number) {
  editPending = true;
  lastValue.value = value;
  emit("update:modelValue", value);
}

function commitLastValue() {
  // The gesture boundary ends the edit session even when the value ended up
  // back where it started (e.g. a drag that returned to its origin).
  editPending = false;
  if (lastValue.value === lastCommittedValue.value) return;
  lastCommittedValue.value = lastValue.value;
  emit("commit", lastValue.value ?? props.min ?? 0);
}

// Shift = ×10 (spec I2 A11y). Reka's own ArrowUp/Down handling (bound inside
// NumberFieldInput) ignores shiftKey, so this intercepts in the capture
// phase — strictly before the event reaches the input — and fully replaces
// the default ×1 tick for this one case, rather than letting both run and
// double-step.
function onKeydownCapture(event: KeyboardEvent) {
  if (props.disabled) return;
  if (!event.shiftKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
  event.preventDefault();
  event.stopPropagation();
  const tick = (props.step || 1) * 10;
  const current = lastValue.value ?? props.min ?? 0;
  onUpdate(clampValue(event.key === "ArrowUp" ? current + tick : current - tick));
}

// Bubble-phase (not capture): by the time this fires, the input's own Enter
// handling (which applies the typed value) has already run — DOM bubbling
// visits the target before its ancestors.
function onKeydownCommit(event: KeyboardEvent) {
  if (event.key !== "Enter") return;
  commitLastValue();
}

// A held arrow key is ONE gesture, exactly like a pointer drag (I2): every
// keydown — including OS auto-repeats — only ticks the transient value; the
// keyup ends the gesture and commits the summed delta once. A single tap is
// keydown+keyup, so it still commits once per tap.
function onKeyupCommit(event: KeyboardEvent) {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  commitLastValue();
}

// `focusout` (unlike `blur`) bubbles, so this reliably fires after the
// input's own blur handling — but only commit once focus actually leaves the
// field, not when it shifts internally to the hover-revealed stepper.
function onFocusOut(event: FocusEvent) {
  const root = event.currentTarget as HTMLElement;
  if (event.relatedTarget instanceof Node && root.contains(event.relatedTarget)) return;
  commitLastValue();
}

// Horizontal scrub-drag: a plain click still focuses the field for typing —
// we don't take over until the pointer has moved past a small threshold, so
// click-to-place-caret keeps working. One drag gesture = one `@commit`.
const DRAG_THRESHOLD_PX = 3;
const PIXELS_PER_STEP = 4;

// Set while a drag's window listeners are attached, so an unmount mid-drag
// still detaches them instead of leaking handlers on `window`.
let removeDragListeners: (() => void) | undefined;
onUnmounted(() => removeDragListeners?.());

function onPointerDown(event: PointerEvent) {
  if (props.disabled || event.button !== 0) return;
  const startX = event.clientX;
  const startValue = lastValue.value ?? props.min ?? 0;
  const step = props.step || 1;
  let dragging = false;

  function onPointerMove(moveEvent: PointerEvent) {
    const deltaX = moveEvent.clientX - startX;
    if (!dragging) {
      if (Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      window.getSelection()?.removeAllRanges();
    }
    moveEvent.preventDefault();
    const deltaSteps = Math.round(deltaX / PIXELS_PER_STEP);
    const next = clampValue(startValue + deltaSteps * step);
    if (next !== lastValue.value) onUpdate(next);
  }

  function onPointerUp() {
    removeDragListeners?.();
    if (dragging) commitLastValue();
  }

  // Bail-out path (Escape mid-scrub, pointercancel): discard the gesture —
  // nothing commits, and one last transient update carrying the start value
  // lets the host restore the pre-drag visual (still never journaled — I2).
  function abortDrag() {
    removeDragListeners?.();
    if (!dragging) return;
    if (lastValue.value !== startValue) onUpdate(startValue);
    editPending = false;
  }

  function onDragKeydown(keyEvent: KeyboardEvent) {
    if (keyEvent.key !== "Escape" || !dragging) return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    abortDrag();
  }

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", abortDrag);
  window.addEventListener("keydown", onDragKeydown, true);
  removeDragListeners = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", abortDrag);
    window.removeEventListener("keydown", onDragKeydown, true);
    removeDragListeners = undefined;
  };
}
</script>

<template>
  <NumberFieldRoot
    :model-value="lastValue"
    :min="min"
    :max="max"
    :step="step"
    :disabled="disabled"
    :aria-disabled="disabled || undefined"
    :data-invalid="invalid || undefined"
    :class="
      cn(
        'group relative inline-flex h-9 w-full items-center rounded-md border border-input bg-background',
        'transition-[color,background-color,box-shadow] duration-fast ease-out',
        // Rim-lit at rest, the weave blooms on focus (Signature law).
        'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring',
        !invalid && 'focus-within:shadow-halo',
        invalid && 'border-destructive focus-within:outline-destructive',
        'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        attrs.class as string,
      )
    "
    @update:model-value="onUpdate"
    @keydown.capture="onKeydownCapture"
    @keydown="onKeydownCommit"
    @keyup="onKeyupCommit"
    @focusout="onFocusOut"
    @pointerdown="onPointerDown"
  >
    <NumberFieldInput
      v-bind="inputAttrs"
      :aria-invalid="invalid || undefined"
      :class="
        cn(
          'tabular h-full w-full flex-1 rounded-md bg-transparent px-3 text-sm text-foreground outline-none',
          unit ? 'pr-9' : 'pr-3',
          disabled ? 'cursor-not-allowed' : 'cursor-ew-resize',
        )
      "
    />
    <span
      v-if="unit"
      aria-hidden="true"
      class="pointer-events-none absolute right-2 text-xs text-muted-foreground transition-opacity duration-fast group-hover:opacity-0"
    >
      {{ unit }}
    </span>
    <div
      class="absolute right-1 flex flex-col opacity-0 transition-opacity duration-fast group-hover:opacity-100"
    >
      <NumberFieldIncrement
        class="flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-subtle hover:text-foreground active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
        style="
          transition:
            transform var(--dur-fast) var(--ease-spring),
            background-color var(--dur-fast) var(--ease-out),
            color var(--dur-fast) var(--ease-out);
        "
      >
        <!-- 12px glyph → stroke 2.5 per the Iconography ≤12px rule; the
             inherited 1.5 halves to 0.75 device px on these tiny chevrons. -->
        <ChevronUp class="h-3 w-3" :stroke-width="2.5" />
      </NumberFieldIncrement>
      <NumberFieldDecrement
        class="flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-subtle hover:text-foreground active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
        style="
          transition:
            transform var(--dur-fast) var(--ease-spring),
            background-color var(--dur-fast) var(--ease-out),
            color var(--dur-fast) var(--ease-out);
        "
      >
        <ChevronDown class="h-3 w-3" :stroke-width="2.5" />
      </NumberFieldDecrement>
    </div>
  </NumberFieldRoot>
</template>
