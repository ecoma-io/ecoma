---
name: dev-cli
subsystem: shared
lang: en
description: Local developer commands that turn this repo's practice into enforced, machine-checked gates instead of prose to remember.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# dev-cli

Local developer commands that turn this repo's `CLAUDE.md` rules from "hope
everyone remembers" into "forget it and the commit/push/CI step actually
stops you."

<!-- readme:why -->

## Why this exists

This repo carries dozens of rules that only hold if something keeps checking
them: Rule 13 (no journey markers), every subproject needs its own
`CLAUDE.md`, a commit's scope must match the paths it touches, every practice
card must still point at the exact prose it quotes. Written only as prose in
`CLAUDE.md`, rules like these decay — people forget, agents forget, and
nothing raises an alarm when one is violated. `dev-cli` is where each of
those rules becomes a small function that returns a process exit code, wired
into the right point of the commit/push/CI lifecycle, so the practice is
machine-enforced instead of merely documented. What used to be scattered
one-off scripts is now a single registry (`COMMANDS` in `src/main.mjs`)
invoked one uniform way: `node shared/tools/dev-cli/src/main.mjs <command>`.

<!-- readme:consumers -->

## Who consumes it

Not every command is wired into a gate — `lefthook.yml` and
`.github/workflows/ci.yml` are what actually say which command blocks what:

- **lefthook pre-commit**: `check-journey-markers-workspace`,
  `check-doc-links`, `check-doctrine`, `check-practice-index`,
  `ensure-commit-identity --check`.
- **lefthook prepare-commit-msg / commit-msg**: `strip-claude-trailers`,
  `check-commit-scope`.
- **CI** (`.github/workflows/ci.yml`): `check-commit-scope --commit <sha>`
  (once per commit in the PR), `check-journey-markers-workspace`,
  `check-doc-links`, `check-claude-md`, `check-doctrine`, `check-practice-index`,
  `check-project-conventions`, `check-subsystem-readmes`,
  `check-subproject-readmes`.
- **Every project's own `lint` target** (`project.json`, across almost every
  subproject in the repo, including `dev-cli` itself) runs
  `check-journey-markers` per-project. `check-primitive-artifacts` is wired
  only into `core-ui`'s `lint`, because the convention it enforces belongs to
  that one project. `check-e2e-story-coverage` is wired only into
  `design-system-e2e`'s `lint`: it holds every `core-ui` component to owning a story,
  which is what puts it in that suite's a11y sweep. `check-gofmt` is wired only
  into a scaffolded Go project's own `lint` target (`scaffold-lib`), since no
  Go project exists yet for it to run against elsewhere.
- **`commitlint.config.mjs`** imports `check-commit-scope.mjs`'s
  project/subsystem discovery directly to build `scope-enum` — one source of
  truth for the scope list; `list-scopes` prints that same derivation for
  manual lookup.
- **Wired into no gate at all** — invoked by hand or from an agent skill when
  the work is needed, not enforced continuously: `scaffold-lib` (the
  `scaffold-lib` skill), `pr-facts` (the `create-pr` skill), `run-e2e` (the
  `e2e` target of the `*-e2e` apps).

<!-- readme:ecosystem -->

## Where it sits

`dev-cli` gates **source code and repo conventions**, both locally
(lefthook) and in CI. It never touches the GitHub surface itself (issues, PR
comments) — that is
[`repo-care`](../repo-care/README.md)'s job, a sibling tool under the same
`shared/tools` tree, which consumes `check-practice-index`'s same source of
truth (`practice-index.json`) for its own PR-review rubric. `dev-cli` is also
the only place Rule 13 detection logic lives (`check-journey-markers`,
reading `journey-markers.config.json` at the repo root), reused by
[`eslint-local-rules`](../eslint-local-rules/README.md) for the two matching
ESLint rules — two enforcement layers of the same rule (file/name matching
vs. AST), never two independent copies.

<!-- readme:boundary -->

## What it deliberately does not do

Not a CLI framework — argument parsing stays deliberately minimal (see the
header comment in `main.mjs`); reach for a framework only once several
commands genuinely need one. No build step, no typecheck (plain-ESM `.mjs`,
by design). Not where natural-language judgment calls live — every command
here is a deterministic check (Rule 5). Work that needs judgment, like PR
review or issue classification, belongs to `repo-care`, not here.

<!-- readme:status -->

## Status

Actively running as a real gate for most of its commands, not a draft.
Per-command mechanics, invariants, and footguns live in
[`CLAUDE.md`](./CLAUDE.md) next to this file.
