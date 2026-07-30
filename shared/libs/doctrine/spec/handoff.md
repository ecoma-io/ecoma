---
title: "Primitive: Handoff"
status: design-end-state
---

# Primitive: Handoff

## 0. The four mechanism principles (canonical: North Star §3)

1. **The engine is strictly symmetric** between people, AI, and rule/code. Any
   asymmetry lives at the policy or template layer.
2. **Anything that has to accumulate learning is a first-class entity with a
   stable identity, and that identity has lineage.**
3. **The engine forces a parameter to exist; a template forces its value.**
4. **Complexity is the user's choice**: the full mechanism, a minimal default
   through the cascade, and advanced capability opt-in.

A deterministic step is a Role filled by `rule`/code. The engine has no
`if deterministic` branch anywhere — behavioural differences emerge from what
was declared (§11).

## 1. Definition

A Handoff is **the transfer of an Artifact from a producing Role to a consuming
Role, under an explicit Contract**. A person needs _context they can be told_; an
AI needs _structure that can be checked_. The Contract carries both, which is
what makes it the point where the two kinds of labour meet at the level of data.

## 2. The conceptual model

| Entity               | What it is                                                                                                                                                | Identity                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Contract**         | Schema, semantics and context requirements. A first-class, versioned entity in a tenant library, reused across processes                                  | Id and version; a process **pins** a version |
| **Artifact**         | Reference, content-addressed hash, metadata and a provenance chain. Immutable once its Gate closes. Physical storage: [artifact-store](artifact-store.md) | Content hash                                 |
| **Handoff instance** | (artifact, contract@version, producer, consumer, state)                                                                                                   | Id, appended to the event log                |
| **Violation**        | An objective breach of the Schema layer at runtime                                                                                                        | Attached to a handoff instance               |
| **Effect**           | An impact outside the system, declared by a Task, carrying a reversibility class                                                                          | Declared in the Task                         |
| **Compensation**     | A remedial action declared in advance for an Effect or Handoff                                                                                            | A Task of some Role                          |

## 3. Contract — three layers

| Layer                    | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Checked by                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema**               | Types and machine-checkable constraints. The single source of the contract criteria a Gate consumes as a hard gate                                                                                                                                                                                                                                                                                                                                             | The engine, deterministically                                                                                                                                                           |
| **`test_behavior`**      | How the contract behaves inside a **test run scope** (Test Harness §1): `mock` (the engine returns a fixture) · `dry_run` (the adapter runs but emits no outward effect — **requires the adapter to declare `supports_dry_run`**, and resolves to `forbidden` where it does not) · `forbidden` (sending mail, third-party HTTP, moving money, writing to an external system). Running for real inside a test requires an explicit declaration and a capability | **Optional in the text; the engine resolves an absent declaration to `forbidden`** (fail-safe). Static analysis **warns** about a contract with an outward effect that declares nothing |
| **Semantic**             | A natural-language description of each field: meaning, purpose, right and wrong examples                                                                                                                                                                                                                                                                                                                                                                       | Verifiers (quality criteria) and people                                                                                                                                                 |
| **Context requirements** | The context fields a consumer needs, projected from the envelope (§5). A deterministic consumer declares none                                                                                                                                                                                                                                                                                                                                                  | The consumer                                                                                                                                                                            |

Making `test_behavior` mandatory in the schema was considered and rejected: it
would fail validation on **every already-pinned contract** — a breaking change
for no gain, because the default is already fail-closed, so an absent declaration
creates no risk. Rejection is reserved for the places where an absent declaration
_is_ the risk, such as a Block manifest's `scope`.

A Contract also declares a **verification depth** per criterion — `metadata` /
`sampled` / `full`. How deeply to check is the user's cost decision.

## 4. Lifecycle

```
offered → validating → accepted → in_use
        ↘ violated → (coerce | reject | escalate)
accepted → bounced
```

**Coercion is a Task of a Role**, AI or human. The engine never edits an artifact
itself; every modification traces back to a Role.

**A bounce splits by the nature of the consumer:**

