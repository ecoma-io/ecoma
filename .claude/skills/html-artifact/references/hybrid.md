# Hybrid pages — several genres on one page

A hybrid page composes genres instead of picking one: a design proposal that narrates _around_ mockups, a report with dashboard blocks, an architecture doc with several pan/zoom diagrams. The model is **host + embeds**.

## Host

The host is the genre that structures the page — almost always **document** (prose sections, headings, reading order). Its template provides the page shell: title, tokens, typography, `.wrap` column. Slides can host too (one embed per slide); dashboard and ui-mockup rarely host — if the page is mostly one mockup with a caption, that's not a hybrid, use the ui-mockup template directly.

## Embeds

Each embeddable component is instance-scoped by design — initialized per container, no page-global IDs. Copy the component's CSS + markup block + script from its template **once**; add more instances by repeating only the markup block.

| Embed            | Copy from                  | Markup block                                                                           | Notes                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mockup viewer    | `templates/ui-mockup.html` | `<section class="vph" data-title="…">` + its `<template data-screen>` fragments inside | Toolbar and stage are rendered by the script. Per-instance size presets via `data-sizes='[{"label":"Fit","fit":true},{"label":"390","w":390,"h":844}]'` — instances without it share the `SIZES` default. Screen fragments keep their own tokens (the iframe is a separate document). |
| Pan/zoom diagram | `templates/diagram.html`   | `<div class="stage">` (with `.pz` + `.stage-controls`)                                 | Each `.stage` initializes independently.                                                                                                                                                                                                                                              |
| Mermaid diagram  | —                          | `<pre class="mermaid">` in a `.scroll-x` div                                           | Renders natively in the Artifact viewer; anywhere in the flow.                                                                                                                                                                                                                        |
| Charts           | dataviz skill              | per that skill                                                                         | Load the dataviz skill first, as always.                                                                                                                                                                                                                                              |

## Composition rules

- **One token system.** The host's `:root` tokens (with the full dark/light plumbing) style the whole page, embeds included. Merge in any extra tokens an embed needs (e.g. semantic status colors from the dashboard template). Never carry a second `:root` block — one source of truth. Exception by design: mockup `<template data-screen>` fragments duplicate tokens internally because the iframe is a separate document.
- **One sticky budget.** At most one bar may be sticky on the page. The mockup toolbar's default sticky is for full-page use — in a hybrid, override it: `.vph .vp-bar { position: static; }` (or keep it sticky _only_ if the host has no sticky chrome of its own and there is a single mockup).
- **Narrate, then show.** Each embed is introduced by prose that says what to look at ("note how the sidebar collapses at md") — the reviewer should never meet a widget without knowing why it's there. Alternate prose ↔ embed; don't stack embeds back-to-back.
- **Every mockup still gets the harness** (non-negotiable #2) — embedding in a document never excuses a static screenshot-style mockup.
- **No duplicate scripts.** One harness `<script>` serves all `.vph` sections; one stage script serves all `.stage` blocks. Repeating a component's script re-initializes existing instances (double toolbars).
- **Class names are the contract.** The components find their parts by class (`.vph`, `.vp-*`, `.stage`, `.pz*`). Don't rename them and don't reuse these class names for host styling.
- **Validation is page-level.** `check.mjs` runs on the composed page as usual; every mockup instance's presets must all render intentionally (ui-mockup "Done means" applies per instance).
