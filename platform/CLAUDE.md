# Platform — Area Guidance

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`,
cross-product rules in `shared/CLAUDE.md`. The `platform/` area holds the
engine: its domain vocabulary, the ports that vocabulary exposes, the
adapters behind those ports, and one conformance suite per gate that has
started.

**The owning document is
[ADR-0008 — Subsystem structure](../shared/libs/doctrine/method/subsystem-structure.md).**
Its §2 table is the project inventory this tree instantiates (names, paths,
tags), §3 the boundary rules, §4 what each gate freezes and which suite
arbitrates it, §7 the named seams. Read it before adding a project here; the
rules below are the half that has to reach whoever edits a file, not a
second copy of the decision.

## The layer axis is real, and here nothing enforces it

Every library in this area is Go. `@nx/enforce-module-boundaries` reads the
`layer:` and `license:` tags in the root `eslint.config.mjs`, and it only
ever sees what ESLint parses — **no tool in this workspace parses a Go
import** (`shared/CLAUDE.md` says so on the licence axis; the layer axis has
the same hole for the same reason). `nx-polyglot-graph` gives `nx affected`
the Go edges, but affectedness is not a boundary.

So: the direction `util → domain → port → adapter → view → app` is held here
by review alone, and a pull request touching this tree says that out loud
rather than letting a green run imply otherwise. Concretely, a reviewer
checks the two edges a machine would have caught elsewhere:

- `engine-domain` imports domain and util only — never a port, never an
  adapter, and never a wire protocol. Domain vocabulary and wire contract are
  different things (ADR-0008 §3 rule 5).
- `engine-ports` may name domain types; `engine-adapters` may reach port and
  domain. Nothing flows back up.

## A composition root carries no layer tag, and that is not an oversight

`layer:app` forbids importing an adapter — which is precisely the job of a
composition root, so tagging one would kill the project whose whole purpose
is that wiring. The projects that legitimately carry no `layer:` tag, each
for its own reason:

- the composition root (`engine-server` when it arrives, and its Vue-side
  twin) — it wires adapters into ports;
- every `conformance-*` suite — a port contract must run against both stacks'
  adapters, so any layer tag would forbid what the suite exists to do.

Omitting the tag anywhere else is dodging the boundary, not modelling it.

## What the `gate:` tag does, and what nothing checks about it

A suite declares `gate:G<n>` plus a `conformance` target; the
`dev-cli conformance` executor reads exactly that pair and reports the
ledger. Three things
about that axis are **review-only**, and each fails silently:

- `require-project-tags` inspects `type:`/`scope:`/`license:`/`layer:`/
  `surface:` and nothing else, so a misspelled `gate:` tag passes lint;
- the executor takes the **first** gate tag it finds, so a second one is
  never reported;
- a suite never lives inside the project it arbitrates (ADR-0008 §3 rule 6) —
  a directory layout no gate reads.

A freeze is the other half of the pair and is a human act: flipping a
doctrine document to `status: frozen` before its suite is green is the paper
gate the roadmap's rule #7 names, and the executor fails it.

## Adding a project here

Scaffold it (`dev-cli scaffold-lib … --subsystem platform --lang go`), never
by hand — the generator owns `project.json`, the `CLAUDE.md`/README triad and
the `go.work` registration, and it derives the `license:` tag from the path.
Two consequences worth knowing before the first run: the generator writes
`go.work` alongside the project, and `check-commit-scope` refuses a commit
mixing that root-owned path with project-owned ones — so the registration is
its own `workspace`-scoped commit. And a Go project's `test` target runs
`go test ./...` over both co-located tiers; the integration tier is carried
by the `_integration_test.go` suffix, nothing else.
