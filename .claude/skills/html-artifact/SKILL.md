---
name: html-artifact
description: Build standalone HTML artifacts — UI mockups, documents, dashboards, diagrams, slides, interactive demos — with genre-specific guidance, ready-made templates, and a validation script. Use whenever creating or editing an HTML page for the Artifact tool or a self-contained HTML file for review; UI mockups must always go through this skill (they ship with a screen-size preview toolbar).
---

# HTML Artifacts

Complements the built-in `artifact-design` skill. That skill governs _treatment_ (palette, typography, copy, theme design); this one governs _mechanics_: genre structure, responsiveness, preview harnesses, templates, and validation. Load `artifact-design` as usual before designing — apply both.

## Non-negotiables

1. **Responsive is part of done.** Every artifact gets reviewed on a phone (360–430 px wide) as often as on a desktop. Follow `references/responsive.md`. "Looks fine on desktop" is not done.
2. **UI mockups ship inside the viewport-preview harness** (`templates/ui-mockup.html`). Never publish a bare mockup. Configure the `SIZES` presets to the size range the target app actually supports — for a desktop app that means its minimum supported size through its maximum, not generic phone/tablet sizes. The reviewer must be able to switch between every supported size.
3. **Artifact file format.** Files published with the Artifact tool contain page content only — no `<!doctype>`, `<html>`, `<head>`, `<body>` (the tool adds the skeleton). Keep a `<title>` tag. A file delivered standalone instead (SendUserFile, saved to disk) gets the full skeleton — generate it with `node .claude/skills/html-artifact/scripts/wrap-standalone.mjs <artifact.html> <out.html>` (never hand-write the skeleton) and validate with `--standalone`. Caveat: mermaid blocks render only in the Artifact viewer — a standalone file needs inline SVG instead.
4. **Self-contained.** The Artifact CSP blocks every external request: no CDN scripts, remote stylesheets/fonts/images, no fetch to other hosts. Inline everything; images as `data:` URIs; diagrams via native mermaid support. Inline JS is allowed and encouraged (pan/zoom, interactivity) — `check.mjs` parses every inline `<script>`, because one syntax error silently kills all interactivity on the page. No iframes to external pages (CSP blocks them); when content outgrows one page, split it into overview + detail sections or separate artifacts — `srcdoc` iframes (the mockup harness) are fine.
5. **Both themes, via tokens.** Palette as custom properties on `:root`; redefine tokens under `@media (prefers-color-scheme: dark)` AND under `:root[data-theme="dark"]` / `:root[data-theme="light"]` so the viewer's theme toggle wins in both directions. Every template carries this plumbing — keep it, restyle only the token values.

## Genres

Pick the closest genre, read its reference, start from its template:

| Genre       | Use for                                                     | Reference                          | Template                     |
| ----------- | ----------------------------------------------------------- | ---------------------------------- | ---------------------------- |
| ui-mockup   | UI/UX proposals, wireframes, redesigns of any app screen    | `references/genres/ui-mockup.md`   | `templates/ui-mockup.html`   |
| document    | reports, plans, memos, specs, analyses — read top-to-bottom | `references/genres/document.md`    | `templates/document.html`    |
| dashboard   | KPI/status/data views — scanned, not read                   | `references/genres/dashboard.md`   | `templates/dashboard.html`   |
| diagram     | architecture, flows, sequences, ERDs                        | `references/genres/diagram.md`     | `templates/diagram.html`     |
| slides      | presentation decks, pitches, walkthroughs                   | `references/genres/slides.md`      | `templates/slides.html`      |
| interactive | calculators, simulators, playgrounds, small tools           | `references/genres/interactive.md` | `templates/interactive.html` |

A page that mixes genres — a mockup with narration, a report with dashboard blocks, a doc with several diagrams — follows `references/hybrid.md`: a host genre (usually document) structures the page and the other genres embed as instance-scoped blocks (the mockup viewer and pan/zoom stage are built for this — multiple instances per page, no global IDs). Charts inside any genre: load the `dataviz` skill first — all chart craft lives there, never duplicated here. Live/shared/self-updating behavior: load `artifact-capabilities` first.

## Workflow

1. Identify the genre; read its reference file.
2. Copy its template to the working file (scratchpad for Artifact publishes). Templates are mechanics, not designs: replace every `TODO_REPLACE` with real content and restyle the token values per `artifact-design`. A fresh template intentionally fails validation until every marker is gone.
3. Build with real content throughout — never lorem.
4. Validate: `node .claude/skills/html-artifact/scripts/check.mjs <file>` (add `--standalone` for full-skeleton files). Fix every ERROR. Resolve each WARN or state explicitly why it is accepted. A PreToolUse hook also runs this check on every `.html` file published with the Artifact tool (artifact format) or sent with SendUserFile (`--standalone` format) and blocks on ERROR — validating first avoids a blocked publish, and manual validation is the only place WARNs are surfaced.
5. Verify responsiveness per the checklist at the end of `references/responsive.md`; for mockups, confirm every `SIZES` preset renders without broken layout.
6. Publish (Artifact tool) or send (SendUserFile).
