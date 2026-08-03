---
title: "ADR-0008 — Subsystem structure"
status: design-end-state
gate: G0
frozen-scope: "§4 the suite scopes; §3's boundary rules and §2's project inventory are the instantiation, not the freeze"
---

# ADR-0008 — Subsystem structure

> **Freeze state.** This document carries the ◆G0 freeze together with the
> documents that hold the interfaces themselves — the Event Log entry schema,
> the Artifact Store's CAS interface, Working Data's Lease and Tenant &
> Identity's Principal. It does not widen what ◆G0 freezes (roadmap §1b keeps
> that definition unchanged); it answers the half of rule #7 a text alone
> cannot: **which suite arbitrates the gate, and what that suite's complete
> scope is.** The `status: frozen` flip is a separate act, landing in the pull
> request that makes `conformance-g0` green — freezing before the suite exists
> is the paper gate rule #7 names, and the executor fails it.

## 1. Decision

The Platform area takes root as the top-level directory `platform/`, holding
`apps/` and `libs/`. Its engine is split by the hexagonal layer axis rather
than by feature, one conformance suite exists per gate that has started, and
the cross-domain runtime contract lives outside every domain in
`shared/packages/`.

**On the area vocabulary.** Top-level directories are areas (North Star §8),
and the set is open rather than the triad Platform · RPA · Hub: `website/` is
already a fourth area in the tree. The three tiers an area may hold —
`apps/`, `libs/`, `packages/` — are a vocabulary, not a mandate to create all
three: `website/` has only `apps/`, and `platform/` is born with `apps/` and
`libs/`. It gains `packages/` when it has a unit a third party receives, and
not before.

## 2. The projects — the instantiation, not the freeze

Only new projects are listed. Already delivered and untouched by this
decision: the `/design` Storybook and `core-ui` (roadmap E.3), the doctrine
tree and its site, the `website/` area, and the workspace tooling.

| Project             | Path                               | Language              | Tags                                                            | Born at    |
| ------------------- | ---------------------------------- | --------------------- | --------------------------------------------------------------- | ---------- |
| `engine-domain`     | `platform/libs/engine-domain`      | Go                    | `type:lib` `scope:platform` `license:sul` `layer:domain`        | Tier 0     |
| `engine-ports`      | `platform/libs/engine-ports`       | Go                    | `type:lib` `scope:platform` `license:sul` `layer:port`          | Tier 0     |
| `engine-adapters`   | `platform/libs/engine-adapters`    | Go                    | `type:lib` `scope:platform` `license:sul` `layer:adapter`       | Tier 0     |
| `conformance-g0`    | `platform/libs/conformance-g0`     | Go                    | `type:lib` `scope:platform` `license:sul` `gate:G0`             | Tier 0     |
| `runtime-protocol`  | `shared/packages/runtime-protocol` | schema + Go           | `type:lib` `scope:shared` `license:apache` `layer:port`         | ◆G1        |
| `conformance-g1`    | `platform/libs/conformance-g1`     | Go                    | `type:lib` `scope:platform` `license:sul` `gate:G1`             | ◆G1        |
| `engine`            | `platform/libs/engine`             | Go                    | `type:lib` `scope:platform` `license:sul` `layer:app`           | ◆G1        |
| `engine-server`     | `platform/apps/engine-server`      | Go                    | `type:app` `scope:platform` `license:sul` — **no `layer:` tag** | ◆G3        |
| `conformance-g3`    | `platform/libs/conformance-g3`     | Go                    | `type:lib` `scope:platform` `license:sul` `gate:G3`             | ◆G3        |
| `conformance-g4`    | `platform/libs/conformance-g4`     | Go                    | `type:lib` `scope:platform` `license:sul` `gate:G4`             | ◆G4        |
| `read-api-contract` | `platform/libs/read-api-contract`  | TypeScript, generated | `type:lib` `scope:platform` `license:sul` `layer:domain`        | ◆G4 step 1 |
| `human-surface`     | `platform/libs/human-surface`      | Vue/TS                | `type:lib` `scope:platform` `license:sul` `layer:view`          | ◆G4        |
| `work-surface`      | `platform/apps/work-surface`       | Vue/TS                | `type:app` `scope:platform` `license:sul` — **no `layer:` tag** | ◆G4        |
| `work-surface-e2e`  | `platform/apps/work-surface-e2e`   | TS/Playwright         | `type:e2e` `scope:platform` `license:sul`                       | ◆G4        |

