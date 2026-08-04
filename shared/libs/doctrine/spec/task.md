---
title: "Primitive: Task"
status: design-end-state
---

# Primitive: Task

## 1. Definition

A Task is **one instance of work assigned to a Role**: it consumes incoming
artifacts through a Handoff, produces outgoing artifacts against a Contract,
passes a Gate (Checkpoint), and declares its Effects (Handoff §8).

## 2. Structure

| Field                         | Content                                                                                                                                                                                           | Required                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `role`                        | The Role that carries it                                                                                                                                                                          | ✅                                      |
| `inputs` / `output_contract`  | Incoming Handoff and outgoing Contract, version-pinned                                                                                                                                            | ✅                                      |
| `gate`                        | The Checkpoint's Gate                                                                                                                                                                             | ✅ — at minimum auto-pass, still logged |
| `effects`                     | External effects with their reversibility class and compensation                                                                                                                                  | ✅ — may be empty                       |
| `budget` / `sla` / `priority` | The engine forces these to exist; values resolve through the **default cascade** `tenant → template → process → role → task` (Composition §3), so a twenty-step flow is not declared twenty times | ✅                                      |
| `idempotency_key`             | For safe retry of a task with effects                                                                                                                                                             | ✅ when effects are non-empty           |
| `spawn_policy`                | The right to create subtasks, and its limits (§5)                                                                                                                                                 | ✅ — default: forbidden                 |

## 3. Lifecycle — durable in every state

```
created → assigned(filler) → in_progress → produced → gated → done
        ↘ suspended ⇄ (resume)          ↘ failed → on_fail (Checkpoint §5)
```

Every state survives a restart, a deploy, a week. A human task sitting for a
fortnight is normal rather than exceptional, and the state lives in the engine
rather than in someone's head — which is the condition that makes the n=1 case
work at all.

`assigned` records the **full filler identity**, because provenance and
calibration both need it.

Cancelling from any state triggers the unwind in Handoff §8 if effects have
already run.

## 4. Attempt — a first-class entity

Each execution is an **Attempt**: filler identity, feedback received, artifact
produced, judgment, cost, duration.

A retry (Checkpoint `on_fail`) is a new Attempt **carrying the structured
feedback of the previous one**. Blind retry is excluded by the mechanism rather
than discouraged by convention — there is no shape for it.

A reroute is a new Attempt with a different Filler or Role under the same task
id. The history "AI tried twice and failed, a person succeeded" therefore stays
inside one Task, which makes it the most valuable comparison label calibration
has.

**The identity recorded is the one that ran, not the one that was asked for.** A
filler identity can name something a third party resolves — a hosted model behind
a floating name, an external runtime behind an adapter — and what is served under
that name can change without anyone here declaring it. An Attempt therefore
records the identity **actually served** beside the one requested, with whatever
evidence of it the adapter can obtain; where the two cannot be told apart, that
absence is itself recorded rather than passed over in silence. This is Knowledge
§4's compensation applied to labour: something that resolves live stays
reproducible because the version _actually consumed_ sits in provenance, and an
entry asserting a version nobody can check is a claim the log does not keep. It
is a record and not a permission — nothing here admits an unverifiable identity
to a gate it would otherwise fail, and the behavioural half is already settled
elsewhere: an adapter whose resolution changes behaviour changes `config_hash`
(Role §3, Checkpoint §8).

Every Attempt is part of the final artifact's provenance.

## 5. Dynamic spawning — where deterministic and reasoning meet

This is the most consequential architectural decision in this specification.

A **deterministic process** is a task graph **declared in full up front**, the way
a conventional workflow engine works.

A **reasoning process** is a Filler — agent or person — holding the `spawn_task`
capability, **creating subtasks at runtime**: decomposing the work itself,
choosing its own branch. That is the un-predeclared branching BPMN has no way to
express.

