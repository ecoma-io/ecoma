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

## 6. Interface consequences of mechanism

Pixels belong to the design system. **These do not** — each one is forced by a
mechanism declared elsewhere in this corpus, and a surface that breaks one
contradicts a promise the product makes rather than a preference someone holds.
The distinction matters because the two fail differently: a visual mistake is
visible to anyone who looks, while a surface that quietly contradicts a
mechanism still renders, still passes review, and looks correct to everyone who
has not read the specification it violates.

**Every row names the mechanism it derives from, and that is the point.** A
principle whose source is named can be re-derived, checked and argued with. One
stated on its own authority is taste in a rule's tone of voice, and it drifts
the first time someone has a good-looking reason to override it.

| A surface must not…                                  | Because the mechanism says                                                                                                                                                     | Derived from       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| present a Judgment as editable                       | a Judgment is append-only and attached to the output permanently; a correction is **a new Judgment** with basis `re_review`, and a later one **does not reopen a closed Gate** | Checkpoint §1, §3  |
| let an escalation leave the view unhandled           | a terminal handler is mandatory precisely so no path ends in silence; dismissal is an action that **produces an entry**, never scrolling past, collapsing or ageing out        | Escalation §1, §4  |
| render a confidence level as a bare number           | the figure that decides a Gate is written as **(the cells read, the estimator identity)**, and the tenant is a hard boundary — so it is not comparable across tenants          | Calibration §1, §5 |
| decide for itself whether a review is blind          | `blind` is **a template value per stage, not engine law** — sampling defaults blind to stop anchoring, quick review defaults sighted. The surface reads the flag               | Checkpoint §2      |
| offer an action the mechanism will refuse            | `distinct_filler_from` means the filler that produced an output cannot approve it. Rendering the button and failing the write teaches that the action exists                   | Checkpoint §2      |
| change anything not in §3's table without an entry   | there is **no private write path for the UI**; what has a labour consequence is an entry, and what does not is client-side preference                                          | §0, §3, §7         |
| blend test-run data into a production view           | production tables **do not see** a test run's writes — the projection is split by label, so a surface that merges them shows a number nobody can act on                        | Event Log §3       |
| show an item as stuck without showing what blocks it | a Work Item carries **blocked-by** — a waiting gate, a lease, an escalation, a conflict. "Stuck for no stated reason" is Escalation's silence, reappearing at the surface      | §1, Escalation §1  |

This list is open in the same way the escalation taxonomy is: a new mechanism
with a surface consequence adds a row here rather than growing a second home.
What it is **not** is a place for a rule whose only backing is that it looks
better — such a rule has no derivation to write in the third column, and that
empty column is the test.

## 7. Non-goals

- No screen or pixel design here — that belongs to the design system and Track E.
  **The principles in §6 are not the same thing** and do not travel with pixels
  out of scope: they are consequences of mechanism, and this is their home.
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

## 8. Decisions

| Question                                      | Settled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The surface model                             | **Work-management first**: one object model (Work Item plus Action Item) and two standard views (My Work, Org Work). The inbox is one view, not the foundational concept                                                                                                                                                                                                                                                                                                                                        |
| Why this is not a new mechanism               | Every field of a Work Item already exists in Task, Attempt, Escalation and Lease. This document names projections                                                                                                                                                                                                                                                                                                                                                                                               |
| The buyer's surface                           | Org Work is the **buyer's** surface — an agency owner; My Work is the worker's                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Competitive difference                        | Workflow tools show a technical executions list; project tools have no AI workforce and no Gate. That gap is the position                                                                                                                                                                                                                                                                                                                                                                                       |
| ◆G4                                           | The freeze of this document's projection read-API                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Preferences**                               | Cut by **labour consequence**: watching is an entry because it routes notifications; pure display is client-side. No server-side UI store exists                                                                                                                                                                                                                                                                                                                                                                |
| **Who owns the derived interface principles** | **This document (§6), not the design system.** They are consequences of mechanism and belong beside the mechanism, each carrying the citation that lets it be re-derived. Putting them among visual conventions would make them read as preferences, and preferences get overridden for good-looking reasons. The design system keeps pixels and cites §6; a card in `practice-index.json` routes the rule to whoever is building a surface, since a reader in the view layer never opens this tree by accident |

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
6. Take any row of §6 and build the surface that breaks it — does anything fail?
   If the only thing standing between the product and that surface is a reviewer
   who happens to have read the mechanism specification, the principle is written
   but not held.
7. Pick a rule someone proposes for the surface: can the third column of §6 be
   filled in for it with a real citation? If not, it is a visual preference and
   belongs to the design system, whatever tone it is stated in.