`conformance-g2` is deliberately absent: Track D has not started, and the
executor treats a gate nobody has started as a state rather than a fault.

**Three projects carry no `layer:` tag, for one reason each and none of them
tidiness.** `engine-server` is the composition root — it wires adapters into
ports, which `layer:app` forbids outright, so the tag would kill the one
project whose job is that wiring. `work-surface` is the same shape on the
Vue side. A `conformance-*` suite must reach adapters to run a port contract
against both stacks, so any layer tag would forbid what it exists to do.

## 3. The boundary rules

1. **An area is a top-level directory.** Its scope tag is created in the change
   that lands its first project, never in anticipation of one.
2. **A library carries at most one layer**, and the direction is
   util → domain → port → adapter → view → app. `layer:app` never imports an
   adapter; the composition root, which does, carries no layer tag.
3. **A domain never imports another domain.** A contract two domains share
   lives outside both, under `shared/packages/`, licensed Apache 2.0 — which is
   also the only home both `scope:platform` and a future `scope:rpa` may
   depend on.
4. **The licence direction is one-way**: SUL may consume Apache, Apache may
   consume only Apache. A schema whose bindings are Apache must itself be
   Apache, so the node protocol's schema lives with its bindings rather than in
   the server.
5. **Domain vocabulary and wire contract are different things.** `engine-domain`
   owns the Filler concept; `runtime-protocol` owns the Filler wire contract;
   `engine` maps between them. `engine-domain` never imports the protocol —
   `layer:domain` may reach only domain and util, and that restriction is the
   rule, not an accident of tagging.
6. **A suite never lives inside the project it arbitrates.**
7. **Growth is additive and every deferral names its seam** (§7).

## 4. The gates, their freezes and their suites

### 4.1 What carries each freeze

◆G0's freeze text is roadmap §1b's, unchanged: the Event Log entry schema plus
the subsystem interfaces. It is carried by five documents, each declaring
`status: frozen`, `gate: G0` and the part of itself that is frozen:

| Document                  | `frozen-scope`                                  |
| ------------------------- | ----------------------------------------------- |
| `spec/event-log.md`       | the entry schema                                |
| `spec/artifact-store.md`  | the CAS interface `put / get / exists / delete` |
| `spec/working-data.md`    | §3 Lease                                        |
| `spec/tenant-identity.md` | §1 Principal                                    |
| this document             | §4                                              |

The language variants of a frozen document mirror the full freeze frontmatter
— `status`, `gate` and `frozen-scope` — because the executor scans every
Markdown file in the doctrine tree, variant or canonical: a variant left
behind would either disagree with its canonical on a fact or fault the
executor. The ledger therefore counts canonical and variant alike.

### 4.2 Suite scope, fixed at the freeze

A suite's scope is part of what freezes — a gate's suite is versioned with the
gate, and changing it is breaking — so it is written here in full rather than
discovered later. Growth after the freeze is breaking; growth declared here is
not.

