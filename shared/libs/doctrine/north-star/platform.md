---
title: "Ecoma Platform — North Star"
status: design-end-state
---

# Ecoma Platform — North Star

This document is the canonical source for the four mechanism principles and the
five invariants. Every other document in the tree references them; none restates
them. When two texts disagree, this one wins.

It describes a ceiling, not a first release. A delivery slice may narrow value or
policy; it may not violate a mechanism written here.

## The end state

**Ecoma is a fair-code, self-hostable labour operating system in which people,
AI, and rules/code are the same kind of labour resource (Role/Filler); processes
— deterministic and reasoning alike — are designed by humans and AI together on
the engine itself; every output has a path through a checkpoint whose confidence
is calibrated against each tenant's own data; and human attention is a resource
that is measured and optimised.**

It is built as one monorepo with three separate domains: **Platform** (labour
coordination — this document), **[RPA](rpa.md)** (execution against environments
the system does not control), and **[Hub](hub.md)** (distribution of static
content: registry, index, marketplace). Platform consumes RPA through exactly two
runtime interfaces — a Filler and a Session effect. Platform and RPA both speak
to Hub through one client interface: `resolve` / `pull` / `verify`. **Hub never
touches runtime**: unplug it and everything already installed runs forever.

## The problem, and why the existing systems do not solve it

The pain is not a shortage of automation. It is that **two workforces have never
been unified**. AI multiplies output and creates a verification bottleneck in the
same motion — every output needs review, and the queue settles on human
attention. Between people, context lives in someone's head. Between steps, there
is no contract. And no system lets a person and an AI swap into the same
position.

Every existing system **arrives from a trade** and bolts the other half on:
integration platforms from iPaaS, robotic automation from screen-scraping, BPMN
engines from a specification that forbids branches nobody declared in advance,
has no serious compensation, and treats escalation as an exception. BPMN failed
at its own founding promise — that the business could draw it and the machine
could run it — even though roughly a fifth of its elements already covers the
overwhelming majority of real processes.

Ecoma restarts from the original assumption instead: **one kind of labour
resource, a small set of primitives, absolute symmetry.**

**Why growth does not force a rewrite.** A single operator feels the coordination
pain immediately — output triples and the bottleneck moves to verification — yet
no company stays at one person, and no customer refuses to grow. The answer is
mechanical: **the same primitives from one person to many.** At one person,
Checkpoint carries the weight, optimising the attention of the only reviewer
there is. As headcount grows, Handoff carries it — contract, ownership, and
context that lives outside anyone's head. A newly hired person is a Filler
entering a Role that already exists, and can run in shadow to learn the job from
the record. Growth is a consequence, and the system is already shaped for it.

## The four mechanism principles

**This is the canonical text.** Specifications reference it and never copy it.

1. **The engine is absolutely symmetric** between people, AI, and rules/code.
   Asymmetry is allowed to exist only at the policy and template layer.
2. **Anything that must accumulate learning is a first-class entity with a stable
   identity — and that identity has lineage.** Calibration is inherited with
   decay, so evolving a filler never resets its flywheel.
3. **The engine forces parameters to exist; the template forces their values.**
4. **Complexity is the user's choice**: the mechanism is complete, the default is
   minimal through a cascade (tenant → template → process → role → task), and
   everything advanced is opt-in.

## The five invariants

1. People and AI fill the same kind of Role. Changing the Filler does not change
   the flow.
2. Every output has a path through a Checkpoint, and no action is untraceable —
   including an override, which is a signed Judgment rather than a way around
   one.
3. Human attention is a measured and optimised resource: triage, sampling, storm
   control, priority queues.
4. Learning data belongs to the tenant. **There is no cross-tenant learning.**
   Cold start is answered instead by a shared Criterion and Contract library, by
   identity lineage, and by template priors.
5. Process state is durable and lives independently of anyone's memory. There is
   no silent stall — a terminal escalation handler is mandatory — and nothing
   ever auto-passes because of a timeout or a deadlock.

## The primitives, and the composition layer above them

