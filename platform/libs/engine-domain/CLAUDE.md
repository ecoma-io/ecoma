# engine-domain (`platform/libs/engine-domain`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`, the
area's in `platform/CLAUDE.md`. Nx project name `engine-domain`; Go module
`ecoma.io/platform/engine-domain` (tags `type:lib`, `scope:platform`,
`license:sul`, `layer:domain`).

- **Role**: the engine's domain vocabulary — the primitives every other layer
  is written in terms of. Pure types and logic, no I/O, no wire format.
- **The Go package boundary is a load-bearing seam, not a filing convention.**
  ADR-0008 §7 names the split: when a package earns an independent consumer it
  is promoted to a library of its own, **keeping its import path**. That only
  stays possible while each package is separable — so a shared helper that
  reaches across two of them cuts the seam it is supposed to respect. Put it in
  the package that owns the concept, or in a `util` library, never in a third
  package that both import.
- **The root package holds no types by design.** `doc.go` is the module's own
  documentation and the index of the twelve package seams (ADR-0008 §7's
  corrected list, including `artifact`); adding a type there puts it in no seam
  at all.
- **Domain vocabulary and wire contract are different things** (ADR-0008 §3
  rule 5). This library owns the Filler concept; the node protocol owns the
  Filler wire contract; the application service maps between them. Nothing here
  ever imports a protocol package — and since `layer:domain` may reach only
  domain and util, that is the rule rather than an accident of tagging.
- **Nothing machine-checks either of the two rules above** — every project in
  this area is Go, and no tool in the workspace parses a Go import
  (`platform/CLAUDE.md`).