| Suite            | Scope, complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conformance-g0` | (1) Event Log entry schema — required fields, ordering keys, the entry taxonomy, the crypto-shred fields; (2) the log-store port contract against the reference (Postgres) and the small stack (SQLite); (3) the blob-CAS contract `put / get / exists / delete` against both blob backends — the filesystem store the small stack ships and the S3-compatible store the reference stack ships; (4) the Lease contract — acquire, renew, expiry, mandatory TTL, and that no lock exists outside it; (5) Principal identity — the principal schema and its tenant scoping. Nothing else, ever, under this gate |
| `conformance-g1` | the Filler interface and the Session effect, driven through the generated `runtime-protocol` bindings, with an internal filler and a stub external filler on the same path                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `conformance-g3` | **phase one, frozen when M0 has it running**: Trigger — every enabled type (webhook, schedule, manual, form) plus `response_mode: sync`, black-box over HTTP. **phase two, declared now and arriving when M2 opens**: Channel, Party and the external filler                                                                                                                                                                                                                                                                                                                                                  |
| `conformance-g4` | the projection read-API, black-box over HTTP, plus the generated TypeScript contract agreeing with the schema it was generated from                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**On the blob backends.** ADR-0002 names a blob store in both stacks but not
which backend each ships; the Artifact Store specification lists filesystem,
S3-compatible and cloud blob as the adapter family. This decision assigns
them: the small stack ships the filesystem store, the reference stack ships
the S3-compatible store, and both adapters exist from Tier 0 so the CAS
contract runs against real backends rather than one backend wearing two names.

### 4.3 Arbiters that are not gate arbiters

The M0 exit litmus names storage-port behaviour ◆G0 does not freeze: SQL-read,
metrics-projection and the key-store. They get a named home and deliberately
**not** a `conformance` target — the executor's rule is that a suite arbitrates
a named gate or nothing, and these arbitrate a milestone litmus (§1b law #2
measures exit at the convergence point, not at a gate). Per ADR-0002, each
port contract below runs against **both** the reference and the small stack.

| Arbiter                                                                                         | Home              | Target                           |
| ----------------------------------------------------------------------------------------------- | ----------------- | -------------------------------- |
| SQL-read port contract, both stacks                                                             | `engine-adapters` | `test` (`*_integration_test.go`) |
| metrics-projection port contract, both stacks                                                   | `engine-adapters` | `test`                           |
| key-store contract, including the refusal ADR-0002 requires when `destroy` is not unrecoverable | `engine-adapters` | `test`                           |
| `kill -9` mid-flight then replay; the metering and cost projection rebuilding from the log      | `engine-server`   | `test` (`*_integration_test.go`) |

The last row is where the proposal had to move: those tests need real adapters,
and `engine` is `layer:app`, which may not touch one. The composition root is
the only home that does not blur the boundary.

`conformance-g0` is **self-hosting** — it drives ports and adapters directly and
depends on no application service, because it must run at ◆G0, before `engine`
exists. The test harness reaches the gates in two halves: the executor half is
`dev-cli conformance` and already exists; the engine's `run_kind: test` mode
arrives with `engine` at ◆G1 and serves the later gates.

## 5. Schema homes and the licence direction

| Schema                                                                           | Home                                   | Licence    | Generated into                                 |
| -------------------------------------------------------------------------------- | -------------------------------------- | ---------- | ---------------------------------------------- |
| HTTP API — command API, projection read-API, BaaS sync, webhook and form ingress | `platform/apps/engine-server/openapi/` | SUL        | Go server types; the TypeScript contract below |
| Node protocol — the Filler interface and the Session effect                      | `shared/packages/runtime-protocol/`    | Apache 2.0 | Go bindings, in the same package               |

Two documents, one format (OpenAPI 3.1, REST/JSON). They are not merged because
the licence direction forbids it: the node protocol's bindings are what a third
party receives under Apache 2.0, and a schema kept in the SUL server would make
them a derivative of SUL text; putting the whole product API surface in the
Apache package would give away the server's contract instead.

**The generated TypeScript view of the read-API** is `read-api-contract`: a
`layer:domain` library holding generated types, produced by its own `codegen`
target from `platform/apps/engine-server/openapi/`, with the output committed.
Three consequences, each load-bearing: a `layer:view` library may import domain
and so `human-surface` can be typed by the contract without a hand-written type
on the client side; the committed output means no build-time dependency from a
Vue project onto a Go application; and the schema-to-client edge is declared as
an `implicitDependencies` entry on `engine-server` so `nx affected` regenerates
when the schema moves — a graph edge, not an import, which is why it does not
cross the `type:lib` boundary. The `codegen` target runs at **step 1 of ◆G4**,
before the first line of `human-surface` or `work-surface`.

## 6. What a machine holds, and what only review holds

A green run must not imply more than it checked.

| Rule                                                                                                                                                                                                            | Held by                                                | Rung                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| every project declares one `type:`, `scope:`, `license:` tag                                                                                                                                                    | `require-project-tags` and `check-project-conventions` | machine                                          |
| the `license:` tag agrees with the path; a carve-out carries its own LICENSE                                                                                                                                    | `license-scope` through `check-project-conventions`    | machine                                          |
| import direction across layer and licence, **TypeScript and Vue only**                                                                                                                                          | `@nx/enforce-module-boundaries`                        | machine                                          |
| import direction across layer and licence, **Go**                                                                                                                                                               | nothing parses Go                                      | **review only**                                  |
| the seam between primitives inside `engine-domain`                                                                                                                                                              | nothing                                                | **review only**                                  |
| a suite names a gate; a freeze names a gate; a frozen gate has a suite                                                                                                                                          | `dev-cli conformance`                                  | machine                                          |
| the `gate:` axis vocabulary — `require-project-tags` inspects only its five known prefixes, so a misspelled gate tag passes silently; only the conformance executor reads the axis, and with a first-match find | nothing                                                | **review only**                                  |
| **exactly one** `gate:G#` tag on a suite                                                                                                                                                                        | the executor reads the first tag it finds              | **review only**                                  |
| `frozen-scope` still describing the frozen text                                                                                                                                                                 | no code reads the field at all, not even to print it   | **review only**                                  |
| Go, Rust and Python cross-project edges for `nx affected`                                                                                                                                                       | `nx-polyglot-graph`                                    | machine for affectedness, nothing for boundaries |

