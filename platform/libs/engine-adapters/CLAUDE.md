# engine-adapters (`platform/libs/engine-adapters`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`, the
area's in `platform/CLAUDE.md`. Nx project name `engine-adapters`; Go module
`ecoma.io/platform/engine-adapters` (tags `type:lib`, `scope:platform`,
`license:sul`, `layer:adapter`).

- **Role**: the implementations behind `engine-ports`, one per backend, plus
  the port-contract tests that arbitrate the milestone exit litmus.
- **Every port is implemented for both deployment shapes, never for one.**
  Small stack: SQLite, and the filesystem blob store. Reference stack:
  Postgres, and the S3-compatible blob store (ADR-0002 defaults by shape;
  ADR-0008 §4 is what assigns the blob backends). One backend wearing two names
  passes a contract test and proves nothing about portability.
- **Three arbiters live here and deliberately carry no `conformance` target**:
  the SQL-read, metrics-projection and key-store port contracts, each against
  both stacks. They arbitrate the milestone exit litmus, not a gate — and
  `dev-cli conformance` faults a `conformance` target with no `gate:` tag,
  because a suite arbitrates a named gate or nothing (ADR-0008 §4.3). They are
  ordinary `test`-target integration tests, and that is the mechanism rather
  than a preference.
- **The key-store contract carries a refusal, not just a happy path**: ADR-0002
  requires the adapter to refuse when `destroy` cannot be made unrecoverable. A
  suite that only proves destruction works leaves the case that matters
  unchecked.
- Tier is the filename: `*_integration_test.go` for anything touching a real
  backend, plain `*_test.go` for logic this project owns. Go has no build tags
  here — the name is the whole mechanism (root `CLAUDE.md` test taxonomy).
- **Nothing machine-checks the layer or licence direction here** — this project
  is Go, and no tool in the workspace parses a Go import
  (`platform/CLAUDE.md`).
