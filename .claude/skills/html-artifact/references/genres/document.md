# Genre: document

Reports, plans, memos, specs, analyses — read top-to-bottom, often on a phone first.

## Structure

- Header: title plus one meta line (audience / status / date). No hero.
- Single column, measure ≤ 68ch. Sections via h2/h3; heading levels never skip.
- Table of contents only past ~5 sections; a plain anchor list, nothing sticky.
- Prefer more h2 sections over deep nesting — readers navigate by scanning headings.
- Tables: real `<table>` inside an `overflow-x: auto` wrapper; numeric columns right-aligned with `font-variant-numeric: tabular-nums`.
- Callouts/asides as full-width blocks, never floated boxes (floats collapse badly at 360 px).

## Responsive specifics

- The measure cap does the desktop work; the phone work is side padding and table/code overflow containers.
- Code blocks: `pre { overflow-x: auto }` — never wrap-break code lines.

## Template

`templates/document.html` — token plumbing, measure, table wrapper, callout, and figure patterns.