A subtask is **a real Task**: its own Role, Gate, Handoff and budget. It is not
an invisible tool call inside an agent's head. The consequence is the point — an
agent's reasoning becomes **visible, checkable and escalatable** by exactly the
machinery already checking everything else, rather than by a second observability
story built for agents.

**Rails** (principle #4 — complexity is the user's choice): `spawn_policy`
declares the Roles that may be assigned, the maximum depth, the cumulative budget
ceiling, and the permitted effects — by default a subtask may hold no irreversible
effect unless explicitly allowed. The engine forces the policy to exist; a
template supplies values anywhere from strict to open.

**The boundary between behaviour inside a filler and a Task** closes the tool-call
hole. An internal step of an agent filler — calling a tool, retrieving, reasoning
across several turns — is **behaviour inside the filler**, recorded as a
**sub-actor** in provenance, exactly as a script-to-agent-to-person handover is on
the RPA side (RPA North Star §5). It is **not** a Task. Two hard boundaries are
not negotiable:

1. **Every effect on the outside world is a declared Effect of a Task** (Handoff
   §8). No side effect slips through as a tool call, and an unclassified effect
   is irreversible.
2. **Every piece of labour needing its own Role, Gate or calibration must be a
   Task** (`spawn_task`). Labour may not be hidden inside a filler to dodge a
   Gate.

A read-only tool may reach only the knowledge and memory within the Role's grant
(Knowledge §2, Memory §4). It follows that an external tool protocol — MCP and
its equivalents — is **technology of the agent runtime, an adapter with an
identity and a version**, and not a third interface of the system.

The result is a flow that mixes without a seam: steps 1–3 static, step 4 an agent
spawning seven subtasks — two of them assigned to people — step 5 static again.
One event log, one observability mechanism, no system boundary between the two
"modes". An agent spawning a subtask assigned to a person is **AI coordinating
human labour**, which is what full symmetry buys and what no system on the market
currently has.

## 6. Duality

An RPA task is not a separate kind of task: it is an ordinary Task whose filler
comes from Ecoma RPA, carrying a **session effect** (Handoff §8) — the action log
is its provenance, and the commit point is counted in actions.

| Aspect  | Deterministic                        | Reasoning / human                        |
| ------- | ------------------------------------ | ---------------------------------------- |
| Graph   | 100% declared up front               | Grown at runtime inside rails            |
| Retry   | Idempotency key, mechanical          | Attempt plus feedback                    |
| Gate    | Usually auto-pass plus a log         | Full, according to calibration           |
| Surface | Invisible, running in the background | Inbox for a person, runtime for an agent |

## 7. Non-goals

- A Task does not define competence (Role), does not define a contract (Handoff),
  and does not assess quality (Checkpoint).
- There is no such thing as work outside the flow. Everything the system knows
  about is a Task, including its own operational work — coercion, merge, distill,
  arbitrate, compensate, migrate.

## 8. Decisions

| Question                   | Settled                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry semantics            | Attempt is a first-class entity; a retry always carries feedback                                                                               |
| Deterministic vs reasoning | One mechanism: a graph declared up front, or grown at runtime via `spawn_task` inside rails                                                    |
| An agent's subtask         | A real, checkable Task — not an invisible tool call                                                                                            |
| AI coordinating people     | Valid by construction, out of symmetry: an agent spawns a task whose Role a person fills                                                       |
| An agent's tool call       | Behaviour inside the filler (sub-actor), **not** a Task — but every outward effect is still a declared Effect; the tool protocol is an adapter |
| Idempotency                | Mandatory wherever there are effects                                                                                                           |
| State                      | Durable in every state; suspended for weeks is first-class                                                                                     |

## Litmus

1. Does Attempt N+1 always see Attempt N's feedback?
2. When dynamic spawning hits the budget or depth ceiling, does it stop and
   escalate rather than fail silently?
3. Re-running a task with an external effect — does the idempotency key prevent a
   doubled effect?
4. Is there any path by which an agent's internal tool call produces an outward
   effect the Task did not declare, or touches data outside the Role's grant?
