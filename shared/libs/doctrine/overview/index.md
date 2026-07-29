---
title: "Ecoma — the design end state"
status: design-end-state
---

# Ecoma — the design end state

This tree describes the system Ecoma is designed to be, not the system that
exists today. It is a **ceiling**: every slice of delivery may narrow value or
policy, and none may violate a mechanism written here. Where a roadmap and this
tree disagree about what something _is_, this tree wins; where they disagree
about _when_ it arrives, the roadmap does.

Nothing here is an implementation report. A statement in these documents is a
commitment about how the system behaves once built, which is why each one can be
argued with before a line of code depends on it.

## What the system is

**Ecoma is a fair-code, self-hostable labour operating system in which people,
AI, and rules/code are the same kind of labour resource (Role/Filler); processes
— deterministic and reasoning alike — are designed by humans and AI together on
the engine itself; every output has a path through a checkpoint whose confidence
is calibrated against each tenant's own data; and human attention is a resource
that is measured and optimised.**

## How the tree is organised

Three vertical domains, each with a North Star that owns its vocabulary:

| Domain                                | What it owns                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| [Platform](../north-star/platform.md) | Labour coordination — the primitives, composition, and the shared subsystems |
| [RPA](../north-star/rpa.md)           | Execution against environments the system does not control                   |
| [Hub](../north-star/hub.md)           | Distribution of static content: registry, index, marketplace                 |

Two layers cut across all three rather than sitting beside them. **Enterprise**
is a licence layer: modules that plug into extension points the engine declares,
never a fork. **Cloud** is an operating form: the same build running with tenant
cardinality greater than one, plus an operator control plane that is not shipped.

The boundaries between the three are narrow by design, and the narrowness is the
point:

- Platform reaches RPA through exactly two runtime interfaces — a Filler and a
  Session effect. Anything else would put selector, vision, and driver concerns
  inside the coordination engine, where changing a browser would change a
  workflow.
- Everyone reaches Hub through one client interface: `resolve` / `pull` /
  `verify`. **Hub never touches runtime.** Unplug it and everything already
  installed runs forever — which is what makes a distribution channel safe to
  depend on.

## Reading order

The tree is not alphabetical and does not read well in file order. This is the
order in which each document's assumptions are already available:

1. **[Platform North Star](../north-star/platform.md)** — canonical for the four
   mechanism principles and the five invariants. Every other document references
   them and none restates them.
2. **[Composition](../spec/composition.md)** — how the primitives assemble into a
   Process, and where the Platform/RPA boundary falls.
3. **The primitives**, in dependency order:
   [Role](../spec/role.md) → [Task](../spec/task.md) →
   [Checkpoint](../spec/checkpoint.md) → [Handoff](../spec/handoff.md) →
   [Escalation](../spec/escalation.md).
4. **The way in and out**: [Trigger & Channel](../spec/trigger-channel.md).
5. **The tier-one subsystems** every other mechanism rests on:
   [Event Log](../spec/event-log.md), [Artifact Store](../spec/artifact-store.md),
   [Vault & Key](../spec/vault-key.md),
   [Tenant & Identity](../spec/tenant-identity.md).
6. **The opt-in modules and projections**: [Knowledge](../spec/knowledge.md),
   [Memory](../spec/memory.md), [Working Data](../spec/working-data.md),
   [Calibration](../spec/calibration.md),
   [Human Surface](../spec/human-surface.md).
7. **The cross-cutting mechanisms**:
   [Release & Compatibility](../spec/release-compat.md),
   [Test Harness](../spec/test-harness.md).
8. **[RPA North Star](../north-star/rpa.md)**, then its specs:
   [Action](../spec/rpa-action.md) → [Session](../spec/rpa-session.md) →
   [Driver & Perception](../spec/rpa-driver-perception.md) →
   [Self-healing](../spec/rpa-self-healing.md) →
   [Sandbox & Credential](../spec/rpa-sandbox-credential.md).
9. **[Hub North Star](../north-star/hub.md)**, then [Block](../spec/block.md).

Outside the ceiling, and deliberately so: the [roadmap](../method/roadmap.md)
(build order — the one document allowed to name phases), the
[review rubric](../method/review-rubric.md) and
[scenario catalog](../method/scenario-catalog.md) (the tools this tree is
reviewed with), the [ADR ledger](../method/adr-ledger.md) (implementation
decisions), and the [deploy charter](../charter/deploy.md) (how an operator runs
it).

## Glossary — one concept, one name

A concept that acquires a second name acquires a second definition, and the two
drift the first time someone edits only one of them. These are the names.

**Labour.** _Role_ — a position of labour, defined by capability rather than by
who fills it. _Filler_ — the person, agent, rule, or process occupying a Role.
_Task_ — one instance of work; _Attempt_ — one try at it, first-class so a retry
carries the feedback that caused it.

**Judgment.** _Checkpoint_ resolves into three things that are deliberately not
one: a _Gate_ (the blocking point), a _Judgment_ (a signed verdict, append-only),
and a _Criterion_ (a library entity owned by the tenant).