| Specification                                        | The mechanism it owns                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Role](../spec/role.md)                              | A capability slot separated from whoever fills it. Calibration keyed by role, filler, task type and criterion. Two-way shadow mode. Trust tiers that move in both directions automatically                                                      |
| [Task](../spec/task.md)                              | An instance of work with first-class Attempts, durable for weeks. **Dynamic spawning** is where the deterministic graph and the reasoning graph meet: an agent may create a task assigned to a person                                           |
| [Checkpoint](../spec/checkpoint.md)                  | A blocking Gate, separated from an append-only Judgment. Criterion is a tenant library entity. Confidence in three layers, calibrated per tenant                                                                                                |
| [Handoff](../spec/handoff.md)                        | A contract in three layers — schema, semantic, context. A self-accumulating Envelope delivered as a projection. Effects with three reversibility classes. Compensation is a Task of a Role                                                      |
| [Escalation](../spec/escalation.md)                  | A first-class citizen: an escalation is a Task, and the chain cascades. Asking for help is **rewarded** in calibration rather than penalised                                                                                                    |
| [Composition](../spec/composition.md)                | A Process is an Artifact obeying a contract, pinned with explicit migration. Static analysis. Paired design is itself an Ecoma workflow                                                                                                         |
| [Trigger & Channel](../spec/trigger-channel.md)      | The way in and out: authentication at the boundary, a payload that is a Handoff under contract, conversational correlation. An end user is an `external` Filler of a Role                                                                       |
| [Knowledge](../spec/knowledge.md)                    | Knowledge as a business asset: a Collection with a Curator Role, grants by Role, a classification lattice with a two-layer egress gate                                                                                                          |
| [Artifact Store](../spec/artifact-store.md)          | "The hash is permanent, the bytes follow policy" — permanent truth in the log, a lifecycle for blobs, reference-counted collection, deduplication only inside a tenant                                                                          |
| [Event Log](../spec/event-log.md)                    | The single source of truth, append-only per tenant. Metering, audit, search, notification and calibration input are all rebuildable **projections**. Crypto-shredding reconciles append-only with the right to be forgotten                     |
| [Working Data](../spec/working-data.md)              | "SQL to ask, events to write" — DataTable as a writable projection; **Lease is the only locking primitive**, TTL mandatory                                                                                                                      |
| [Memory](../spec/memory.md)                          | Recollection belongs to the **organisation, keyed by subject** — never to a filler, so changing model or person loses nothing. Provenance mandatory against fabrication                                                                         |
| [Tenant & Identity](../spec/tenant-identity.md)      | One authorisation system, not two: administrator and process owner are Roles someone fills. Tenant is a hard boundary, workspace a soft one. Pseudonymous actor ids with shreddable personal data — the audit survives, the person is forgotten |
| [Calibration](../spec/calibration.md)                | The data model behind confidence: a multi-dimensional key, lineage with time decay, and an explicit estimator identity                                                                                                                          |
| [Human Surface](../spec/human-surface.md)            | The Work Surface: one object model of Work and Action Items, two views. "Inbox" is one view, not the model                                                                                                                                      |
| [Vault & Key](../spec/vault-key.md)                  | A three-tier key tree, rotate ≠ shred, disaster-recovery obligations and the rule that governs which replica classes may hold key material                                                                                                      |
| [Release & Compatibility](../spec/release-compat.md) | Three version axes, negotiation, upgrade and rollback, end-of-life windows                                                                                                                                                                      |
| [Test Harness](../spec/test-harness.md)              | A mode of the engine rather than a tool beside it: test run scope, fixtures, mocks, assertions, and the conformance suites                                                                                                                      |

One property runs through all of them: every system operation — coerce, merge,
distil, arbitrate, adapt, compensate, migrate, design — is **a Task of a Role**.
There is no magic node. All labour passes through one mechanism, which is what
makes all labour observable through one mechanism.

## Four litmus questions

These define what "unified" means, and they are measurable rather than
rhetorical:

1. Can a step move from a person to an AI **without editing the flow**?
2. Can it run in shadow mode with an automatically generated comparison?
3. Is there **one trust scale** covering both people and AI?
4. Can cost and quality be seen **per Role**, whoever fills it?

## Non-goals

- **No BPMN 2.0 compliance.** The primitive set here replaces it rather than
  implementing it.
