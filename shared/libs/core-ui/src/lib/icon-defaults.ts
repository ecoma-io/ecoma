import { setLucideProps } from "@lucide/vue";

/**
 * Apply the Alloy icon defaults once at a host's root (Design System ›
 * Iconography): size 16, stroke 1.5 — hairline-first, matching the 1px
 * border language. Every `@lucide/vue` icon rendered after this call
 * inherits the defaults, so individual icons only declare `size`/
 * `strokeWidth` when they deliberately diverge — the one standing exception
 * being glyphs rendered at ≤12px, which declare `stroke-width` 2.5 exactly
 * (stroke lives on the 24 grid and scales with size, so 1.5 at 12px renders
 * 0.75 device px against 1.0 at 16px; 2.5 restores the optical weight).
 *
 * The numbers live HERE, not in each host — call this from the host's entry
 * (`main.ts`, Storybook `preview.ts`) before mounting the app.
 */
export function applyAlloyIconDefaults(): void {
  setLucideProps({ size: 16, strokeWidth: 1.5 });
}
