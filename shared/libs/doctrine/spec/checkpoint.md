---
title: "Primitive: Checkpoint"
status: design-end-state
---

# Primitive: Checkpoint

## 0. The four mechanism principles (canonical: North Star §3)

1. **The engine is strictly symmetric** between people, AI, and rule/code. Any
   asymmetry — a default, a threshold, an on/off, an ordering — exists only at
   the policy or template layer.
2. **Anything that has to accumulate learning is a first-class entity with a
   stable identity, and that identity has lineage**: Criterion, verifier
   identity, Judgment basis, Conflict.
3. **The engine forces a parameter to exist; a template forces its value** — SLA,
   sampling rate, threshold.
4. **Complexity is the user's choice**: the engine carries the full mechanism,
   defaults to the minimum, and advanced capability is opt-in by declaration,
   with defaults inherited through the cascade (Composition).

## 1. The conceptual model

| Entity        | What it is                                                                                                                                                                                                    | Lifetime                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Gate**      | The decision point where a Task's output either flows on or does not. Outcomes: auto-pass / review / retry / escalate                                                                                         | Blocking; closes on pass or fail                                                     |
| **Judgment**  | A record of assessment: verifier, criterion, verdict on a declared scale, basis, provenance                                                                                                                   | Append-only, attached to the output permanently; can be added after the task is done |
| **Criterion** | An assessment criterion independent of any Checkpoint: stable id, version, natural-language description, and a kind (`contract` or `quality`). A tenant keeps a **criterion library** reused across processes | Versioned; a change of meaning is a new version                                      |
| **Conflict**  | An event raised when two Judgments contradict — human against AI, AI against AI, contemporaneous against outcome                                                                                              | The signal that a rubric needs fixing                                                |

A Gate **consumes** Judgments. A Judgment made after the fact **does not reopen a
Gate**; it becomes a label. A serious error found after completion raises an
alert and a separate remediation task, because a Gate that can reopen is a Gate
whose "passed" means nothing.

A Gate's rubric is a set of references to Criteria with weights. It does not own
them.

**Calibration attaches to the criterion id, not the rubric.** Editing a rubric
therefore only resets the criteria whose meaning changed, and a criterion shared
across processes accumulates shared calibration — which is what reduces
per-tenant cold start.

## 2. Gate structure

| Field      | Content                                                                                                                                                        | Required |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `rubric`   | Criterion references with weights. `contract` criteria are a hard gate                                                                                         | ✅       |
| `stages`   | A sequence of stages; each has parallel verifiers and an `aggregation` (`all_pass` / `quorum(n)` / `weighted ≥ T`). Each verifier is assigned its own criteria | ✅       |
| `policy`   | The mapping from calibrated confidence to action (§4)                                                                                                          | ✅       |
| `on_fail`  | §5                                                                                                                                                             | ✅       |
| `budget`   | The verification cost ceiling                                                                                                                                  | ✅       |
| `sla`      | Deadline plus escalation for `awaiting_review`. **The engine requires it to be declared**; the number comes from a template                                    | ✅       |
| `sampling` | The probabilistic audit rate over the auto-pass band. Required by the engine; the template default is 10%, blind                                               | ✅       |

**Verifier.** Its identity is `(type, id, version, config_hash)`, so changing any
configuration — prompt, temperature, model version — is a new identity as far as
calibration is concerned.

**Identity lineage** stops the flywheel resetting: a new identity declares a
`parent_identity` and **inherits calibration from the parent with a decay
factor** (a class-C parameter valued by template). The standard optimisation loop
is: propose a new config → run it in shadow (Role §4) → graduate it in place of
the parent. Without lineage, every prompt optimisation burns the data already
learned.

A verifier declares a **fallback chain** of cheaper verifiers. Exceeding budget
walks down the chain; exhausting the chain decides on the Judgments already held
and sets a `degraded` flag, which lowers the calibration weight.

**Stage order is mechanically free.** A human stage first, in the middle or last
are all valid — a person triaging quickly before an AI runs deep compliance
checks is a real case. "People last, so AI filters the noise first" is a
**template default, not an engine law**; making it a law would be an asymmetry in
the engine, which principle #1 forbids.

**Separation of duties**: a stage or assignment can declare
`distinct_filler_from: <role/stage>`, so the filler that produced the output
cannot judge it where the tenant requires that — the guard against one person
filling two roles and approving themselves. The engine forces the capability to
exist; whether it is on is a template value. Symmetric: it applies to agents as
much as to people.

**What counts as the same actor is declared, because comparing filler identities
alone is not symmetric in practice.** The guard takes a `basis`: `filler`, which
compares filler identities and is the default and today's behaviour, or
`principal`, which compares the **accountable principal** — for a person,
themselves; for a rule, whoever authored it; for an agent, the principal whose
gated administrative Task registered or authorised that filler, which Tenant &
Identity §4 already records with full identity because `grant_capability` is
itself labour with a Gate. Nothing new is written down; the edge already exists
and the comparison simply could not read it. Without the choice, a person who
puts an agent between themselves and the work gets a guarantee a person acting
directly does not, which is an `if human` branch arriving as a hole rather than
as a rule, and Role litmus #3 asks for "every path, including through two roles".
Which basis applies stays a template value, because how much separation a tenant
needs is policy.

**Its reach is the gate, not the escalation.** `distinct_filler_from` binds a
stage or assignment; it says nothing about `override_gate` or `arbiter`, and it
is not silently extended here. A tenant that needs the same person barred from
authorising a filler and then overriding the gate over its output expresses that
where those capabilities are granted (Role §2, Escalation §4) — the guard is
about who may **judge**, and an override is by construction the path for when
judging has failed.

