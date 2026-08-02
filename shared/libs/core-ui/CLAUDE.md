# UI primitives mechanics (`shared/libs/core-ui`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`. Nx project name `core-ui`; import alias `@ecoma-io/ui` (see `tsconfig.base.json`).

Two narrow entries sit beside the main one, and neither is a style choice: `@ecoma-io/ui/styles/*` for raw CSS, and `@ecoma-io/ui/a11y` for the shared WCAG scope. The main entry re-exports every `.vue` component, so a consumer compiled by plain `tsc` rather than `vue-tsc` — `design-system-e2e` is the live case — cannot resolve it at all. Reach for a narrow entry when the consumer needs a value, not a component; do not "simplify" one back into `src/index.ts`.

## The UI stack is two tiers — this lib is tier one, consumers must not re-invent it

**Tier 1 (here, Alloy):** every _generic_ affordance — primitives, blocks, tokens, motion. **Tier 2 (a product's own UI lib):** product-specific composition of tier 1, nothing generic of its own. Two rules follow, one per direction:

- **Consume-first (tier 2 → tier 1).** Before hand-rolling ANY generic affordance in a product lib, read the inventory — `src/index.ts` is the complete export list. The failure mode this rule exists for is real and was lived once in a product UI lib: hand-rolled `<p role="alert">` error paragraphs while `InlineError` existed, literal "Đang tải…" text while `Skeleton` existed, silent mutations while `Toast` existed, one-click destructive deletes while `Dialog` existed. The mapping to reach for: field/section error → `InlineError` · list loading → `Skeleton` · transient confirmation → `Toast` (queue is host-owned by design — see its doc header) · blocking confirm or focused form → `Dialog` (portals to `document.body`; tests must query the document, not the wrapper) · boolean setting → `Switch` · hint on a risky control → `Tooltip` · in-progress → `Spinner`/`Progress`.
- **Graduate-upstream (tier 1 ← tier 2).** A generic affordance drafted inside a product lib is in the wrong package — build it here with the five co-located artifacts (below), then consume it. A block a second leaf needs likewise graduates here.

## Every primitive is five co-located artifacts

A primitive `<Name>` lives entirely under `shared/libs/core-ui/src/primitives/<Name>/` and is complete only with all five — **the convention holds for every existing primitive, and the `lint` target keeps it there**: `dev-cli check-primitive-artifacts` fails the build on any primitive directory missing one of the five, so artifact #2 can no longer go absent unnoticed the way it did for eleven primitives before [#64](https://github.com/ecoma-io/ecoma/issues/64). The gate checks existence only; whether a test pins anything worth pinning (Rule 8) stays on review.

1. `<Name>.vue` — the component.
2. `<Name>.test.ts` — test titles pin the behavior that matters (Rule 8), named for the end state, never the phase that added them (Rule 13).
3. `<Name>Demo.vue` — demo importing the real component (relative import — same project, not the `@ecoma-io/ui` alias, see `@nx/enforce-module-boundaries`). This coupling makes the build break on renamed/removed APIs — keep it.
4. `<Name>.stories.ts` — the CSF meta + a `Demo` story rendering `<Name>Demo`. Meta carries `tags: ["!dev"]` so the component collapses to a single sidebar leaf (its Docs page), and injects the demo SFC as the "Show code" source via `?raw` (`import <Name>DemoSource from "./<Name>Demo.vue?raw"` → `parameters.docs.source.code`) so the shown code is real usage, never the `<XDemo />` wrapper.
5. `<Name>.mdx` — the design page: `<Meta of={…} />`, `<Canvas of={…Demo} />`, `<ArgTypes of={…} />` (props table auto-generated from vue-docgen). Prose defaults/behavior tables are hand-written: **changing props/defaults/behavior obligates updating this page in the same pass** (docs lead, upstream-first: docs → mockup → codebase).

Blocks (`src/blocks/<Name>/`) follow the same shape minus the mandatory `.test.ts`.

## Test tiers — this project holds two of the three, and launches no browser

Root `CLAUDE.md` owns the taxonomy; what is specific here is which tier covers
what, because a primitive can plausibly be tested in all three:

- **Unit** — `<Name>.test.ts`, jsdom. The component's own logic: what it
  renders from props, what it emits, which ARIA attributes it computes. Every
  project-internal collaborator is mocked (`local/no-unmocked-internal-imports`
  enforces it); Reka UI and other third-party libs are NOT mocked. jsdom has no
  `ResizeObserver` and Reka's poppers measure with one even while closed — stub
  it (several tests already do), don't work around it by mocking Reka.
  Property tests for pure logic (`fast-check` via `@fast-check/vitest`,
  co-located like any unit test) are also what the OpenSSF Scorecard Fuzzing
  check detects for TypeScript — they are not redundant with hand-written
  cases and must not be pruned as such. `vitest.setup.ts` pins their seed
  when `CI` is set (deterministic on CI, exploring on dev runs — the
  write-test skill owns the rule); do not remove the pin or the
  `setupFiles` entry that loads it.
- **Integration** — `<Name>.integration.test.ts`, same jsdom runtime, same
  `test` target (the include glob covers both). Reach for it only where the
  **composition is the behaviour**: a block wiring a real primitive, where
  mocking that primitive would leave the test pinning nothing. `ToastStack` ×
  real `Toast` is the shape to copy. A block whose own logic is what matters
  stays a unit test — do not promote a test to this tier because mocking was
  tedious.
- **e2e** — not here. `design-system-e2e` (`type:e2e`,
  `shared/apps/design-system-e2e`) drives the **built** Storybook of the
  `design-system` app and owns the blocking axe/WCAG gate; see its `CLAUDE.md`.

One Vitest config (`vitest.config.ts`), one `test` target, `maxWorkers: 1` —
jsdom-per-file dominates the run, so concurrent workers oversubscribed the
machine and made timing-sensitive tests flaky (#89) rather than faster.

The `design-system` app's `.storybook/preview.ts` `parameters.a11y` is the
**live dev panel**, not a gate — it shares `WCAG_TAGS` (exported here as
`@ecoma-io/ui/a11y`, `src/lib/a11y-scope.ts`) with `design-system-e2e` so
the panel reports exactly what the gate will fail on. Never restate that list.

## The design-system pages are the spec tier — read them, keep them in sync

`docs/design/*` (`Motion`, `Color`, `Elevation`, `Typography`, `Iconography`, `Logo`, `Signature`, `Principles`, `Introduction`) and `docs/components/Overview.mdx` are the **shared** spec: the vocabulary every primitive draws on (tokens, keyframes, motion patterns, the icon set, the elevation/color scales), each backed by a live `_demo/` gallery. They are the upstream source of truth for that vocabulary — read the relevant page _before_ judging a primitive's motion/color/etc. for consistency, and before assuming a pattern is undocumented (reviewing primitive code against primitive code misses this tier entirely).

A primitive's own `.mdx` (artifact #5) documents _that_ primitive; it does **not** discharge the spec pages. Introducing or changing shared vocabulary — a new keyframe or `animate-*` utility, a reusable motion/overlay pattern, a token, a Presence idiom — obligates updating the owning design page **and its `_demo` gallery** in the same pass (upstream-first, one source of truth). A new keyframe that never reaches `Motion.mdx` + `MotionGallery.vue` is an incomplete change, not a done one.

## Tokens

- Source of truth: `shared/libs/core-ui/src/styles/tokens.css`, mapped to Tailwind via `shared/libs/core-ui/tailwind.preset.js`. Storybook and the desktop app share it — never hardcode colors, durations, or easings; use Alloy tokens (see the Design System docs in the `design-system` Storybook). The dual-force law (Human `--primary` thép · Agent `--agent` đồng · `--seam` gradient only at handoff points) is spec'd in Design System › Signature — a surface must not mix the forces' roles.
- Tailwind v4 landmine in this repo: bare arbitrary-property utilities like `[transition:a,b,c]` do not compile — use an inline `style` binding instead.
- Tailwind v4 needs the `design-system` app's `postcss.config.js` (`@tailwindcss/postcss`) for the Storybook Vite build to process `@import "tailwindcss"` — without it no utilities generate. The Storybook host, its Tailwind config, and that PostCSS shim all live in `shared/apps/design-system`; only `tailwind.preset.js` (the theme source) stays here.
