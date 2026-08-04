---
title: "Primitive: Role"
status: design-end-state
---

# Primitive: Role

## 1. Definition

A Role is **a capability contract for one position of labour**, independent of
who or what currently occupies it. The separation is foundational:

|                   | Role (the position)                                           | Filler (the occupant)       |
| ----------------- | ------------------------------------------------------------- | --------------------------- |
| What it is        | A slot: what work, judged by which criteria, with what rights | Person / agent / rule       |
| Identity          | Id and version                                                | Its own identity (§3)       |
| Changing it means | Editing the process                                           | **Not editing the process** |

This is the mechanism behind the first litmus of the whole system: _moving a step
from a person to an AI is not a process edit_ — because the process only ever
knew the Role.

## 2. What a Role declares

| Field               | Content                                                                                                                                               | Required          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `io_contracts`      | References to Contracts (Handoff) for input and output — which contracts this Role speaks                                                             | ✅                |
| `held_criteria`     | References to the Criteria (Checkpoint) this Role's output is judged against                                                                          | ✅                |
| `capabilities`      | First-class rights: `judge`, `contract_author`, `process_author`, `role_author`, `arbiter`, `spawn_task`, `override_gate`, … — an open taxonomy       | ✅ — may be empty |
| `assignment_policy` | How a Filler is chosen when there are several: `static` / `queue` / `router:<role>` — routing is itself a Task of some Role — or a pluggable strategy | ✅                |
| `escalation_chain`  | The path taken on deviation — see Escalation                                                                                                          | ✅                |
| `graduation_policy` | The conditions for promoting or demoting a Filler's trust tier (§5); thresholds resolve through the default cascade (Composition §3)                  | ✅                |
| `constraints`       | Cost ceiling, latency, operating hours                                                                                                                | ⬜                |

**There are no system Roles.** Arbiter, Distiller, Merger, Adapter, Coercer and
Router — all of which appear in Checkpoint and Handoff — are ordinary Roles with
the appropriate contracts. The engine has no privileged node: all labour,
including the system's own operational labour, travels the same mechanism. A
privileged node would be a place where the audit story quietly stops.

## 3. Filler

| Kind      | Identity (the calibration key)                                           | Availability                                       | Cost                        |
| --------- | ------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------- |
| Person    | User id                                                                  | Working hours, capacity, leave — **self-declared** | Salary per hour or per task |
| Agent     | `(model, version, config_hash)` — the same shape a verifier identity has | Rate limit, concurrency                            | Tokens / compute            |
| Rule/code | `(code, version)`                                                        | Always available, dependencies aside               | ~0                          |

The engine is strictly symmetric: all three declare the same schema — identity,
availability, capacity, cost function. There is no `if human` branch anywhere.

**Availability may carry a horizon, and absent one `unavailable` means _now_, not
_until_.** Leave already puts dates on the person row, and the same field answers
the case that reads as permanent from the inside: capacity behind an agent filler
exhausted by a ceiling somebody else resets on their own clock. The horizon
travels with the `unavailable` escalation (Escalation §2) so a handler can see
what it is waiting for. It **annotates and never suspends** — it does not defer
the terminal handler, does not extend an SLA by itself, and does not hold work
that could run sooner, because capacity returning early is taken early. A horizon
that parked work until a date would be the timeout-shaped hold invariant 5 exists
to forbid, arriving through a field instead of through a timer.

**An identity a third party resolves is declared as such.** Where a filler names
something resolved elsewhere — a hosted model behind a floating name — an adapter
that resolves it into different behaviour must reflect that in `config_hash`,
which is Checkpoint §8's settled model-drift rule read from this side rather than
a new one. What the adapter cannot do is vouch for what it did not see: the
identity **actually served** is recorded in the Attempt (Task §4), and where it
cannot be told from the one requested, the record says so. Trust tiers read
calibration, never a declaration — a ceiling on how far such a filler may
graduate is a `graduation_policy` value a template supplies (§5), never an engine
rule, because an engine that treated one filler kind differently on a declared
property would be the asymmetry principle #1 forbids.

**Identity lineage** stops the flywheel resetting. A new agent identity — changed
prompt, config or model — declares a `parent_identity`, and its calibration
profile **inherits from the parent with a decay factor** (a class-C parameter,
valued by template). The standard evolution of a filler is: new config → shadow
(§4) → graduation replacing the parent. Without lineage, every prompt
optimisation by the Intelligence layer would burn the calibration it depends on —
a fatal contradiction with per-tenant learning.

**Fillers from outside products.** Ecoma RPA, a separate product in its own
domain, and any external runtime register fillers through this same schema; their
actions on an environment travel as a **Session effect** (Handoff §8). The
platform knows nothing about the technology inside a filler — only identity,
availability, cost, and the effect stream.

