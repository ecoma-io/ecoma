---
title: "Primitive: Escalation"
status: design-end-state
---

# Primitive: Escalation

> Bound by the four mechanism principles (canonical: North Star §3). Escalation
> is a **first-class citizen**. What BPMN treats as an exception path is here the
> default that must be declared, because in a system of humans and AI together,
> deviation is the normal condition: a person is away, an agent is stuck,
> confidence drops, an SLA breaks.

## 1. Definition

An Escalation is **a path declared in advance for every way things can deviate**.
The ground rule is that the engine forces every Role, Gate and Task to carry an
escalation chain with a **mandatory terminal handler**, so that nowhere in the
system does the state "silently stuck, indefinitely" exist.

That is a statement about the shape of the system rather than about diligence. A
chain with no bottom does not announce itself; work simply stops being finished,
and nobody is told.

## 2. Trigger taxonomy — open, so a new trigger needs no engine change

| Trigger               | Emitted by                                                                                                             | Defined in             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `sla_breach`          | A Task or Gate past its deadline, including `awaiting_review`                                                          | Checkpoint §6          |
| `unavailable`         | No Filler in the pool is available                                                                                     | Role §3                |
| `low_confidence`      | Calibrated confidence below T_low after retry                                                                          | Checkpoint §4          |
| `repeated_failure`    | N attempts exhausted                                                                                                   | Task §4                |
| `budget_exceeded`     | The fallback chain or the cost ceiling ran out                                                                         | Checkpoint, Task       |
| `conflict`            | Contradicting Judgments, or an N-bounce                                                                                | Checkpoint, Handoff §4 |
| `irreversible_guard`  | A Gate ahead of an irreversible effect did not meet its floor                                                          | Handoff §8             |
| `assistance_request`  | **A Filler raising its own hand**                                                                                      | §3                     |
| `unwind_blocked`      | A compensation cannot run                                                                                              | Handoff §8             |
| `session_interrupted` | A Session effect broke off mid-run — the engine knows exactly which action ran and whether the commit point was passed | Handoff §8             |

**`assistance_request` is the philosophically load-bearing one.** An agent does
not naturally report being stuck, so the mechanism has to make asking for help a
first-class action, cheap, and **rewarded in calibration** — an agent that raises
its hand at the right moment earns a better profile than one that guesses. A
person raising their hand travels the identical path; the symmetry is the point.
This is the direct treatment for the verification bottleneck at n=1: the system
surfaces what needs attention instead of requiring a person to go looking.

## 3. An escalation is a Task

Each escalation creates **a real Task** assigned to a handler, and the handler is
a **Role** — a person or an AI supervisor, symmetrically. An AI handling the
first escalation tier and filtering before anything reaches a person is the
default template pattern.

Because it is a Task, it has its own Gate, SLA, budget and provenance for free,
and **the chain cascades by itself**: an escalation task that runs past its
deadline escalates to the next rung. No separate mechanism is needed, which is
the whole reason for making it a Task rather than a notification.

The chain is declared on the Role and can be overridden at Task or Gate. The
engine forces a terminal handler to exist. At n=1 the terminal is that same
person, with the policy `nudge → hold` as the template default: remind on a
rhythm, change nothing. Consistent with Checkpoint — **never auto-pass because of
a deadlock**, least of all ahead of an irreversible effect.

## 4. What a handler can do, and how each is recorded

| Action                | How it is recorded                                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reassign`            | A new Attempt, with a different Filler or Role (Task §4)                                                                                                                                                        |
| `retry_with_guidance` | A new Attempt plus the handler's feedback                                                                                                                                                                       |
| `adjust`              | Change a parameter — deadline, budget, threshold — into the event log                                                                                                                                           |
| `override_gate`       | Pass a blocking Gate. **Must produce a Judgment with `basis: override`** and a reason: the person overriding takes responsibility with a signature in data, and calibration learns the quality of overrides too |
| `absorb`              | Accept the risk and close the escalation with a reason — an audit trail                                                                                                                                         |
| `halt_compensate`     | Trigger the unwind (Handoff §8)                                                                                                                                                                                 |
| `restructure`         | A handler holding `spawn_task` creates new tasks to replace the broken stretch — repairing a running process with the spawning mechanism the system already has                                                 |

Which of these a handler may use is a capability of their Role. `override_gate`
is a capability of its own and is never granted by default.

## 5. Storm control

**Dedup**: while an escalation for the same (trigger, source) is open, no
duplicate is created; a counter increments.

**Correlation**: the engine merges escalations sharing a root cause. One model
outage failing fifty tasks produces **one** escalation, not fifty. The merge
window is a parameter the engine forces to exist and a template supplies.

**Attention priority**: the queue reaching a person is ordered by the
irreversibility of the branch, priority and age. Attention is the resource being
optimised, which is the invariant rather than a nicety.

## 6. Escalation is training data

Every closed escalation records its trigger, path, closing action, duration and
outcome. That record is the **process-smell detector** of the Intelligence layer:
escalating repeatedly at the same point means the process has a design fault, and
this is where the proposal to fix it comes from.

An override followed by a bad outcome propagates backwards (Handoff §9), so the
calibration of someone who overrides carelessly falls too. Responsibility is
symmetric all the way through — including for the people holding the authority.

## 7. Duality

| Aspect             | Deterministic                                  | Reasoning / human                                                |
| ------------------ | ---------------------------------------------- | ---------------------------------------------------------------- |
| Dominant triggers  | `budget`, `repeated_failure`, `unwind_blocked` | `low_confidence`, `assistance_request`, `conflict`, `sla_breach` |
| First-tier handler | Mechanical retry and fallback                  | An AI supervisor filtering ahead of a person                     |
| Absorb / override  | Rare — a failure is a failure                  | Common, and always carrying a Judgment signature                 |

## 8. Non-goals

- Escalation does not assess quality (Checkpoint) and does not define who is
  competent to handle something (Role). It defines only _the path taken when
  things deviate_.
- There is no separate notification system. A notification is a surface rendering
  of an escalation task — a parallel system would be a second place for the state
  of an escalation to live.

## 9. Decisions

| Question                          | Settled                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| What it is                        | A Task assigned to a handler Role, so the chain cascades and human/AI stay symmetric             |
| Silent deadlock                   | Does not exist: a terminal handler is mandatory system-wide                                      |
| n=1, offline                      | `nudge → hold`; never auto-pass because of a deadlock                                            |
| A stuck agent                     | `assistance_request` is first-class and rewarded in calibration                                  |
| Override                          | Must produce a Judgment with `basis: override` — responsibility in data, outcome propagates back |
| Storms                            | Dedup plus correlation by root cause, plus an attention-priority queue                           |
| ML proposing process improvements | The escalation log is the primary data source — the process smell                                |

## Litmus

1. A storm of fifty tasks from one cause — does the correlation window yield
   exactly one escalation?
2. Does every chain have a terminal handler, with no empty bottom in any
   configuration?
3. Is an override always a signed Judgment, and does it appear in calibration?
