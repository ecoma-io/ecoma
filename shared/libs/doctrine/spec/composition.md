---
title: "Composition: Process"
status: design-end-state
---

# Composition: Process

## 1. A Process Definition is an Artifact

A definition declares the graph: the Roles it references, Task templates,
Handoffs with `contract@version`, Gates, escalation chains, `spawn_policy`,
effects, **and Triggers** — the door it starts from
([trigger-channel](trigger-channel.md)).

It is **an Artifact conforming to the standard `process-definition` contract**,
which means it automatically has a content-addressed hash, immutability,
provenance, versioning with pinning, and the ability to pass through a Gate. No
new mechanism is required, and that is the point: a process definition is not a
sixth primitive.

The `process_author` capability controls who may create or edit a version.

## 2. Instance semantics

An instance **pins the definition version at launch**, so editing the definition
does not disturb an instance that has been running for three weeks. It is the
same logic as Contract pinning (Handoff §7).

Migrating an instance to a newer version is **an explicit action**: a Task
assigned to a Role holding `process_author` — person or AI — with its own Gate.
There is no silent auto-migration, because a running process changing shape
underneath the people in it is a change nobody consented to.

## 3. The default cascade — the mechanism behind principle #4

Every parameter the engine forces to exist — SLA, budget, threshold, sampling,
`spawn_policy`, N-bounce — resolves along an inheritance chain:

```
tenant defaults → template (vertical) → process → role → task
```

A lower level overrides a higher one; declaring nothing inherits. _Complexity is
the user's choice_ means precisely this: a simple user only ever touches the
template level, while a power user overrides down to an individual task. A
twenty-step deterministic flow declares only what differs.

**The template level is the set of Blocks the tenant has installed** (Ecoma Hub),
resolved in a priority order the tenant declares. A vertical template is just a
curated Block ([block](block.md)) — not a separate concept.

Resolved values are **snapshotted into the instance at launch**, so changing a
tenant default does not change a running instance.

## 4. Static analysis — the labour OS's compiler

The engine checks a definition statically before allowing it to launch, and warns
at design time:

| Check                                                                                                                                                                                                                      | Mechanism source            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Producer and consumer contract versions agree                                                                                                                                                                              | Handoff §7                  |
| The unwind boundary and the stretch that cannot be reversed                                                                                                                                                                | Handoff §8                  |
| An irreversible effect has a policy floor at the Gate immediately before it                                                                                                                                                | Handoff §8                  |
| Every escalation chain has a terminal handler                                                                                                                                                                              | Escalation §3               |
| Every referenced Role has an available Filler pool                                                                                                                                                                         | Role §3                     |
| No infinite cycle, no unbounded spawn                                                                                                                                                                                      | Task §5                     |
| A Trigger has auth and correlation, for conversational types                                                                                                                                                               | Trigger & Channel §2        |
| Referenced collections lie within the Role's grant, and the knowledge module is enabled                                                                                                                                    | Knowledge §2                |
| No external effect consumes knowledge above the classification floor                                                                                                                                                       | Knowledge §3                |
| The sync-response path is time-bounded: no `awaiting`, budget fully declared, spawn capped                                                                                                                                 | Trigger & Channel §2        |
| A Lease's critical section contains no `awaiting`; a chain acquiring several leases is warned about                                                                                                                        | Working Data §3             |
| A DataTable query touches only tables within the Role's grant; an aggregate over a secret table has a leakage gate before egress                                                                                           | Working Data §1             |
| A major migration declares a downward path **or** the flag `irreversible_migration`                                                                                                                                        | North Star §8               |
| A contract declaring `test_behavior: dry_run` against an adapter that does not declare `supports_dry_run` → **a design error**, caught while drawing rather than at run time, where it would merely resolve to `forbidden` | Handoff §3, Test Harness §5 |
| A contract with an effect **leaving the system** that declares no `test_behavior` → **a warning**, not a rejection, because the default is already fail-closed                                                             | Handoff §3                  |

## 5. Pair-design is an ecoma workflow

Designing and editing a process **is itself a process** running on the engine:

| Role in the design workflow | Typical filler | Work                                                                                                      |
| --------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| Drafter                     | AI             | Generate or edit a definition from a natural-language description, or from an Intelligence-layer proposal |
| Validator                   | Rule           | Run the static analysis of §4 — a hard gate                                                               |
| Reviewer                    | Person         | Review on the canvas and edit directly, which is approve-with-edit and produces a derived definition      |

Because a definition is an Artifact with a Gate, **every process change carries a
Judgment, provenance, and is learnable**. The Intelligence layer can observe the
process about processes: which AI-proposed edits people keep rewriting, which
kinds of description produce definitions that pass.

People and AI swap here too — an AI reviewing a definition a person drew —
symmetry extending all the way into the design layer. This is where the
pair-design product decision has its mechanism, and it needs no system of its
own.

## 6. The external-runtime boundary — Ecoma RPA is the first instance

Every external runtime — Ecoma RPA, an external agent, another automation engine
— plugs into the platform through exactly **two standard interfaces**. There is
no private shortcut for any product, including one in the same monorepo. Learning
signals and proposals travel **inside** the Session effect stream as typed
entries; no third channel exists.

|                           | Ecoma Platform                                              | Ecoma RPA                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain                    | Coordinating labour: five primitives, composition, surfaces | Executing interaction with an environment: browser and desktop automation, computer use, drivers                                                                                        |
| Relationship              | **Uses** Ecoma RPA as a source of Fillers                   | **Plugs into** the platform; an independent product, usable on its own                                                                                                                  |
| Plug interface — only two |                                                             | (1) **Filler interface** (Role §3): identity with lineage, availability, capacity, cost. (2) **Session effect** (Handoff §8): the action stream, reversibility per action, commit point |

The platform **knows nothing** about selectors, vision models or drivers — all of
that is RPA's domain. RPA **knows nothing** about Gates, calibration or
escalation — it receives a task and emits an effect stream.

The consequence that matters: this boundary **proves the plug-in mechanism is
general**. An external agent, an n8n node, any runtime at all plugs in through
those same two interfaces. Ecoma RPA is merely the first customer, and the test
of the interface it is built against.

## 7. Non-goals

- Composition adds no new runtime concept. Everything here is a way of using the
  five primitives.
- There is no "process engine" separate from a "task engine". One engine; a
  definition is an artifact being interpreted.

## 8. Decisions

| Question                            | Settled                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| What a process is                   | An Artifact under the `process-definition` contract — not a sixth primitive                               |
| The definition changes mid-instance | Pinned at launch; migration is an explicit Task with a Gate                                               |
| Minimal defaults                    | A five-level default cascade, snapshotted into the instance                                               |
| Pair-design                         | An ecoma workflow: Drafter (AI), Validator (rule), Reviewer (person) — interchangeable                    |
| RPA                                 | A separate product in its own domain, plugged in through exactly the Filler and Session effect interfaces |

## Litmus

1. Does static analysis catch every row of §4's table on a deliberately broken
   sample definition?
2. Change a definition while three instances are running — do all three stay on
   their pinned version, with migration as an explicit task?
3. Does an artifact produced by pair-design conform to the `process-definition`
   contract and pass exactly the same static analysis as a hand-written one?
