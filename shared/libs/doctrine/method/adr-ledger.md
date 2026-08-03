---
title: "ADR Ledger"
status: design-end-state
---

# ADR Ledger

> The home of **implementation** decisions — the third tier below the ceiling and
> the charters. Append-only, superseded with lineage. An ADR may not contradict
> the ceiling; where it does, the ceiling wins. Every settled ADR carries an
> explicit owner approval after an adversarial pass.

## ADR-0001 — Durable execution: written here, on the Event Log ✅ settled

**Decision**: no external workflow framework. Durable state is a replayed stream,
and timers, SLAs and lease TTLs are entries (Event Log §5). The ceiling already
describes the mechanism; this ADR confirms we are not buying it in.

**Rejecting Temporal and Cadence, on mechanism alone**: (1) each keeps its own
event history, which is **a second source of truth**; (2) "workflow-as-code is
the source of truth" conflicts with _a process definition is an Artifact with a
Gate_ (Composition §1); (3) a separate cluster to operate breaks "the simplest
possible self-host".

**Consequence**: the engine owns its own scheduler, claim and replay. That is
already inside M0, and the ◆G0 conformance suite is the net that checks it.

## ADR-0002 — Storage: five ports, Postgres as reference, defaults by shape ✅ settled

**Five ports**, all already present in the ceiling — this ADR only names them:
`log-store`, `SQL-read`, `vector`, `blob-CAS`, `metrics-projection`.

| Concept                                                                                                          | Settled                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reference backend**                                                                                            | **Postgres** — where the contract suite defines standard behaviour. _Reference is not the installation default_                                                                                                                                                                                                                                                                        |
| **The SQL-read contract**                                                                                        | **Suite-defined and executable**, never defined by a product name. A contract expressed as a suite is checkable for any backend; a contract expressed as a name is not                                                                                                                                                                                                                 |
| **Defaults by deployment shape** — no configuration switch, because the shape is the user's declaration of scale | A single binary or one `docker run` container → **small stack: SQLite for log and OLTP, DuckDB for SQL-read and OLAP, sqlite-vec**. A production `docker compose` or Helm → **Postgres with pgvector and TimescaleDB**. Cloud → Postgres                                                                                                                                               |
| Why the small stack is legitimate                                                                                | Every ceiling mechanism runs. SQLite is the WRITE path and DuckDB the QUERY path — **a physical split matching exactly what the ceiling splits logically** ("SQL to ask, events to write") — and the engine is the sole writing process, satisfying the database-is-the-engine's-property rule (Working Data §2)                                                                       |
| **Grow path**                                                                                                    | Upgrading small to Postgres is **replaying the log into the new port**, free with event sourcing. The engine measures thresholds — events per day, file size, p95 — and **warns, with migration as an explicit Task**. Never automatic                                                                                                                                                 |
| **Key-store backend**                                                                                            | A hard condition on any backend acting as key store — KMS, HashiCorp Vault, HSM, file: `destroy` must be unrecoverable **and** the backend must not provide, or must allow disabling, **point-in-time snapshot and rewind** over key material (Vault §6.2). A key-store snapshot revives exactly the key that was shredded, reopening the backup-versus-shred hole at a different door |
| Qdrant, for vector at scale                                                                                      | ✅ through the vector port, on condition that the index is a projection rebuildable from the log and the backend obeys **classification policy** — a `secret` collection never leaves the approved list                                                                                                                                                                                |
| ClickHouse                                                                                                       | ✅ through exactly two doors: an opt-in projection backend, and a **BYO-export** destination. ❌ never accepting direct writes, ❌ never a default                                                                                                                                                                                                                                     |
| BYO-export                                                                                                       | The format is **Parquet**, an open table format; **DuckDB is the suggested consumer** for local analysis                                                                                                                                                                                                                                                                               |
| Chroma                                                                                                           | ❌ — it solves nothing pgvector and sqlite-vec do not                                                                                                                                                                                                                                                                                                                                  |
| Kafka                                                                                                            | ❌ as a source of truth — its retention conflicts with "an entry is permanent", and the operational weight is high. In future it may only be a transport or projection feed, through an adapter                                                                                                                                                                                        |
| CI                                                                                                               | The small stack is **first class from M0**: the storage-port conformance suites run against both the reference and the small stack                                                                                                                                                                                                                                                     |
| Risk, stated rather than used to reject                                                                          | Maintaining two defaults could delay delivery. The kill trigger: if it delays **two consecutive milestones**, the small stack's scope is reconsidered                                                                                                                                                                                                                                  |