- **Platform contains no robotic-automation technology** — no selectors, no
  vision, no drivers. That is RPA's domain, reached through the Filler and
  Session effect interfaces. Otherwise changing a browser would change a
  workflow.
- **The engine never edits an artifact, merges, or migrates by itself.** Every
  intervention is a Task of a Role and leaves a trace.
- **No shared mutable state between steps.** Everything moves through a Handoff.
- **Ecoma is not a chat assistant** — but a user building a chatbot on Ecoma is a
  first-class use case. The product is **self-serve first**: usable without an
  implementation team. Enterprise is a deployment and licence tier, not a sales
  channel that gets to decide the design.
- **The runtime never checks entitlement.** No licence key, no phone-home.
  Commercialisation of content stops at the distribution layer.
- **No general-purpose warehouse and no vector engine of our own.** Labour
  analytics is a projection plus an export you own; vectors arrive through an
  adapter. The moat is the labour dataset, not a SQL engine.
- **No cross-tenant learning, and no "ML suggests an optimisation"** before the
  Judgment and Escalation flywheels have data. When they do, the sources are
  already named: Judgment, the escalation log, conflicts, and outcome
  propagation.

## Product architecture and the distribution model

**The layers, in build order.** Each rests on the one before it, which is what
makes the order a dependency rather than a preference:

| Layer | What it is    | Contents                                                                                      |
| ----- | ------------- | --------------------------------------------------------------------------------------------- |
| 1     | Core engine   | The primitives, composition, event log, artifact store, durable execution, static analysis    |
| 2     | Agent runtime | Runs internal agent fillers; RPA and external runtimes plug in through the standard interface |
| 3     | Human surface | The Work Surface: triage, batch review, diff, mobile                                          |
| 4     | Paired design | The design workflow, running on the engine itself, plus a canvas                              |
| 5     | Intelligence  | Per-tenant learning from Judgment, escalation, conflict and outcome                           |

### Fair-code, and why the label matters

Ecoma is **fair-code / source-available**. It is deliberately not called open
source, and the three words are not interchangeable:

|                   | What it gives                                                                                                           | What it costs                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Open source (OSI) | Everything below, plus the label                                                                                        | Freedom zero requires permitting **any** purpose, including reselling Ecoma as a competing service. No clause can forbid it |
| Fair-code (Ecoma) | Code that is public, readable, freely self-hosted and freely modified — every mechanism promised to a tenant is visible | Reselling Ecoma as a service is forbidden                                                                                   |

Calling it "closed" loses the people who would read the code; calling it "open
source" gives up the right to forbid resale. Being precise about the label is not
pedantry — it is the only way both properties survive.

### Licensing is a classification rule, not a list

One question decides every unit: **does a third party need this to _plug into_
the system, or to _run_ the system?**

| Answer                                                                 | Licence                                |
| ---------------------------------------------------------------------- | -------------------------------------- |
| **Plug into** — interface, schema, protocol, client, SDK, vocabulary   | Apache 2.0                             |
| **Run** — any server, node or service implementation in a product area | The fair-code source licence           |
| A module plugging into a declared extension point                      | Enterprise, under `<area>/enterprise/` |
| The operator's control plane                                           | Proprietary, not published             |

The rule exists because a list drifts and a rule does not. An earlier attempt
declared the permissive licence in five separate specifications while an
area-level table declared every area under the fair-code licence — the table
simply could not express a licence below area granularity. **Licences cut by
unit, never by area.**

### Repository topology, and why the boundaries coincide

Top-level directories are areas. Each area splits into `apps/`, `libs/` and
`packages/`, and those three differ in a way that decides who may depend on them:

| Tier        | `private` | Versioned              | Who consumes it                                   |
| ----------- | --------- | ---------------------- | ------------------------------------------------- |
| `apps/`     | —         | stamped with the train | A deployable artifact                             |
| `libs/`     | `true`    | not versioned          | **Only inside the workspace**                     |
| `packages/` | `false`   | the train version      | **Third parties** — SDK, protocol, schema, client |

