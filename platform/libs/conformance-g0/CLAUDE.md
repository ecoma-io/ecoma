# conformance-g0 (`platform/libs/conformance-g0`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`, the
area's in `platform/CLAUDE.md`. Nx project name `conformance-g0`; Go module
`ecoma.io/platform/conformance-g0` (tags `type:lib`, `scope:platform`,
`license:sul`, `gate:G0`).

- **Role**: the suite that arbitrates ◆G0. Roadmap rule #7 — a gate is a frozen
  text plus a suite that runs independently; a gate with no suite is a paper
  gate.
- **The scope is fixed and closed, not a backlog.** ADR-0008 §4.2 writes it in
  full: the Event Log entry schema, the log-store port contract against both
  stacks, the blob-CAS contract against both blob backends, the Lease contract,
  and Principal identity — nothing else, ever, under this gate. Growth declared
  at the freeze is the promise being kept; growth after it is breaking and
  travels a major.
- **Two targets run the same files, for different callers.** `test` is the
  workspace definition of done, so the suite cannot rot unnoticed. `conformance`
  is what `dev-cli conformance --run` executes, and it runs verbose on purpose:
  the ledger's claim is that these cases arbitrate the gate, so the run has to
  name them.
- **No `layer:` tag, and that is the modelling.** A port contract must reach
  adapters to run against both stacks; any layer tag would forbid exactly what
  this project exists to do (ADR-0008 §2). It is also **self-hosting** — it
  drives ports and adapters directly and depends on no application service,
  because it must run before one exists.
- **The `gate:` tag axis is split between machine and review** (ADR-0008 §6):
  a suite carrying more than one `gate:` tag is faulted by the
  `dev-cli conformance` executor, but a _misspelled_ tag passes silently —
  `require-project-tags` never inspects the axis, so the vocabulary itself is
  held by review alone.
- **The suite asserts nothing yet, and says so.** Each contract area has a file
  naming it and enumerating its cases as TODOs; there are no test functions,
  because an empty test function that passes reports a contract as checked when
  nothing checked it. `go test` is green over zero tests, which is the honest
  reading of this state. The ◆G0 `status: frozen` flip is therefore a separate
  act, after the assertions land and this suite is green against them —
  freezing first is the paper gate rule #7 names, and the executor fails it.