## ADR-0003 — Infrastructure languages: boundaries by role ✅ settled

**Decision**: **Go for the coordination tier** — engine core, agent runtime, hub
service. **Rust for the isolation tier** — node runtime, native drivers, the
Tauri shell, the sandbox host. **Vue and TypeScript for the interface tier.**

Two conditions: (1) **schema-first codegen** for the engine↔node protocol from day
zero — hand-written types on both sides are forbidden; (2) no language spreads
outside its role.

**The reasoning**: the engine↔node boundary is a loose, versioned protocol
boundary — N-1 skew is a ceiling mechanism, so codegen is mandatory even within
one language, which makes the cost of a second language lower than it appears.
The node↔driver↔Tauri boundary is a tight same-machine boundary, so it shares
Rust. The node is the most security-sensitive component — credential injection,
masking — so memory safety is a real value.

**On the scale and compute-cost axis**: a Go single-binary distroless image is
around 20 MB, and high density means low SaaS cost. The engine is
**stateless by design** — state lives in the log and leases, and the kill-9 litmus
_is_ the autoscaling test — sharding naturally by (tenant, stream). CPU-burst
replay and rebuild is where a TypeScript engine falls down, which is what ruled
out the TypeScript options.

_The options considered, kept for traceability._ The frontend and first SDK are
TypeScript, settled by the web charter. The open question was the engine server
and the RPA node:

| Option | Configuration         | Gains                                                                                                                                  | Costs                                                                                       |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A      | Go server, Go node    | One type chain from log to engine to node; first-class OCI and sigstore SDKs; a single static binary node; AI reads and writes it well | No sum types — model taxonomy through interfaces, with the suite compensating               |
| B      | TS engine, Go node    | Maximum AI throughput in the engine                                                                                                    | A permanent two-language tax: protocol types twice, two build chains                        |
| C      | TypeScript throughout | One language everywhere                                                                                                                | A bulky node package, which damages the wedge's first impression; weak CPU-burst projection |

An honest precedent: n8n is TypeScript throughout and successful — but n8n is not
event-sourced, so its costs are different.

**Scope, to prevent a misreading**: this ADR chooses the language for writing
_infrastructure_ — engine, hub service, node runtime. It does **not** limit the
user's language choices. An RPA script is a _declarative_ artifact rather than
code (RPA North Star §5), drivers are polyglot through a contract, an external
filler may be written in any language through the SDK or API, and a custom code
block remains a future door through the sandbox and the Hub's trust classes. Go's
weakness at desktop automation is answered by drivers being permitted to be
polyglot under an Apache 2.0 contract.

**The small stack does not affect this choice** — all three options embed SQLite
and DuckDB well.

## ADR-0004 — Frontend: the Vue ecosystem ✅ settled

**Decision**: Vue across every frontend — Nuxt for the site at `/` and the hub
index at `/hub`, where SSG with ISR is needed; Vue 3 with Vite for the **Work
Surface** at `/app` and the pair-design canvas; Storybook Vue at `/design`; Vue
Flow for the node-graph editor. TypeScript throughout.

**A phrase corrected.** An earlier version called the surface at `/app` "the
console", a name the ceiling never uses: Human Surface §0 and roadmap §6b E.1
both call it the **Work Surface**, and a second name for one surface is a second
thing for a reader to reconcile. The decision is unchanged — Vue 3 with Vite,
at `/app` — only the noun is corrected, here and in ADR-0005's "console
components".

**Against the ceiling**: the web charter is **deliberately framework-agnostic**
(§3b — the render model is "a consequence of mechanism, not a framework choice"),
so this touches no ceiling line.

**A strong precedent**: n8n built an entire visual automation editor in Vue —
which is precisely ecoma's hardest frontend problem.

**Two risks with valves**: (1) Nuxt and Nitro's on-demand ISR is less mature than
Next's — the charter's requirement is at the level of _cache behaviour_, and a
webhook rebuilding a single page achieves the same behaviour where needed; (2) LLM
training data leans slightly React — the valve is the Storybook design system plus
spec anchoring as the source of truth.

