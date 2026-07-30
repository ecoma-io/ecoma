---
title: "Human Surface — Work Surface"
status: design-end-state
---

# Human Surface — Work Surface

## 0. Position

The entire surface is **a projection of the Event Log** — no new store, no new
mechanism. This specification only names the projections and the actions.

Every action on the surface goes through **the same engine API** as any other
client. There is no private write path for the UI, which is what keeps the
surface from becoming a second way for state to change.

Reading happens through the **projection read-API, which is ◆G4** (roadmap §1b):
freezing that API is the gate that opens Track E.

## 1. Object model — two concepts, one source

| Concept         | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Projected from                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Work Item**   | A _piece of work_ in the organisation: a projection of a **Task** — a launched process instance is the root work item, with a subtree per Composition. It carries title, `process@version`, the party or client involved, state from the Task states, **who is holding it** (the filler holding the current attempt or gate), progress (subtasks done against total), SLA and deadline from the Escalation timers, and blocked-by (a waiting gate, a lease, an escalation, a conflict) | Task, Attempt, Composition, Escalation |
| **Action Item** | A _thing that needs ME_: a gate awaiting my approval, a task I can claim, an escalation addressed to me, an assistance request, a conflict needing an arbiter, a takeover being offered (attended RPA)                                                                                                                                                                                                                                                                                 | Checkpoint, Escalation, Lease, Session |

The relational rule: **every Action Item points at exactly one Work Item for
context**. It is never a loose fragment of work — approving is always approving
in context, because approval without context is the failure mode the whole
Checkpoint primitive is trying to avoid.

## 2. Two standard views — the same data, different projections

| View         | For whom           | Content                                                                                                                                                                      | Note                                                          |
| ------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **My Work**  | Every human filler | My Action Items, ordered by SLA and priority — _the ordering algorithm is template policy, the engine only forces the field to exist_ — what I am holding, and what I watch  | Formerly "the inbox"                                          |
| **Org Work** | Scoped by RBAC     | The **tree of Work Items** for a workspace or tenant: grouped by process, client or state; an SLA heat map; who is holding what; drill-down to attempts, diffs and live view | A manager's "what needs my decision" is Org Work ∩ My Actions |

**Visibility is an RBAC capability within a scope** (Tenant & Identity): without
the capability in a scope, a person does not see that scope's Work Items — **not
even the total count**, because a count is information too. A person's
calibration figures are a separate layer (`view_calibration`, enterprise —
Tenant §8).

**At n=1**, a solo operator sees My Work and a collapsed Org Work converge, so
nobody has to learn a concept they do not need.

## 3. Actions — each one an entry

| Action                                   | Source mechanism                                                                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claim / release                          | Lease with a TTL (Working Data §3)                                                                                                                                                                                                             |
| **Approve / Reject / Approve-with-edit** | Judgment (Checkpoint §3); the edit diff is the gold-standard data feeding calibration                                                                                                                                                          |
| Request assistance ("I am not sure")     | Escalation §2 — it **adds** to calibration, so the surface must make this button _easier_ than guessing                                                                                                                                        |
| Escalate / reassign                      | Escalation and capability                                                                                                                                                                                                                      |
| Takeover (attended)                      | Session effect — the diff after a takeover is an approve-with-edit                                                                                                                                                                             |
| Comment                                  | A Judgment with basis `comment`, weight 0                                                                                                                                                                                                      |
| Watch / unwatch                          | **A `watch_changed` entry**: it decides **who receives which notification**, so it has a labour consequence and must answer "why was X told about this". The entry taxonomy is open (Event Log §1); the current watch list is a **projection** |

**Diff view**: every artifact has a before and after with an extractable
provenance chain. The live view of an RPA session is a **clean Scene
projection**, never raw video.

## 4. Mobile and notification

Mobile is **the same mechanism with a reduced view** — enough for My Actions,
diffs, and approve/reject/assist. No separate mechanism and no separate
application logic, because a second implementation is a second set of rules to
keep true.

Notifications go through a **Channel adapter** (Trigger & Channel). A
notification is **a pointer** to an Action Item and does not carry content
subject to classification: nothing secret ever appears in push text.

## 5. Realtime and staleness

The surface subscribes to updates by **log position**, reading an eventually
consistent projection. Display may lag; **an action never takes a shortcut**. It
always goes through the engine API, and the engine is the final arbiter — a stale
view plus a plausible action means the engine refuses on a precondition and the
surface shows why.

## 6. Non-goals

- No screen or pixel design here — that belongs to the design system and Track E.
- **No server-side UI store, with no exception.** No cache is a source of truth.
  What has a labour consequence — watching — is **an entry**; what does not —
  column order, widths, theme, a saved filter only its owner sees — lives
  **client-side**. The reasoning cuts both ways: pushing _every_ preference into
  an entry is write amplification against the source of truth for something with
  no labour value, while keeping _one_ server store outside the log is a second
  source of truth. Cutting on _labour consequence_ is the only line that breaks
  neither rule.
- No "chat with the AI" as the primary surface — that is a Channel, the surface
  of _the party being served_ rather than of _the worker_.
- No free-form drag-and-drop project management. A Work Item **is born from a
  process**; "create a task by hand" is the existing `manual` trigger, and there
  is no path that creates work outside the mechanism.

## 7. Decisions

| Question                        | Settled                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The surface model               | **Work-management first**: one object model (Work Item plus Action Item) and two standard views (My Work, Org Work). The inbox is one view, not the foundational concept |
| Why this is not a new mechanism | Every field of a Work Item already exists in Task, Attempt, Escalation and Lease. This document names projections                                                        |
| The buyer's surface             | Org Work is the **buyer's** surface — an agency owner; My Work is the worker's                                                                                           |
| Competitive difference          | Workflow tools show a technical executions list; project tools have no AI workforce and no Gate. That gap is the position                                                |
| ◆G4                             | The freeze of this document's projection read-API                                                                                                                        |
| **Preferences**                 | Cut by **labour consequence**: watching is an entry because it routes notifications; pure display is client-side. No server-side UI store exists                         |

## Litmus

1. Delete every cache and database behind the surface — can all Work and Action
   Items be rebuilt equivalently from the log?
2. Does any action on the surface create **exactly the entry** the bare API would
   — with no private write path anywhere?
3. Can a manager answer "where is client X's work, what is it stuck on, who is
   holding it" from Org Work alone, without opening the raw log?
4. Opening My Work: are items ordered by SLA, does each have one clear primary
   action, and does approve-with-edit produce a Judgment carrying the diff?
5. Someone without the capability in a scope: do they see none of that scope's
   Work Items, not even a count?