**A fourth kind of filler: `process`.** A Role can be filled by a Process
definition@version. A task assigned to that Role spawns a child instance, and its
output is that instance's final artifact. Sub-process invocation needs no concept
of its own; calibration over a process-filler measures the quality of **an entire
sub-process**, and shadow at process level — two competing processes chosen by
outcome — falls out of the existing shadow mechanism for free.

**A calibration profile** accumulates per `(role, filler_identity, task_type,
criterion)`, sourced from the whole Judgment system. It is what answers _one
confidence scale for humans and AI alike_, and _cost and quality per Role
regardless of who fills it_.

**`environment: production | test`** is a dimension of Filler identity,
**independent of trust tier**. A filler with `environment: test` — a mock filler,
Test Harness §3 — **is not eligible for a production task**, whatever its tier.
Confidence and environment are two axes; folding them into one tier enum would
create a second source of truth for the tier taxonomy and make §5's table say two
different things.

A Role has a **pool** of Fillers; a Filler can fill several Roles.

## 4. Shadow mode

A Role can carry a **shadow filler**, running alongside the primary on the same
task. The shadow's output **does not flow into the process**; it produces an
Artifact and is judged by the same Gate criteria.

The engine generates the **primary-versus-shadow comparison** by criterion, cost
and latency from Judgment data. No external tooling is required, which is what
makes the comparison always available rather than something someone has to build.

Judgments on shadow output carry `shadow: true` in their provenance, feeding the
shadow filler's calibration at no risk to production.

It is symmetric: a person shadowing an AI is equally valid — training a new hire
by running the real process in shadow.

## 5. Trust tiers and graduation — the mechanism of a shifting workforce

| Tier         | Where output goes                       | Condition to rise                                     |
| ------------ | --------------------------------------- | ----------------------------------------------------- |
| `shadow`     | Not into the flow; learning only        | Calibration reaches the threshold against the primary |
| `gated`      | Into the flow, 100% reviewed            | Approval rate ≥ X over ≥ N samples                    |
| `sampled`    | Auto-pass plus sampling (Checkpoint §4) | Reject rate within the sample ≤ Y                     |
| `autonomous` | Auto-pass, minimal sampling             |                                                       |

Promotion and demotion are **automatic under `graduation_policy`** — the engine
forces the policy to exist, a template supplies thresholds, and a user may
override them (principles #3 and #4).

Demotion is immediate when calibration falls, which is the same self-tightening
mechanism Checkpoint §4 describes.

A tier attaches to `(filler, role, task_type)`: an agent that is autonomous at one
kind of work is still gated at another.

This is **the core product story**. The journey from human to AI is not a decision
taken once; it is a lift with a meter on it, running in both directions, per kind
of work.

## 6. Duality

| Aspect       | Rule/code                                                                                                                                                                                      | Agent / person                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Graduation   | The same policy and the same scale — but binary calibration converges after very few samples, so it reaches autonomous quickly. **A natural consequence of the data, not an engine privilege** | Distributional calibration, needing more samples |
| Availability | Constant                                                                                                                                                                                       | Variable, self-declared                          |
| Calibration  | Binary, fast-converging                                                                                                                                                                        | Distributional, sample-hungry                    |

## 7. Non-goals

- A Role holds no execution logic — that belongs to the Filler — and no work
  state — that belongs to the Task.
- There is no Role inheritance hierarchy. Composition happens through
  capabilities and contracts, not through an inheritance tree.

## 8. Decisions

| Question                | Settled                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slot vs occupant        | Role and Filler are separate; the process only knows the Role                                                                                         |
| System Roles            | None exist — Arbiter, Distiller and the rest are ordinary Roles                                                                                       |
| Capability              | Attached to the Role and inherited by whoever fills it; an open taxonomy                                                                              |
| One confidence scale    | A calibration profile per (role, filler, task_type, criterion), sourced only from the Judgment system                                                 |
| **Environment vs tier** | `environment` is a dimension of identity, **not** a fifth tier — §5 keeps exactly four, and a mock filler is barred from production by this dimension |
| Shadow                  | A first-class mechanism, symmetric in both directions: AI shadowing a person, a person shadowing AI                                                   |
| Graduation              | Four tiers, automatic in both directions under a declared policy                                                                                      |

## Litmus

1. A Role filled in turn by all four kinds of filler — person, agent, rule,
   process — does its definition change by a single character?
2. Does the graduation policy promote and demote a filler automatically from
   calibration, with every tier change emitted as an event?
3. Does `distinct_filler_from` block a filler from judging its own output on
   every path, including through two roles?