Every library this decision creates at Tier 0 is Go. **The layer axis is
therefore review-enforced for the whole engine**, and a pull request touching
it says so rather than letting a green run imply otherwise.

## 7. Named seams

| Deferred                                                                                         | Seam, named now                                                                                                                                                                                                           | Arrives                                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| the vector port — M0 explicitly ships "no Knowledge, Memory or DataTable module" (roadmap §4 M0) | `engine-ports/vector` plus its adapter and its case in the storage-port contract tests                                                                                                                                    | M3, with Knowledge — its first consumer      |
| splitting `engine-domain`                                                                        | the Go package boundary: `eventlog`, `role`, `task`, `checkpoint`, `handoff`, `escalation`, `calibration`, `composition`, `tenant`, `lease`, `keytree`. A split promotes one package to a library keeping its import path | when a package earns an independent consumer |
| a second read-API client (the attended UI's diff-Judgment surface, ADR-0005)                     | `platform/libs/read-api-client`, `layer:adapter`, generated from the same schema                                                                                                                                          | when that second consumer exists             |
| publishing the read-API contract to third parties                                                | it moves to `platform/packages/`, licensed Apache 2.0, under the release train                                                                                                                                            | when an external consumer is promised        |
| `conformance-g2`                                                                                 | the project is created when Track D starts                                                                                                                                                                                | M4                                           |

## 8. The questions this decision settles

- **Q1** `runtime-protocol` is created at ◆G1, with `shared/packages/LICENSE`
  in the same change.
- **Q2** split: one HTTP API schema (SUL, in the server) and one node protocol
  schema (Apache, in the package), both OpenAPI 3.1.
- **Q3** the vector port is deferred to M3 behind the seam named in §7.
- **Q4** one suite per started gate, no merging; plus the non-gate arbiters of
  §4.3, which are ordinary tests by mechanism rather than by preference.
- **Q5** `human-surface` is a library of its own; the pair-design canvas is a
  second view library on the same axis, not a reason to merge this one.
- **Q6** the surface is the **Work Surface**. ADR-0004's "console at `/app`"
  and ADR-0005's "console components" are corrected in this pass.
- **Q7** REST/JSON.
- **Q8** `work-surface-e2e` is the only e2e project at M0; the four North Star
  litmus questions are Go integration tests in `engine-server`.

## 9. Non-goals

This decision does not choose an HTTP framework, a Go module layout below the
package level, a projection storage schema, or a CI topology. It does not name
the RPA or Hub areas — each is created by the change that lands its first
project. It does not widen ◆G0.
