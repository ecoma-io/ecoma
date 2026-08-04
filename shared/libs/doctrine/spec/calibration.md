---
title: "Calibration Data Model"
status: design-end-state
---

# Calibration Data Model

## 0. Position, and the one-truth-one-home boundary

**Calibration is the ONLY home of labour assessment.** It pairs with the rule
forbidding memory about a filler (Memory §0): no other ledger may record "model X
gets it wrong a lot" or "A misses deadlines".

**No new store.** Every cell is **a projection of the Event Log** — Judgments,
outcomes, Conflicts, escalations — and can be rebuilt (Event Log §3).

Two concepts that used to be separate are two slices of one space: a _Filler's
calibration profile_ (Role §3) and a _verifier's layer C_ (Checkpoint §4). §1
unifies them.

## 1. CalKey and Cell

**CalKey** — the unified key, seven dimensions:

| Dimension           | Value                                                                                                                                                                                                  | Source                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tenant`            | A hard boundary — **never crossed**                                                                                                                                                                    | Invariant 4                                                                                                                         |
| `workspace_scope`   | A dimension that **must exist**; the default is the **narrowest workspace**, and a wider pool is a template value — an agency chooses for itself whether learning merges or splits per client          | Tenant & Identity §3                                                                                                                |
| `subject`           | **(kind, identity@version)**, with an open kind: `filler` · `verifier` · `driver` · `detector` (masking) · `chunk/collection` (knowledge) · `contract`                                                 | Unifying Role §3, Checkpoint §2, Driver §1, Sandbox §3, Knowledge §6 and Handoff §7 — one statistical engine, many kinds of subject |
| `role`              | The Role being filled; empty for a non-labour subject such as a chunk                                                                                                                                  | Role §3                                                                                                                             |
| `task_type`         | The kind of work                                                                                                                                                                                       | Role §3                                                                                                                             |
| `criterion@version` | **Calibration binds to the criterion id, not the rubric** — editing a rubric resets nothing, and a criterion shared across processes accumulates shared data, which is the first remedy for cold start | Checkpoint §1                                                                                                                       |
| `basis`             | Judgment's open taxonomy                                                                                                                                                                               | Checkpoint §3                                                                                                                       |

A **Cell** is the value at one CalKey: **sufficient statistics** — n, counts per
verdict bucket, moments, the log position last applied, decay state. It does not
hold the raw sequence, because the raw sequence _is_ the log.

Cells are **sparse**, existing only where there is data. That is the cost valve:
a seven-dimensional space is never materialised densely, so storage grows with
the number of real Judgments rather than with the product of the dimensions.

## 2. The only way in is the Judgment system

| Source                                                                                       | How it reaches a cell                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Judgments of any basis — contemporaneous, re_review, consumer bounce, override, comment      | Directly; `comment` carries weight 0 (Checkpoint §3)                                                                                                      |
| Outcome propagating back through provenance                                                  | To each contributing Role and Criterion; attribution weights are cascade parameters (Handoff §9)                                                          |
| Conflict                                                                                     | A disagreement label — the signal to fix a rubric, temporarily lowering confidence in the cells involved                                                  |
| `assistance_request`                                                                         | **Adds** to the score — raising a hand at the right moment beats guessing (Escalation §2)                                                                 |
| An override followed by a bad outcome                                                        | Lowers the overrider's calibration — symmetric responsibility (Escalation §6)                                                                             |
| A sampling rejection (self-tightening)                                                       | Into the cell, plus a reversible event lowering T_high (Checkpoint §4)                                                                                    |
| Shadow work (`shadow: true`)                                                                 | Feeds the shadow filler's cell at no risk to production (Role §4)                                                                                         |
| RPA: a takeover diff as approve-with-edit; patch approval outcomes; the winning locator tier | Through the Session effect into a Judgment. **Platform calibration binds to the registered filler**, with sub-actors for finer ML (RPA North Star §5, §7) |

**The hard rule**: there is no path to scoring that is not the creation of a
valid Judgment — under the `judge` capability, subject to `distinct_filler_from`.
Scoring a filler by hand means creating a signed Judgment, never editing a
number.

**The second hard boundary: a Judgment carrying `run_kind: test` NEVER enters a
cell.** The label is a property of the entry and its canonical home is Event Log
§1/§3; this document only declares its position — and that position is **absolute
exclusion, not configurable**. Cells are an organisational asset (§0), and
poisoning them with synthetic data from a mock filler (Test Harness §3) destroys
the flywheel **irreversibly**. That is why it is an engine law rather than a
template value.

## 3. Weight by basis — a parameter, never hardcoded

The engine forces the weight table to exist; **a template supplies the values**.
The default prior orders `outcome` highest, then `re_review`, `contemporaneous`,
`consumer`, then self-report; `comment` is 0; `degraded` multiplies by a
reducing factor.

The data model commits to **storing enough provenance** — blind, batch, degraded,
device — and what an estimator does with it is the estimator's business (§5).

## 4. Lineage, decay and freshness

**A fork inherits.** A new subject identity declaring `parent_identity` starts
from the parent's cell multiplied by `decay(d)`, where **d follows the nature of
the change** and a template supplies values: a small config change or a
locator-only patch is about zero (Self-healing §4); a minor contract change is
about zero and a major one is template-valued (Handoff §7); changing the model or
the behaviour decays heavily. The fork event is an entry, so the lineage graph is
traceable. **Without lineage, every optimisation burns the flywheel** (principle
#2).

**Time freshness.** Environments drift — the UI changes, a model provider drifts —
so the engine forces a half-life parameter over time or volume to exist, with a
template value defaulting to slow decay: old data loses weight rather than being
immortal. Without it, a score from two years ago decides an auto-pass today.

## 5. Prior, cold start, and estimator identity

A sparse or empty cell falls back to **the template's conservative prior** —
everything goes to review (Checkpoint §4). The three cold-start remedies all obey
invariant 4: shared criteria, lineage, and a template prior. **Nothing is ever
read across tenants**; a block or template ships a _prior definition_ and never
data (Block §9).

**Backoff and pooling between cells is ALGORITHM** — it belongs to the estimator,
not the data model. The data model imposes exactly one constraint: every
confidence number used to decide a Gate or a graduation is written into an event
as **`(the cell keys read, the estimator identity)`**.

**An estimator identity is `(method, version, params_hash)`.** Changing the
estimation formula changes the system's behaviour, so it needs an identity,
lineage, and shadow comparison like everything else that evolves. Without it,
"fixing the formula" is a silent upgrade that destroys auditability.

## 6. Consumers

Gate policy T_high and T_low (Checkpoint §4); graduation and trust tiers, with
**immediate demotion on a fall** (Role §5); the shadow comparison table (Role §4);
cost and quality per Role, read against metering at the same log position;
routing — the fallback chain, and model choice by masking accuracy (RPA North
Star §7); confidence per chunk and collection (Knowledge §6); confidence per
driver and detector.

**Visibility**: assessment data about people is sensitive. By default only a Role
holding `view_calibration` within the scope may read it, and
`calibration_visibility_policy` is an enterprise extension point (Tenant &
Identity §8).

**A cell is a classified source, on the one lattice.** It carries a
**classification** like any other classified source and, undeclared, sits at
`confidential` — the lattice is canonical at Knowledge §3, and this section only
joins it. Nothing new follows from saying so, which is the point: a figure
derived from cells inherits their floor through provenance, so publishing one
outside the tenant meets the **leakage gate** already guarding aggregates
(Working Data §1); generalising across several subjects meets the **group floor**
multi-subject distillation already carries (Memory §5), not a second one written
here; a read at a level emits a **read event** (Tenant & Identity §4), which is
what answers _who read what about whom_; and `model_policy` routes a cell the way
it routes a knowledge chunk or a memory entry.

**The lattice and the grant guard different doors, and neither substitutes for
the other.** `view_calibration` decides whether a principal _inside_ the tenant
may read assessment data at all; the classification decides what may _leave_.
Someone holding a grant that reaches `confidential` but not `view_calibration` is
refused by the grant, not by the floor — reading the derived figure is still
reading calibration. The lattice adds the half the grant never had: an egress
check for the figure once it is drawn, and a read event that records the attempt
either way.

The reason it has to be said — stated as the history it is, because this
paragraph describes what the omission _was_ and not what the rule now permits.
Calibration was the one source classified in substance and absent from the
lattice, and the gap was invisible from either side: `view_calibration` governs
**the cell**, and a number _derived_ from cells is not the cell, so **before this
rule** it inherited no floor and left no read event, and a confidence rendered
beside a client-facing figure could cross to a viewer holding no Role in the
tenant at all — by omission rather than by anyone's decision. **Under this rule**
that figure carries the floor of the cells behind it and reading it emits a read
event. Joining the lattice still does not decide whether such a figure may be
shown: the default refuses it, and relaxing that remains the
`calibration_visibility_policy` decision, unchanged.

## 7. Non-goals

- No specific statistical or ML formula. The estimator is the evolving layer and
  carries an identity (§5).
- No new store, no cross-tenant calibration, and no input from outside the
  Judgment system.
- **No input that is not a signed Judgment on an output.** Nothing about conduct,
  attendance, hours or sentiment can enter a cell — §2's write path is the only
  door, and the CalKey (§1) binds every value to
  `(role, task_type, criterion@version)`. There is no dimension in which a person
  exists here apart from their output against a named criterion.
- **No consumer beyond §6's list, and the engine adds none**: gate thresholds,
  graduation, shadow comparison, cost and quality per Role, routing. The engine
  computes nothing for compensation, discipline or employment, because no such
  consumer exists. **A stated limit, in the voice RPA: Sandbox & Credential §1
  uses**: what a Role holding `view_calibration` does with what it reads is
  outside this mechanism, and `calibration_visibility_policy` (Tenant & Identity
  §8) widens that door rather than narrowing it. Pretending the mechanism reaches
  past its own consumer list is the dangerous reading.
- It does not score the party being served — that is Memory, and Memory §0 draws
  the same line from the other side.

## 8. Decisions

| Question           | Settled                                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is         | A pure projection of the log — no store, rebuildable                                                                                                                                      |
| Unified key        | One seven-dimensional CalKey space; the filler profile and the verifier's layer C are two slices of it                                                                                    |
| Subject            | An open `(kind, identity@version)` — one engine for filler, verifier, driver, detector, chunk and contract                                                                                |
| Workspace          | A mandatory dimension, defaulting to the narrowest; pooling is a template value                                                                                                           |
| The write path     | Only through a valid Judgment — paired with the ban on memory about a filler                                                                                                              |
| **The test label** | A Judgment with `run_kind: test` is **absolutely excluded** and not configurable. The label's home is Event Log §1/§3; this document declares a position rather than redefining the label |
| Decay              | Lineage decay by the nature of the change, plus a time-freshness half-life                                                                                                                |
| Estimator          | An identity of (method, version, params_hash), against silent formula upgrades                                                                                                            |
| Cost               | Sparse cells, sufficient statistics and rebuild-from-log mean storage tracks the number of Judgments, with a retention valve                                                              |

## Litmus

1. Delete every cell — does a rebuild from the log produce an equivalent result,
   proving it is a pure projection?
2. Point at any confidence number at a Gate: can the cell keys,
   `estimator@version` and the originating Judgments all be traced?
3. Change a filler's prompt or model: does the new cell inherit from its parent
   with decay — neither resetting to zero nor carrying over untouched?
4. Is there any path that changes a filler's score without a valid Judgment,
   including an administrator editing the database (drift detection, Working Data
   §2)?
5. With a template that splits learning per workspace: does the estimate for
   client A read not one Judgment belonging to client B?
6. Two doors, asked separately. A principal **inside** the tenant holding a
   grant that reaches the cells' classification but **not** `view_calibration`
   asks for a confidence derived from them — is it refused by the grant, and does
   the attempt leave a read event naming who asked? And the same figure on its
   way **outside** the tenant — does it carry the cells' floor into the leakage
   gate, so a policy that permitted the read still does not permit the export?
7. Name a value in any cell that did not arrive as a signed Judgment on an
   output, and name a consumer of a cell that is not in §6's list. If neither can
   be produced, §7's first two bullets are falsifiable claims rather than a
   posture.

## Failure modes

| Failure                                              | Detected by                                                                                                                                                                                                                                                    | Recovery                                                                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projection drift, or a wrong cell                    | A checksum by log position (Working Data §2)                                                                                                                                                                                                                   | Rebuild from the log, with a warning event                                                                                                                             |
| An estimator bug skewing many results                | The estimator has an identity and is shadow-compared before graduation                                                                                                                                                                                         | Roll back to the previous estimator version, which is possible because it is named                                                                                     |
| Poisoning through forged Judgments                   | The `judge` capability, `distinct_filler_from`, and a Conflict on disagreement                                                                                                                                                                                 | Malicious Judgments are neutralised through re_review and outcome; the actor is accountable in the log                                                                 |
| Cell cardinality growing                             | Sparseness, sufficient statistics, and a threshold warning                                                                                                                                                                                                     | Retention or merging by policy — the log still holds the truth                                                                                                         |
| A derived figure reaching a viewer without the grant | **Two checks, not one**: the `view_calibration` grant for a reader inside the tenant, and floor propagation into the leakage gate for the figure leaving it — each catching what the other cannot; the read event by level records the attempt either way (§6) | The read or the egress is refused and recorded; where the figure is genuinely wanted outside, the route is `calibration_visibility_policy`, never an unclassified copy |
