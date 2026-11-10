---
name: change-impact
description: Apply when a material change — to the current canonical baseline, an accepted decision, a committed Milestone's scope, or a shared contract, library or bounded context — may affect dependent Change Specifications in `docs/changes/`, or when a spec's baseline references shifted and dependent specs need revalidation. USE WHEN classifying the effect on dependent specs as No impact / Adapt / Rebase / Blocked / Superseded / Withdrawn, or planning the follow-ups a verdict requires. NOT FOR initial spec authoring (feature-modelling, domain-modelling), delivery of the change (delivery-slice), or verification of a delivered change (verification).
---

# Change Impact

## Objective

Answer one question per dependent Change Specification: what does this
material change do to that spec, who owns the response, and what follow-up
does the verdict require? This skill executes the impact rules that
[`docs/changes/README.md`](../../../docs/changes/README.md) owns. It
introduces no new class, no status field and no revalidation sweep.

## Canonical references

- [`docs/changes/README.md`](../../../docs/changes/README.md) — owns the
  impact classes, the material-change triggers, where verdicts are recorded,
  the owning-root-issue rule (§4), and the no-cascade rule. This skill
  restates none of them as its own.
- [`docs/engineering/evolution-process.md`](../../../docs/engineering/evolution-process.md)
  — §8.1 owns the reconciliation classes, a different axis: impact classes
  describe the effect on a dependent spec, reconciliation classes describe
  the delta between target and reality.
- [`docs/engineering/work-management.md`](../../../docs/engineering/work-management.md)
  — §2.2 (record kinds and their Issue Types), §3 (root issues own outcomes
  and carry Project membership; verdicts land on Issues, and the owning root
  issue is where a spec's verdict belongs).
- [`docs/changes/_template.md`](../../../docs/changes/_template.md) — the
  Baseline references and Dependencies sections a dependent-candidate set is
  read from.

## Required inputs

- The triggering change: what changed, where it is recorded (merged PR,
  accepted ADR, canonical edit, committed Milestone scope), and why it might
  be material.
- The dependent-candidate set: Change Specifications whose Baseline
  references or Dependencies touch the changed artifact.
- The owning root issue of each candidate spec, resolved mechanically per
  `docs/changes/README.md` §4: enumerate the specs in the §6 index, search
  the open root issues for each spec path — exactly one match is the owner;
  zero matches is the "no reachable owner" escalation; more than one match
  is ownership drift: report it to the coordinator, do not pick one, and
  leave restoring ownership (editing the root issue body) to the
  coordinator or the issue's owner.
- Confirmation that the triggering change itself is accepted. An unaccepted
  trigger is an escalation, not an assessment input.

## Workflow

1. **Confirm materiality.** Check the triggering change against the triggers
   in `docs/changes/README.md`: a change to the current canonical baseline,
   an accepted decision, a committed Milestone's scope, or a shared
   contract, library or bounded context. If none matches, no assessment is
   owed — say so and stop.
2. **Enumerate the dependent specs.** Read the index in
   `docs/changes/README.md`; for each spec, read its Baseline references and
   Dependencies sections. A spec is a candidate only when one of them
   touches the changed artifact. Record why each non-candidate was excluded.
3. **Classify each candidate** with exactly one impact class, per
   `docs/changes/README.md`:
   - **No impact** — the spec does not depend on the changed part. Nothing
     to do.
   - **Adapt** — the spec's content needs updating; the baseline it stands
     on is unchanged. The owner updates the spec.
   - **Rebase** — the baseline itself shifted; the spec must be re-derived
     on the new baseline by its owner.
   - **Blocked** — the spec cannot proceed until the triggering change
     resolves. Record the follow-up and wait for the unlock.
   - **Superseded** — a later decision or spec replaces this one. Terminal.
   - **Withdrawn** — the owner withdraws the spec. Terminal.
4. **Record the verdicts on Issues, never inside a spec**: one comment on
   the triggering Issue, and one on each dependent spec's owning root issue.
   The spec file itself never carries the verdict.
5. **For Superseded or Withdrawn only:** propose the single terminal marker
   line inside the spec and the matching note on its index row — the only
   edit a verdict ever makes to the spec, and it belongs to the owner to
   accept.
6. **Attach an owner and a follow-up to every non-No-impact verdict.** A
   verdict without a named owner and next action is not recorded as done;
   request the owner's revalidation rather than performing it.
7. **Do not cascade.** Revalidate only the specs the material change
   actually touches; leave unaffected specs alone, and do not sweep
   unrelated packages or documents.

## Allowed changes

- Read every Change Specification and its Baseline references and
  Dependencies sections.
- Comment on the triggering Issue and on each dependent spec's owning root
  issue with the verdict, its rationale and the follow-up.
- Propose the terminal marker line and the index note for Superseded or
  Withdrawn specs.
- Dispatch or request the owner's revalidation for Adapt and Rebase
  verdicts.

## Prohibited changes

- Rewriting a spec's target model yourself, whatever the verdict — Adapt and
  Rebase belong to the spec's owner.
- Recording a verdict inside a spec file, or adding any status field,
  progress marker or M1/M2 note to one.
- Treating impact classes as reconciliation classes, or classifying a
  target-reality delta with them — they are different axes
  (`evolution-process.md` §8.1).
- Bulk-modifying Issues, or commenting on Issues you cannot tie to a
  verdict.
- Cascade revalidation of specs the material change does not touch.

## Evidence to collect

- The triggering change and its record: diff or decision reference, PR
  number, ADR number or canonical path, with the section that changed.
- The dependency trail per spec: which Baseline reference or Dependencies
  entry matched the changed artifact, quoted with its section.
- The verdict per spec, with the rationale that rules out the other classes.
- Where each verdict was recorded: triggering Issue number, owning root
  issue numbers.
- The owner and follow-up per non-No-impact verdict, and where the follow-up
  is tracked.
- The non-candidates considered and why each was excluded.

## Completion criteria

- Materiality was confirmed against the triggers, or the assessment was
  correctly not started.
- Every dependent spec has exactly one recorded verdict, on the triggering
  Issue and on its owning root issue.
- Every non-No-impact verdict carries a named owner and a follow-up.
- Superseded and Withdrawn specs carry the single terminal marker line and
  the index note, and no other spec content changed.
- Unaffected specs were left alone — and that is stated, not implied.

## Escalation

Stop and report when:

- The baseline a spec claims to stand on is ambiguous — the reference is
  stale, unreadable or points at a superseded record.
- A dependent spec has no reachable owner, or more than one open root issue
  references its path — both are ownership drift to report to the
  coordinator (`docs/changes/README.md` §4), never a choice of one;
  restoring ownership (editing the root issue body) is the coordinator's or
  issue owner's decision.
- Two specs claim the same affected scope, or a spec's Dependencies
  contradict the triggering change's own record.
- The triggering change itself is not accepted — there is nothing to assess
  against yet.