- A deterministic consumer bounces with a **Violation** — a schema failure,
  objective, always valid.
- A reasoning or human consumer bounces with a **Judgment carrying `basis:
consumer`** — subjective, and it feeds the calibration of the upstream Gate. A
  Gate that passes work which is then bounced repeatedly is a loose Gate, and
  this is how that becomes visible.

**Arbitration**: after N bounces on the same lineage between the same pair — the
engine forces N to be declared, a template supplies it — the engine raises a
**Conflict** and escalates to the **Arbiter Role** declared in the process, the
process owner by default. A bounce never overturns a closed Gate; it opens a new
round of rework with its own trace.

**When the failure happens matters.** A deterministic consumer failing _during
validating_ is a Violation — a defective item. Failing _after accepting_ is a
runtime failure of the consumer's own task and follows that task's `on_fail`. It
is not a bounce.

At `accepted`, ownership passes to the consumer. The boundary of responsibility
is explicit rather than inferred.

An artifact is immutable once its Gate closes. Every edit — including
approve-with-edit at a Checkpoint — creates **a new derived artifact** linked
into the provenance. Nothing is edited in place.

## 5. The context envelope — accumulated automatically, delivered as a projection

The engine **accumulates** the envelope along the chain — the original goal, the
constraints, the decision made at each step — into provenance. Nothing is lost
and nobody composes it by hand; a producer only adds.

A consumer receives a **projection**: the engine projects the envelope down to
exactly the context requirements in the contract. A deterministic step declares
none, so its overhead is zero.

Against unbounded growth, a **Distiller is a Task of a Role** that condenses the
envelope, triggered by a length or step-count policy, opt-in. The full version
stays in provenance — distillation is a delivery convenience, never a deletion.

## 6. Topology

A Handoff is **point-to-point**. Fan-out is several instances from one artifact.

**Fan-in is a Task of a Role** — a merger, AI or human — with its own output
contract. There is no magic merge node, for the same reason there are no system
Roles: a node that merges without a Role is a decision nobody made.

Routing is the business of Role and Task.

## 7. Version and governance

Semantics are semver: adding an optional field is minor; changing a meaning or a
type, or removing a field, is major.

A process pins a version, so editing a shared contract **cannot break** a running
process. A major bump is a new version and old processes stand still.

Migration is explicit, through an **Adapter Role**. The `contract_author`
capability controls who may create a version.

**Version lineage**: calibration binds to (contract id, version) and inherits
from the parent version with a decay factor — approximately zero for a minor,
template-valued for a major. It is the same lineage mechanism Verifier and
Criterion use, and for the same reason: so an evolving contract does not reset
the flywheel.

A change-approval process, where a tenant wants one, is **a workflow running on
ecoma itself** — governance dogfooding, opt-in. Pinning is what provides safety;
the approval ritual is a choice on top of it.

## 8. Effects, reversibility and compensation

A Task declares its **external effects**, each carrying a class of `reversible /
compensable / irreversible` and its compensation. The engine forces the field to
exist and a template forces the value. **An effect declared without a class is
treated as `irreversible`** — conservative by default, matching RPA Action.
Simpler always means safer here, never looser.

An effect may declare a **`serialization_key`**. The engine serialises effects
sharing a key across processes. An external system — a CRM record, a file share —
is the one piece of shared mutable state this design acknowledges, and this is
the minimum valve against races. Without a key the behaviour is optimistic, and
conflicts surface as a Violation or an outcome. Mechanically, a
`serialization_key` is a **micro-lease** the engine manages (Working Data §3 —
Lease is the only locking primitive in the whole system).

**A Session effect** is the streaming kind, for a task that interacts with an
environment through a chain of micro-actions: an RPA session, a browser session,
a terminal session. Its action log is the provenance; **each action carries its
own reversibility class**; the session's commit point is the first irreversible
action that ran. The stream is made of **typed entries**: actions, actor-to-task
attribution, and proposals which the platform materialises into Tasks. Learning
signals derive from the log itself — **there is no third channel** beyond the two
interfaces. This is the standard interface by which **Ecoma RPA, a separate
product in its own domain, plugs into the platform**: the platform knows nothing
of selectors, vision or drivers, only that a filler is emitting a session effect.
Every other external runtime plugs in the same way.