Correlated-error warning: several models of the same family judging the same
criterion is approximately one model. The value of multiple verifiers lies in
**each judging a different criterion** — factual, tone, compliance — not in
counting agreements.

**Review assignment** carries `blind: true/false` per stage: whether a reviewer
sees earlier Judgments. Sampling defaults to blind, to stop anchoring and keep
calibration clean; quick review defaults to sighted, with AI highlighting the
doubtful parts. Both are **template values**, not engine law.

## 3. Judgment schema

| Field           | Content                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifier`      | The full identity: type, id, version, config_hash                                                                                                                                                                                                                                                                                                                      |
| `criterion_ref` | The criterion id and version being judged                                                                                                                                                                                                                                                                                                                              |
| `verdict`       | A value on **the scale the verifier declares** — scalar 0–1, categorical approve/edit/reject, boolean. Layer C converts every scale into a probability that this tenant's people would agree                                                                                                                                                                           |
| `basis`         | `contemporaneous` / `re_review` / `outcome` — an open taxonomy whose weights are calibration parameters, never hardcoded, with outcome as the strongest prior. The openness also absorbs collaboration: **a comment or annotation is a Judgment with `basis: comment`, no verdict, weight 0 by default** — discussion leaves a trace without contaminating calibration |
| `edit_diff`     | For an approve-with-edit verdict, the diff in full — the most valuable label there is for prompt optimisation. The edited version is a **new derived artifact** in provenance; the original is immutable and never edited in place                                                                                                                                     |
| `feedback`      | Structured and bound to a criterion id: where it failed, why, and what would fix it — fed into the retry, and minable by the Intelligence layer                                                                                                                                                                                                                        |
| `provenance`    | Open metadata: batch size, time spent, blind, degraded, device. Calibration decides for itself what to use                                                                                                                                                                                                                                                             |

The right to create a Judgment is the `judge` capability on a Role. Symmetric: an
agent can hold it too — an agent tracking outcomes labels them itself. Whoever is
teaching the system is always controlled and always traceable.

## 4. Confidence — a three-layer pipeline

| Layer                    | Content                                                                                                                                 | Role                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A. Self-report           | The model's own score or logprob                                                                                                        | A secondary signal, never load-bearing alone                                             |
| B. External verification | Contract criteria as a hard gate, plus verifiers judging quality against the rubric                                                     | The main source of the raw value                                                         |
| C. Empirical calibration | Tenant history keyed by (criterion id, role, task type, verifier identity, basis), converting raw into a probability of human agreement | The per-tenant flywheel; cold start shrinks because criteria are shared across processes |

Where layer C has too little data, the prior is the template's conservative one:
everything goes to review.

**Default triage policy.** At or above T_high, auto-pass plus sampling. Between
T_low and T_high, quick review — diff view, one tap, batched, with data still
recorded **per item** and with provenance. Below T_low, retry then review. A
contract failure retries immediately.

It tightens itself: when rejections within the sampled set exceed a threshold,
T_high drops, **an audit event is emitted** so the change is reversible, and a
warning is raised. Pure statistics; no ML required.

## 5. `on_fail` — the default order, configurable

1. **retry**, up to N, with the structured feedback fed into the new run
2. **reroute** to a different Role on the same contract, AI or human — the
   mechanism behind "swap AI and people without editing the flow"
3. **escalate** along the Role's Escalation chain
4. **halt and compensate**, linking to Handoff

## 6. Gate states

`pending → verifying(stage k) → [awaiting_review] → passed | failed → (retry/reroute/escalated)`

`awaiting_review` is durable and its SLA is mandatory. Past the deadline the only
options are **escalate or halt — never auto-pass on timeout**. A timeout is
missing information, and treating missing information as approval is the one
failure the whole primitive exists to prevent.

A post-hoc Judgment does not change a Gate's state.

A Conflict event is raised automatically when Judgments contradict. It does not
block the flow; it records, and it is the signal that a rubric needs fixing. The
n=1 case of someone approving what the AI scored low is one instance of it.

## 7. Non-goals

- A Gate does not route work (Role, Task) and does not define a data contract
  (Handoff).
- Rubrics and criteria are not generated automatically — that belongs to
  Pair-design.
- A post-hoc Judgment never triggers rework by itself.

## 8. Decisions

| Question                                       | Settled                                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Verification inside or outside the transaction | Outside — Judgments are an async stream and the Gate waits for enough of them                        |
| Criteria format                                | Criterion is a first-class entity in a tenant library; calibration binds to its id                   |
| Incompatible scoring scales                    | The verifier declares its scale; layer C converts to a probability of human agreement                |
| Post-hoc review                                | `basis` is an open taxonomy; weights are calibration parameters, with outcome as the strongest prior |
| Sampling                                       | Required by the engine, template default 10% blind, applied to **every Role** — symmetric            |
| Pass-with-edit                                 | A third verdict, plus `edit_diff`                                                                    |
| Budget overflow                                | Fallback chain, then a degraded flag                                                                 |
| Model drift                                    | Verifier identity includes version and config_hash                                                   |
| Batch approval                                 | Recorded per item, with provenance                                                                   |
| Right to judge after the fact                  | The Role's `judge` capability                                                                        |
| SLA                                            | The engine forces it to exist; the template forces its value                                         |

## Litmus

1. Is there no path at all by which a timeout or a deadlock becomes a pass —
   including through auto-tightening, including through sampling?
2. At a blind stage, is there genuinely no way for the reviewer to see earlier
   Judgments?
3. Does every runtime threshold change, tightening or loosening, emit a
   reversible event?
