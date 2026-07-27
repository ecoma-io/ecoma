# Genre: dashboard

Scanned, not read: the summary must be visible before any detail.

- Order: KPI/stat row first, then the charts/cards that explain them, then detail tables.
- KPI row: `repeat(auto-fit, minmax(150px, 1fr))` — collapses 4→2→1 across widths with no media queries.
- State is encoded in form, not just number: pills/chips/severity stripes for good/warning/critical. Semantic colors are separate tokens from the accent and don't count as the accent.
- **Charts: load the `dataviz` skill before writing any chart code.** All chart craft (form choice, palette, marks, axes, tooltips) lives there — this genre file only owns the page around the charts.
- Charts must resize with their card (SVG `viewBox`, or canvas redraw on resize). A fixed 900 px chart inside a phone-width card is the classic failure.
- Detail tables in `overflow-x: auto`; on phones consider surfacing fewer columns.
- Auto-refresh / live data is a runtime capability: load `artifact-capabilities` first.

## Template

`templates/dashboard.html` — KPI row, semantic status tokens, card grid, table wrapper; chart slots are placeholders to fill per `dataviz`.