The consequence is the point: **the licence boundary, the publish boundary and
the directory boundary are the same boundary.** The classification rule above
says "plug into → Apache 2.0", and the units that plug in are exactly the ones in
`packages/`. One decision, three places agreeing by construction rather than by
hand.

There is deliberately **no `connectors/` area**. First-party drivers and channel
adapters live in their own domain's `libs/`, tagged as adapters, because they
implement a port belonging to that domain rather than forming a seventh domain.
Splitting them out would sever each adapter from the port it serves, in exchange
for tidiness. The interface a **third party** needs to write one stays public in
`packages/`, and that is the boundary actually worth defending.

**A hexagonal layer axis, enforced by lint.** Each library carries at most one
layer — utility, domain, port, adapter, view, app — and the dependency direction
is machine-enforced. Two of those rules pay for themselves:

| Rule                                                                          | What it protects                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An app layer may use port, domain and utility — **never an adapter directly** | This is the storage-port decision made executable. Touching an engine goes through a port, so the engine stays replaceable. Without it, "port" is a directory rather than a boundary |
| A view layer never touches the desktop host runtime                           | The view emits intent and the shell wires it up, so the attended UI layer is not a second write path                                                                                 |

The ceiling settles only that this axis exists and that these two rules hold. The
full configuration belongs to the repository, and is not restated here.

### Self-hosting is single-tenant, and the reason is invariant 4

> **Multi-tenancy never grants a user a single additional capability. It only
> saves operating cost.**

Because invariant 4 forbids cross-tenant learning, two tenants on one
installation are **equivalent to two separate installations in every respect that
is a product**: no shared calibration, no shared memory, no shared knowledge. The
only difference is one infrastructure cluster instead of two — and "operational
savings at scale" is precisely what a service provider sells. Conversely, putting
multi-tenancy in the enterprise tier would ship the riskiest code there is —
tenant creation and the root of the key tree — to the widest audience in exchange
for zero new capability.

Two mechanical consequences follow, and neither is optional:

| Consequence                                     | The rule                                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The engine is always tenant-aware**           | Key tree, per-tenant log, scoped authorisation, deduplication confined to a tenant, per-tenant metering. **The tenant layer exists physically even at cardinality one** — dropping it "for simplicity" turns every later move to multi-tenancy into a full key migration |
| **The cap of one tenant is a product boundary** | A self-hosted installation has no second tenant because the workflow that creates one ships only in the operator's control plane — not because the runtime checks an entitlement. The non-goals above forbid that outright                                               |

Invariant 4 binds the operator too. An operator may **aggregate metering** across
tenants; an operator may **never** route knowledge, memory or calibration across
them. That boundary has to be stated publicly and carry a litmus, precisely
because the code enforcing it lives where outsiders cannot audit it.

### Versioning and release

- **One release train `X.Y.Z` for every artifact** — servers, node binary, charts,
  SDKs — so compatibility collapses to a single axis.
- **A separate protocol version per interface**, negotiated at handshake.
- **Skew**: a server supports one minor version back. Outside that window a node
  refuses to claim work and escalates, which is safer than running the wrong
  thing.
- **Breaking changes only at a major**, with at least one minor of deprecation
  first.
- **The log is never rewritten** on upgrade — readers tolerate older schema
  versions, and projections are rebuilt because they are derived. **Each migration
  step is an entry in the log**, so an upgrade has provenance. Majors run in
  sequence and are not skipped.
- **Rollback is an explicit inverse migration.** Every major migration declares a
  down-migration or declares itself irreversible; declaring neither is treated as
  having no way back, and the engine demands a gate and a copy before running it.
  Pinning an older version is only a rollback while the data has not changed
  shape. Once it has, rollback is a full migration: a Task of a Role, with a gate
  and a log entry, not a button.

### Deployment and storage

Deployment is through containers and orchestration. Storage sits behind **five
ports whose defaults follow the deployment form** ([ADR-0002](../method/adr-ledger.md)):
a single binary or single container gets the small stack; a production cluster
gets one database carrying the event log, the writable projections, vectors and
metrics. **The reference backend for the conformance suite is Postgres**, which is
not the same statement as an installation default. **A default is not a coupling**
— every backend is an adapter behind a port. Upgrading a backend is a replay of
the log, never an automatic conversion.
