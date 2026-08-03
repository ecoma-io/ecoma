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
- **Exactly one `gate:` tag, held by review alone.** `require-project-tags`
  never inspects that axis, and the executor takes the first tag it finds — so a
  second or misspelled one is silent (ADR-0008 §6).
- **Two of the five areas are arbitrated; three assert nothing, and say so.**
  Areas (1) the entry schema and (5) Principal identity have real cases, at the
  unit tier — both are properties of a domain value, so a store would add
  nothing to the arbitration. Areas (2) log-store, (3) blob-CAS and (4) Lease
  are port contracts: each needs a real adapter on **both** stacks, so their
  files still name their cases as TODOs and hold no test function. That is the
  honest state, not a gap to paper over — an empty test function that passes
  reports a contract as checked when nothing checked it.
- **A green run of this suite does not mean ◆G0 is met**, and nothing here may
  imply it does. The `status: frozen` flip is a separate act, landing only once
  all five areas are green — freezing first is the paper gate rule #7 names,
  and the executor fails it. When you add an area, update `doc.go`'s table and
  this entry **in the same commit**: the moment either says more than the files
  do, the project's own documentation is the fake-done.
- **One pin is deliberately weaker than the text it serves.** tenant-identity.md
  §1 promises the actor id survives a change of SSO provider; exercising that
  needs two auth adapters and a log to compare across, none of which exist at
  ◆G0. `principal_test.go` therefore pins the **structure** the promise rests on
  — no identity-provider field on `Principal`, the per-kind identity opaque —
  and its header says so in those words. Do not quietly upgrade the claim; the
  behavioural half is arbitrated by the first auth adapter.
