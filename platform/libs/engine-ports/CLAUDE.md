# engine-ports (`platform/libs/engine-ports`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`, the
area's in `platform/CLAUDE.md`. Nx project name `engine-ports`; Go module
`ecoma.io/platform/engine-ports` (tags `type:lib`, `scope:platform`,
`license:sul`, `layer:port`).

- **Role**: the interfaces the engine's domain exposes to the outside, written
  in the domain's own vocabulary so the thing behind each one stays swappable.
- **A port names a need, never a technology.** `layer:port` may reach domain
  and util; the moment an interface here mentions a driver, a dialect or a URL
  shape, the adapter has leaked upward and the swappability the layer exists
  for is gone.
- **A port's contract tests do not live here.** A suite never lives inside the
  project it arbitrates (ADR-0008 §3 rule 6): the ◆G0 port contracts are
  `conformance-g0`'s, and the port contracts that arbitrate the milestone exit
  litmus rather than a gate are `engine-adapters`' integration tests. What
  belongs here is a test of logic this project itself owns — today, none.
- **The vector port is deferred, not forgotten.** `engine-ports/vector`, its
  adapter and its case in the storage-port contract tests arrive with
  Knowledge, its first consumer (ADR-0008 §7). Adding it earlier would be a
  contract designed for no consumer.
- **Nothing machine-checks the layer direction here** — this project is Go, and
  no tool in the workspace parses a Go import (`platform/CLAUDE.md`).