**Movement between steps.** _Handoff_ — the transfer itself. _Contract_ — what
the receiving step is promised. _Artifact_ — immutable, content-addressed.
_Envelope_ — the accumulated context, delivered as a projection. _Effect_ —
reversible, compensable, or irreversible, carrying a serialization key.
_Escalation_ — an open taxonomy with a mandatory terminal handler, so no path
ends in silence.

**Distribution.** _Block_ — the unit of packaging and distribution. _Template_ —
a Block curated for a vertical.

**Knowledge and memory, which are not each other.** _Collection_ / _Chunk_ /
_Curator_ belong to Knowledge. _Memory entry_ / _Subject_ / _Party_ belong to
Memory. _Calibration_ is about **the one doing the labour**; _Memory_ is about
**the one being served**. Merging them would make a change of model erase what
the organisation knows about a customer.

**Data.** _DataTable_ — a writable projection. _Lease_ — the only locking
primitive, TTL mandatory. _Projection_ — any view derived from the Event Log,
always rebuildable. _Classification lattice_ and _leakage gate_ govern what may
leave.

**Identity.** _Principal_ — user, agent, rule, node, or external. _Tenant_ — a
hard boundary. _Workspace_ — a soft partition for administration and display,
**not** a security boundary: same tenant key, same log namespace, deduplication
permitted. _Party_ — a subject of memory, mergeable through a Gate.

**Calibration.** _CalKey_ and _Cell_ — the key and the cell of a calibration
projection. _Estimator identity_ — the `method@version` of the estimate itself,
so a change of estimator is visible rather than silent.

**RPA.** _Node_ — an RPA host. _Session_ — one run against an environment.
_Scene_ — a three-layer, content-addressed, masked snapshot of that environment.
_Evidence_ — the hash of a Scene before and after an Action. _Commit point_ — the
first irreversible action already executed, which is the boundary of any unwind.
_Macro_ — a named, versioned sequence of Actions. _App Profile_ — per-application
knowledge: reversibility classes and stable locators. _Sub-actor_ — an actor
_inside_ a Filler (script, agent, person, tool call); not a Task.

**Testing.** _Test run scope_ — a run labelled `run_kind: test` inside the real
tenant, isolated by projection filter rather than by a separate tenant.
_`environment: production | test`_ — a dimension of Filler identity, not a fifth
trust tier. _Mock filler_ — a real Filler, `mock:<name>@version`, reached through
the ordinary Filler interface. _Fixture_ — seed data with id, version and
lineage. _Assertion artifact_ — a declared, versioned assertion measured against
the log. _Conformance suite_ — the same harness mechanism, with an
_implementation_ of an interface as its subject. _`supports_dry_run`_ — an
adapter capability; an adapter that does not support it resolves the `dry_run`
contract to `forbidden` rather than pretending.

**Keys.** _Rotate ≠ Shred_ — rotating a key does not re-encrypt; destroying one
erases permanently. _Vault_ splits into two meanings that must not merge: a
_credential vault_ (operational secrets) and a _PII vault backend_ (data-subject
keys, an Enterprise extension point). _Forward-only replica_ — the only replica
class valid for key material, because a `destroy` must be able to replicate to
it; point-in-time snapshots of key material are forbidden.

**Release.** _Release train `X.Y.Z`_ — the version axis of the **workspace**, not
of an app. _Protocol version_ — a separate monotonic integer per protocol.
_Rollback window_ — outside it, the operation is no longer a rollback but a
restore and replay. _Support window_ — the current major plus one before it;
backup retention may not exceed it.

**Storage.** _Reference backend ≠ installation default_ — Postgres is what the
contract suite is proven against; what a given installation runs depends on its
deployment form (see [ADR-0002](../method/adr-ledger.md)). _Small-stack_ —
SQLite, DuckDB and sqlite-vec, for single-binary and single-container forms.

**Surfaces and licensing.** _Work Item_ / _Action Item_ — the Human Surface object
model. _`run_kind: production | test`_ — a label on a log entry; every projection
must declare its position on it. _`<area>/enterprise/`_ — the Enterprise licence
directory, tagged `license:ee`; `ee` may import `sul`, and `sul` may never import
`ee`. _Single-tenant self-host_ — capped by a **product boundary** (the workflow
that creates a tenant ships only in the operator's control plane), never by a
licence check.

## Resolving a conflict

Two rules, both because a document set with no tie-breaker resolves conflicts by
whoever edited last:

- **Precedence when statements disagree**: invariant, then canonical principle,
  then domain principle, then template. The invariants and the canonical
  principles live in the [Platform North Star](../north-star/platform.md); every
  other document references them rather than restating them, so there is one text
  to change.
- **A new concept must say what it is a concept _of_**: the entity, the policy,
  or the template of which mechanism. A concept that cannot answer is a name
  looking for a mechanism, and it will be given one later by accident.
