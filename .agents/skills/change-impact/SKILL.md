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
introduces no new class, no status field, no revalidation sweep, and no
automation: this is a manual assessment procedure, and the repository runs no
check that enforces impact verdicts.

## Accountability and timing

- **Who:** the author or owner of the triggering material change is
  accountable for the assessment; a spec's owner only responds to the
  verdict.
- **When:** after the material change is accepted or merged, as part of
  reconciliation and before the triggering work item closes
  ([`docs/changes/README.md`](../../../docs/changes/README.md) §4). Before
  merge, the PR author may note likely dependencies as review context, but
  must never present an unaccepted proposal as an accepted verdict.

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
- Confirmation that the triggering change itself is accepted. An unaccepted
  trigger is an escalation, not an assessment input.
- Read access to the active index in `docs/changes/README.md` §6, to every
  spec's Baseline references and Dependencies sections, and to open root
  issues for owner resolution.

## Workflow

1. **Confirm the trigger is accepted.** An unaccepted proposal is an
   escalation, not an assessment input.
2. **Confirm materiality** with the trigger vocabulary
   [`docs/changes/README.md`](../../../docs/changes/README.md) already owns:
   a change to the current canonical baseline, an accepted decision, a
   committed Milestone's scope, or a shared contract, library or bounded
   context. If none matches, no assessment is owed — say so and stop.
3. **Enumerate the candidate universe.** List every spec in the active index
   (`docs/changes/README.md` §6) — the index is the complete universe, not a
   sample — and inspect each spec's Baseline references and Dependencies
   sections. A spec is a candidate only when one of them touches the changed
   artifact. Record why each candidate matched, and why each non-candidate
   was excluded.
4. **Resolve the exact owning root issue per active candidate**, mechanically
   per `docs/changes/README.md` §4: search the open root issues for the spec
   path (the `change-spec` form field convention) — exactly one match is the
   owner; zero matches is the `no reachable owner` escalation and more than
   one is ownership drift. Both stop the assessment: report to the
   coordinator, never silently pick one; restoring ownership (editing the
   root issue body) belongs to the coordinator or the issue's owner.
5. **Check the dependency graph of the active candidates for cycles** (their
   Dependencies sections). A cycle is a blocking modelling defect: its
   resolution is to combine the specs under one spec, to split them at
   ownership or contract boundaries with one-way dependencies, or to
   escalate — never to guess an ordering, and never to create a new
   dependency registry to track it.
6. **Classify each candidate** with exactly one impact class, per
   [`docs/changes/README.md`](../../../docs/changes/README.md):
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

   State why this class applies and why each competing class does not.

7. **Record the verdicts on Issues, never inside a spec**: one comment on the
   triggering work record, and one on each candidate's owning root issue.
   When the trigger has no Issue, the triggering PR is the trigger record;
   the dependent spec's verdict still goes on its owning root issue.
8. **For Superseded or Withdrawn only:** the terminal marker line inside the
   spec and the matching note on its index row are enforced in the same
   logical change as the verdict — the only edit a verdict ever makes to a
   spec, and it belongs to the spec's owner; the assessment is not complete
   until both exist.
9. **Attach an owner and a follow-up to every non-No-impact verdict.** A
   verdict without a named owner and next action is not recorded as done;
   request the owner's revalidation rather than performing it.
10. **Do not cascade.** Revalidate only the specs the material change
    actually touches; leave unaffected specs alone, and do not sweep
    unrelated packages or documents.

## Allowed changes

- Read every Change Specification and its Baseline references and
  Dependencies sections.
- Comment on the triggering work record (the Issue, or the triggering PR when
  no Issue exists) and on each dependent spec's owning root issue with the
  verdict, its rationale and the follow-up.
- Propose the terminal marker line and the index note for Superseded or
  Withdrawn specs, to be applied by the spec's owner in the same logical
  change as the verdict.
- Request the owner's revalidation for Adapt and Rebase verdicts.

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
- Claiming automation or machine enforcement of the assessment; verdicts are
  produced and recorded manually, with no check behind them.
- Creating a dependency registry or any parallel tracking of spec
  dependencies beyond the specs' own Dependencies sections and the §6 index.
- Presenting an unaccepted proposal as an accepted verdict, before merge or
  after.

## Evidence to collect

- The triggering change and its record: diff or decision reference, PR
  number, ADR number or canonical path, with the section that changed.
- The dependency trail per spec: which Baseline reference or Dependencies
  entry matched the changed artifact, quoted with its section.
- The verdict per spec, with why this class applies and why the competing
  classes do not.
- Where each verdict was recorded: the triggering work record (Issue or PR),
  the owning root issue numbers.
- The owner and follow-up per non-No-impact verdict, and where the follow-up
  is tracked.
- The non-candidates considered and why each was excluded.
- The cycle check result for the active candidates' dependency graph.

## Completion criteria

- Materiality was confirmed against the triggers, or the assessment was
  correctly not started.
- Every candidate spec has exactly one recorded verdict, on the triggering
  work record and on its owning root issue.
- Every non-No-impact verdict carries a named owner and a follow-up.
- Superseded and Withdrawn specs carry the single terminal marker line and
  the index note in the same logical change as the verdict, and no other
  spec content changed.
- Unaffected specs were left alone — and that is stated, not implied.
- No automation or machine enforcement was claimed for any of it.

## Escalation

Stop and report when:

- The baseline a spec claims to stand on is ambiguous — the reference is
  stale, unreadable or points at a superseded record.
- A dependent spec has no reachable owner, or more than one open root issue
  references its path — both are ownership drift to report to the
  coordinator (`docs/changes/README.md` §4), never a choice of one;
  restoring ownership (editing the root issue body) is the coordinator's or
  issue owner's decision.
- The dependency graph of active candidates contains a cycle that the
  combine/split resolutions cannot settle — combining or splitting specs is
  their owners' decision, not the assessor's.
- Two specs claim the same affected scope, or a spec's Dependencies
  contradict the triggering change's own record.
- The triggering change itself is not accepted — there is nothing to assess
  against yet.
