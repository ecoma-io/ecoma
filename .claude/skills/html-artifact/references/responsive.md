# Responsive contract

Every artifact must be usable from 360 px wide (small phone) up to the widest screen its subject supports — in this workspace that reaches ultrawide (3440 px) — without horizontal page scroll or unreadably small text. These rules are the mechanics; visual treatment stays with `artifact-design`.

## Breakpoint scale

Use the workspace scale, which mirrors Tailwind defaults plus the core-ui extensions (source of truth: `shared/libs/core-ui/tailwind.preset.js` — verify there if in doubt):

| Name | Min width | Reality                               |
| ---- | --------- | ------------------------------------- |
| sm   | 640 px    | large phone / small tablet            |
| md   | 768 px    | tablet                                |
| lg   | 1024 px   | small laptop                          |
| xl   | 1280 px   | laptop                                |
| 2xl  | 1536 px   | large laptop                          |
| 3xl  | 1920 px   | FHD desktop, maximized single monitor |
| 4xl  | 2560 px   | QHD / 1440p                           |
| 5xl  | 3440 px   | 21:9 ultrawide                        |

Not every artifact needs every step — use only the ones the content or the target app calls for, but _pick from these values_, never an arbitrary px (same principle as core-ui: snap width floors to a named breakpoint). Width-only; there is no breakpoint vocabulary for height.

## Layout

- Mobile-first: base styles target narrow screens; add `@media (min-width: …)` for larger, at values from the scale above.
- Page containers: `max-width` + `margin-inline: auto` + `padding-inline: clamp(16px, 4vw, 32px)`. Never a fixed pixel width on a page-level container.
- Sibling spacing via flex/grid `gap`, not per-element margins.
- Card/tile grids: `grid-template-columns: repeat(auto-fit, minmax(<min>, 1fr))` — columns collapse without media queries.
- Never `100vw` (it includes the scrollbar → horizontal overflow). Use `100%`.
- Anything intrinsically wide — tables, code blocks, wide diagrams — lives inside its own `overflow-x: auto` container. The page body never scrolls sideways.

## Type & touch

- Fluid sizes with `clamp()`, e.g. `font-size: clamp(1.6rem, 4vw, 2.4rem)` on headings. Body text never below 14 px; UI captions never below 12 px.
- Running text measure ≤ ~68ch (`max-width: 68ch`).
- Tap targets ≥ 44×44 px on anything interactive; adjacent targets get ≥ 8 px gap.
- Never disable zoom (`user-scalable=no`, `maximum-scale=1`).

## Media & embeds

- `img, svg, video, canvas { max-width: 100%; height: auto; }`
- SVG: set `viewBox`, let width be fluid — never fixed pixel dimensions only.

## Wide & ultrawide (3xl–5xl)

"No broken layout" is not enough at 1920+ — decide what the width is _for_:

- Documents/prose: the measure cap does the work; the page centers and breathes. Nothing to add.
- Dashboards: more columns via `auto-fit` grids is usually right; never stretch one chart to 3440 px.
- UI mockups: follow the target app's declared supported range — if the app supports 4xl/5xl, the mockup (and its `SIZES` presets) must show how the chrome uses that width; if it doesn't, cap at the app's maximum instead of pretending.

## Sticky/fixed chrome

- Sticky headers/toolbars stay short on phones (≤ ~56 px) — vertical space is scarce. Prefer `position: sticky` over `fixed` (no content-overlap math).
- Heights that must fill the screen use `100svh`, not `100vh` (mobile URL bar).

## Checklist before shipping

Walk these, don't assume (Rule 11):

- [ ] 360 px: no horizontal page scroll; text readable; controls tappable.
- [ ] 768 px: layout uses the width — not a stretched phone layout, not a squeezed desktop one.
- [ ] ≥1280 px: measure capped, whitespace intentional.
- [ ] Widest supported size (up to 3440 px when the subject supports it): width is used deliberately or capped deliberately — never a stretched accident.
- [ ] Tables/code/diagrams scroll inside their own container, not the page.
- [ ] Both themes checked at both width extremes.
