# `src/rules/` — the boundary rules

Empty. No rule is implemented yet, and `../../cli.mjs check` exits non-zero
saying so rather than reporting a tree it never inspected.

## What lands here

One module per rule, each a pure function from analysis records to violations.
A rule reads the frozen record shape in `../analysis/contract.md` and the
constraint table loaded by `../config.mjs`; it never reads a file, never
resolves a specifier, and never decides which files to visit. Those belong to
`../analysis/` and to the caller, and a rule that reaches for them turns into a
second, weaker analyzer.

The set to cover is not open-ended: `@nx/enforce-module-boundaries` reports
**15 violation types** under **8 options**, and this directory owes the same
verdict for the languages ESLint cannot read. Five of those types are decided
on the raw import specifier rather than on the project pair — which is why the
analysis record carries the specifier and its position, and why an Nx graph
edge alone cannot serve them (`../analysis/contract.md`, "superset of a graph
edge").

## What must not land here

- **A second copy of the constraint table.** The table has one home,
  `module-boundaries.config.mjs` at the workspace root, and `../config.mjs` is
  the only thing that reads it.
- **A workspace's specific project names, areas, or tag values.** This tool
  also runs inside the private control-plane workspace through a pinned harness
  clone, over a different tree with different names. Everything comes from the
  graph and the config.
- **Judgment about which files to analyze.** A rule is handed records.