A task that only produces artifacts — most reasoning steps — has no effects and
is therefore freely reversible. Irreversibility concentrates in the
deterministic, side-effecting steps.

**At design time** the engine computes the unwind boundary statically, and warns
about an irreversible effect standing behind a Gate whose calibration is still
immature.

**At runtime** an irreversible effect may demand a **policy floor at the Gate
immediately before it** — for instance, no auto-pass unless calibrated confidence
is at least X. The floor is opt-in.

**Unwinding** walks back up the provenance chain triggering compensations, each a
Task of a Role, because many forms of remediation only a person can perform. It
never crosses the **commit point** where an irreversible effect has run. Past
that, there is redress but no undo.

## 9. Provenance and outcome propagation

An artifact carries its full chain of origin: Task, Role, Judgment, contract
version.

A Judgment with `basis: outcome` attached to the final artifact propagates
backwards along the provenance to the upstream steps, becoming a calibration
signal for every contributing Role and Criterion. The attribution weights are
calibration parameters rather than hardcoded values.

This is what lets a single judgment at the end teach the entire chain.

## 10. Non-goals

- No routing (Role, Task) and no quality assessment (Checkpoint).
- **No shared mutable state between steps** — every exchange goes through a
  Handoff.
- The engine never edits an artifact: coercion, merge, adapt and compensate are
  always Tasks of a Role.

## 11. Duality — one mechanism, behaviour that differentiates itself

| Aspect             | Deterministic (Role = rule/code)   | Reasoning / human                     |
| ------------------ | ---------------------------------- | ------------------------------------- |
| Context envelope   | No requirements, zero overhead     | A projection defined by the contract  |
| Bounce             | A Violation, objective             | A consumer Judgment, with arbitration |
| Verification depth | Schema and metadata suffice        | Sampled or full, by choice            |
| Effects            | Where irreversibility concentrates | Usually effect-free                   |

## 12. Decisions

| Question                  | Settled                                                                                                                                                                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Envelope                  | Accumulated automatically and losslessly; delivered as a projection; the Distiller is an opt-in Role task                                                                                                                                              |
| Bounce                    | Mechanically unbounded; N bounces raise a Conflict for the Arbiter Role; Violation and Judgment split by the nature of the consumer                                                                                                                    |
| Large artifacts           | Always a reference plus a content-addressed hash; verification depth is the user's choice                                                                                                                                                              |
| Reversibility             | Attached to the **effect**, not the step; three classes; the commit point stops the unwind; a policy floor guards the Gate before an irreversible effect                                                                                               |
| Shared contracts          | Pinning plus an Adapter Role instead of an approval bureaucracy; approval is an opt-in ecoma workflow; the `contract_author` capability                                                                                                                |
| **Behaviour under test**  | Declared on the **contract**, not the handoff instance — safety under test is a property of the _kind_ of exchange, not of one exchange. Default `forbidden`, fail-safe, so the test harness never has to _guess_ which effect is safe                 |
| **Mandatory or optional** | **Optional in the text, with the engine resolving an absence to `forbidden`**; static analysis warns. Making it mandatory in the schema would break every pinned contract while reducing no risk, because the default is already fail-closed           |
| **Who owns `dry_run`**    | The **adapter** (`supports_dry_run`), not the contract. A contract declaring `dry_run` against an adapter that does not support it resolves to `forbidden`. Without that rule the harness would have to guess, in exactly the place it promises not to |

## Litmus

1. Does the envelope projection deliver exactly what the contract declares, and
   nothing more?
2. Is an unclassified effect treated as `irreversible` on every path, platform
   and RPA alike?
3. Do more than N bounces on one lineage raise a Conflict and an Arbiter, without
   overturning the closed Gate?
4. Run a process in a test run scope with a contract that sends email: does **no
   email leave the system**, and does the log say the effect was blocked by
   `test_behavior: forbidden` — even when the contract **declared nothing at
   all**?
