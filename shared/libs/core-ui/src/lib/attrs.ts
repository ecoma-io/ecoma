import { computed, useAttrs, type ComputedRef } from "vue";

/**
 * Split `useAttrs()` into the raw fallthrough attrs (read `.class` directly
 * off `attrs` for a `cn()` merge) and the same attrs minus `class` (`rest`,
 * for `v-bind` onto whichever node isn't the `class` target). Every caller
 * pairs this with `defineOptions({ inheritAttrs: false })` — NumberField's
 * input, Slider's thumb, and Select's trigger each route `class` onto a
 * specific rendered node instead of Vue's default single-root fallthrough,
 * because `class` needs a Tailwind-aware merge (`cn()`) while the rest of the
 * fallthrough attrs (aria-*, data-testid) just need to land somewhere real.
 */
export function useSplitAttrs(): {
  attrs: Record<string, unknown>;
  rest: ComputedRef<Record<string, unknown>>;
} {
  const attrs = useAttrs();
  const rest = computed(() => {
    const { class: _class, ...others } = attrs;
    return others;
  });
  return { attrs, rest };
}
