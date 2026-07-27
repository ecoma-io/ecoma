# Genre: interactive

Calculators, simulators, playgrounds, configurators — small tools the user operates.

- Layout: controls and result visible together on desktop (side by side); stacked on phones with the result immediately after the controls — after tapping a control the user must see the effect without hunting.
- Inputs: correct `type`/`inputmode` (numeric keyboards on phones), labels always visible (a placeholder is not a label), tap targets ≥ 44 px.
- Feedback on `input` events (instant), not on submit; debounce only genuinely expensive work.
- Validation is inline, next to the field, and explains how to fix. Never silently clamp or coerce a value.
- All logic is deterministic JS in the page (Rule 5) — never fake or hard-code a "result".
- Keyboard operable end-to-end; visible `:focus-visible` states; `prefers-reduced-motion` respected.
- State lives in memory; anything shared, persistent, or live requires the `artifact-capabilities` skill first.

## Template

`templates/interactive.html` — control panel + live output wiring, inline validation pattern.
