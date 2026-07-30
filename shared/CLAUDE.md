# Shared — Cross-Product Guidance

`shared/` holds code every product may consume: `shared/libs` (runtime
libraries), `shared/tools` (workspace tooling), and `shared/apps` (app shells
the workspace itself owns, serving shared infrastructure rather than any one
product — a Storybook host is an app because its built artifact has a deploy
lifecycle a buildless lib cannot carry). Rules specific to one project live in
its nested `CLAUDE.md` (e.g. `shared/libs/core-ui/CLAUDE.md`).

## Dependency boundary

A product domain may depend only on its own libraries and on `shared/*`;
`shared/*` never reaches into a product domain, and domains never import each
other. The view layer stays free of the desktop host runtime. These constraints are enforced by Nx
tags via `@nx/enforce-module-boundaries` in the root `eslint.config.mjs` — that
config is the source of truth; do not restate the constraints elsewhere.

**That enforcement reaches only what ESLint parses**, which is a limit rather
than a restatement, and it matters most on the `license:*` axis: the rule that
`license:sul` may never import `license:ee` is what keeps paid code out of every
self-hosted install, and for a Go, Rust or Python project **nothing checks it**.
`nx-polyglot-graph` gives `nx affected` those edges, but no lint reads them. Put
a carve-out module in one of those languages and the boundary is review-only —
say so in the pull request rather than letting the green run imply otherwise.

## Tooling (`shared/tools`)

- `eslint-local-rules` — local ESLint rules (e.g. `local/no-journey-markers`).
- `dev-cli` — local developer commands; the `COMMANDS` registry in
  `src/main.mjs` is the source of truth (doc/convention gates like
  `check-journey-markers`, `check-claude-md`, `check-doc-links`,
  `check-command-refs`, `check-practice-index`, `check-subsystem-readmes`,
  `check-subproject-readmes`, `check-primitive-artifacts`, `check-project-conventions`, `check-commit-scope`,
  plus workflow helpers like `pr-facts`, `scaffold-lib`, `run-e2e`,
  `doctrine-sync`); mechanics
  in its own `CLAUDE.md`. Four repo-root files are single sources shared across tools, so
  no one tool's guide owns them alone: `journey-markers.config.json` (the
  Rule 13 patterns, read by `check-journey-markers` and by the
  `local/no-journey-markers` / `local/no-journey-marker-names` ESLint rules),
  `practice-index.json` (practice cards naming the CLAUDE.md tier that
  owns each rule), `languages.config.json` (the ordered human-language
  triad with its endonyms, read by `dev-cli`'s `readme-schema` for the README
  variant filenames and nav line, and by `repo-care`'s `translate-thread` for
  its detection enum and translation targets), and `coverage.config.json` (the
  test-coverage floor, read by every project's `vitest.config.*` and by
  `dev-cli`'s `check-project-conventions`, which requires a project that has
  tests to take its thresholds from there rather than declare its own). Each sits at the root rather
  than inside one consumer because a cross-project source import would be an
  edge the Nx project graph cannot see. Never inline a copy of any of them.
- `repo-care` — repository-surface automation run from GitHub Actions (issue
  triage, advisory PR practice review, and issue/PR thread translation via
  keyless free LLMs); its review rubric derives from `practice-index.json`'s
  `diffCards`, its triage area vocabulary derives from subsystem-root README
  frontmatter (gated by `dev-cli check-subsystem-readmes`), and its translation
  languages derive from `languages.config.json`, so none is a second copy of
  the truth. Mechanics in its `CLAUDE.md`.
- `nx-polyglot-graph` — local Nx project-graph plugin (`nx.json → plugins`)
  that adds cross-project EDGES for Go/Rust/Python projects by reading their
  manifests statically; it never creates nodes or infers targets (those stay
  hand-written in each `project.json`). Mechanics in its `CLAUDE.md`.