It does not constrain ADR-0003; the two are fully independent.

## ADR-0005 — Attended desktop: Tauri and native Rust, runtime split from UI ✅ settled

**Decision**: the attended desktop app is **Tauri** — a Rust shell with a **Vue**
frontend, reusing the `/design` design system and Work Surface components — with native
**Rust** for the desktop modules that need the system: screen capture, input
injection, UIA and AX bindings.

**Resolving the "one binary for attended and unattended" tension**: the node
runtime is **a single headless binary running both modes**, so the ceiling stands
unchanged. Tauri is **an attached attended UI layer** talking to the runtime over
**localhost IPC authenticated by node identity**. An unattended install has no
webview. Both artifacts update through the Hub.

**A phrase corrected.** An earlier version wrote "the takeover/approve frame is
the diff-Judgment component", **conflating two different things**. They separate
as: (1) **confirming within an attended session** — a person sitting at the
machine permitting an Action about to run, which is **local session control**,
travels the in-machine channel, belongs to **◆G1**, and exists at M1; and (2)
**approving an Action Item in a queue** — a person not sitting at that machine,
which is **a labour surface**, goes straight to the engine API and the projection
read-API, belongs to **◆G4**, and belongs to Track E. Tauri at M1 does **only**
(1).

**Three hard boundaries set by the ceiling** (RPA North Star §4, "the local
attended UI layer"): (1) the IPC carries **only local session control** — no
effect stream and no labour semantics, so the system still has exactly two
interfaces; (2) **every labour action from the UI — approve, Judgment, claim,
release — goes STRAIGHT to the engine API**, so Tauri's diff-Judgment component is
**a client of the projection read-API (◆G4)** rather than a write path through
IPC (Human Surface §0); (3) the UI **stores no frames** — what reaches the log is
always the masked Scene. Checked by RPA North Star litmus #10: switch off the IPC
and the runtime still runs completely.

_Scheduling consequence_: Track B acquires a second gate, ◆G4, for the approval
surface.

**Rust's scope**: the desktop shell and native drivers, extended by the
boundaries-by-role decision to the node runtime and sandbox host. This lands
inside the polyglot-driver valve the ceiling already opened, under an Apache 2.0
contract. It **does not spread into the coordination tier** — if it did, a team of
one person plus AI would be carrying three languages in the core.

**Risks with valves**: webview parity across three operating systems (WebView2,
WKWebView, WebKitGTK) is covered by per-OS attended QA in nightly CI; the IPC
binds only to localhost with a node-identity token and opens no port.

It does not constrain ADR-0003 — Rust in the shell layer does not decide the
engine or node-runtime language.

## ADR-0006 — User code across runtimes: at minimum JS/TS, Python and Go ✅ settled

**Commitment**: every door for user code running INSIDE the system — the
execution sandbox for code rule fillers, tool execution, custom code blocks —
supports an **open runtime taxonomy with at least three**: **JS/TS** (widespread,
and LLMs handle it well), **Python** (LLMs handle it well and it is token-compact,
which matters because the most prolific author of code blocks in the long run is
an AI Drafter, making tokens a direct operating cost), and **Go** (performance and
concurrency).

**Rust is not committed** — the polyglot driver and extension door already serves
that need, and adding a runtime later is adding an adapter rather than changing a
mechanism.

**A hard condition**: **Python runs natively in the sandbox; the Pyodide and WASM
route is forbidden.** C extensions — numpy, pandas, requests — break on WASM.
Precedent runs both ways: n8n's Pyodide Python was poorly received, and Dify's
native Python succeeded.

**Mechanism**: the sandbox executor follows the deployment shape, consistent with
ADR-0002 — process isolation when small, a container or microVM pool (gVisor,
Firecracker as a Kubernetes runtime class) on Kubernetes and SaaS. **A runtime
image is a versioned artifact distributed through the Hub** under a trust class,
and **every code block is a filler with an identity, so calibration attaches to it
like any filler** — symmetry preserved, no new mechanism.

**Ship order**: JS/TS → Python → Go, following the funnel from the solo-developer
wedge, through the AI crowd, to the power user. The milestone is decided by the
`runtime sandbox` specification, which carries it; this ADR was an input
constraint on that specification.

**The `supports_dry_run` condition**: every adapter and sandbox executor either
**declares the `dry_run` capability** — running without emitting outward effects —
or declares that it does not support it. Absent or unsupported, a contract's
`dry_run` resolves to `forbidden` (Handoff §3, Test Harness §5). Also an input
constraint on the `runtime sandbox` specification.

**SaaS cost**: code execution is measurable CPU, so metering (M0) and quota (a
pending specification) cover it entirely.

## ADR-0007 — VitePress for the doctrine surface ✅ settled

**Context**: the published ceiling needs a static surface mounted at
`ecoma.io/doctrine`, reading `shared/libs/doctrine` at build time. This is **a
technology mandate**, so it must be an ADR rather than slipping into a code pull
request.

**Decision**: **VitePress.**

**The reasoning — three constraints that already existed, not a preference:**

| Existing constraint                                                                                                       | How VitePress answers it                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **ADR-0004 settled on Vue**; the toolchain is already Vite; `core-ui` is Vue and Tailwind v4 through Vite                 | Vue-native, running on the workspace's own Vite — no second frontend runtime enters the repository                     |
| Web charter §3b: `/design` is **SSG per release**; doctrine is the same class, changing at tag time rather than per event | SSG by default; no ISR and no server needed                                                                            |
| The content is **plain Markdown**, and navigation must be **derived** (Rule 14) rather than listed by hand                | The config is TypeScript, so `import { buildNav } from "@ecoma-io/doctrine"` is a real Nx edge that `nx affected` sees |

**Options rejected, on mechanism:**

| Option                                  | Why not                                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docusaurus or Starlight**             | Pulls React, or Astro, into a workspace already settled on Vue — two component systems for two documentation surfaces (`/design` in Storybook Vue, `/doctrine` in React) is **two homes for one kind of work** |
| **Folding it into Storybook `/design`** | Storybook renders **a design system**; doctrine is prose. Merged, one of them has to pretend to be the other, and `check-e2e-story-coverage` would measure the wrong thing                                     |
| **Writing our own SSG**                 | Rule 2's simplicity ladder: a library does exactly this job, and writing our own trades permanent operational debt for zero capability                                                                         |

**The declared cost**: one large dependency, and VitePress's default theme does
not use `core-ui`'s tokens, so the doctrine surface will **not** match `/design`
exactly unless and until a custom theme is written. Accepted: doctrine is prose to
be read rather than a product to be sold, and brand consistency here is a wish
rather than a mechanism.

**The condition for reversing it**: the content is plain Markdown and the
navigation is a pure function inside `shared/libs/doctrine`. Changing SSG means
rewriting one app and touching **no** line of content. That is why the library was
separated from the app from the beginning.

## ADR-0008 — Subsystem structure ✅ settled

**Decision**: the `platform` area, the engine split by hexagonal layer rather
than by feature, one conformance suite per started gate, and the cross-domain
runtime contract outside every domain in `shared/packages/`.

**It lives in its own document**, [subsystem-structure](./subsystem-structure.md),
not in this ledger, and the reason is mechanical rather than editorial: it is
the first ADR that carries a **freeze**. A freeze is frontmatter — `status`,
`gate` and `frozen-scope` — read by `dev-cli conformance` per file, so an ADR
that freezes anything has to be a file of its own. Written here, its freeze
would be this ledger's, closing ADR-0001 through ADR-0007 along with it.

**What it freezes** is the half of roadmap §1b rule #7 that a text alone cannot
answer: which suite arbitrates ◆G0 and what that suite's complete scope is. It
does **not** widen what ◆G0 freezes. The `status: frozen` flip is a later act,
landing with the pull request that makes `conformance-g0` green.

## Ledger

| ADR                                                                           | Status              |
| ----------------------------------------------------------------------------- | ------------------- |
| 0001 durable execution                                                        | ✅ settled          |
| 0002 storage ports, defaults by shape                                         | ✅ settled          |
| 0003 infrastructure languages — boundaries by role                            | ✅ settled          |
| 0004 frontend Vue                                                             | ✅ settled by owner |
| 0005 attended desktop Tauri and Rust, runtime split from UI                   | ✅ settled by owner |
| 0006 user code across runtimes (JS/TS, Python, Go; Python native)             | ✅ settled          |
| **0007 VitePress for the doctrine surface**                                   | ✅ settled          |
| **0008 subsystem structure — `platform` area, engine libraries, gate suites** | ✅ settled          |
