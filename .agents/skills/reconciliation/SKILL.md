---
name: reconciliation
description: Apply when the target model must be compared with what
  actually exists — after a PR merges or a slice, milestone or release
  completes, and before selecting the next slice, when gaps and opportunities
  must be classified. Classify the delta in the existing reconciliation
  classes and update the work item and canonical record honestly. USE WHEN
  asked to reconcile a finished slice, close out an Issue, triage gaps before
  planning the next slice (`evolution-process.md` §6.3), or classify a gap,
  limitation or deviation recorded against the target. NOT for writing the implementation,
  choosing or running verification commands (that is `verification`), or
  planning new work before the comparison is done. NOT for commit messages or
  PR titles.
---

# Reconciliation

## Objective

Answer one question with evidence: where does the capability actually stand
against its target, what happened to its dependencies, and — when the slice
rode a Change Specification — did canonical promotion complete? Produce the
classification, the records it requires, and an honest Issue closure decision.
This skill applies the existing reconciliation and deviation vocabulary. It
introduces no new class, no severity level, no status table, and no second
backlog.

## Canonical references

- `docs/engineering/evolution-process.md` §8.1 (reconciliation classes), §8.2
  (limitation vs deviation), §8.3 (reconciliation rules), §5.1–§5.3 (states
  and evidence; the authoritative baseline is never a Change Specification),
  §6.7 (Reconcile), §7 (prerequisite work is
  `Implemented, not verified`).
- `docs/engineering/work-management.md` §2.2 (record kinds and their Issue
  Types), §2.5 (assumption and scope changes), §2.6 (closure conditions and
  closure reasons), §5.2 (linking a PR to an Issue).
- `docs/engineering/contribution-workflow.md` §2.10 (reconcile after merge).
- `docs/changes/README.md` — §3 (the three decision states; accepted target
  decisions become canonical at canonical promotion, not before), canonical
  promotion and the impact classes a material change applies to dependent
  Change Specifications. Impact classes
  are a different axis from the reconciliation classes of §8.1: one classifies
  the effect on a dependent spec, the other the delta between target and
  reality. Never substitute one for the other.
- `docs/AGENTS.md` §9 (artifact lifecycle), §10 (ADR governance, including
  partial supersession), §12 (deviation governance and where each record
  goes).
- `AGENTS.md` (`Workflow`, `Pull requests`); `docs/architecture/02-delivery.md`
  §12 (no deployment record store yet).

## Required inputs

1. The Issue and PR that carried the work, plus their acceptance criteria and
   the scope statement that limited them.
2. The canonical target: the specification, requirement or ADR section in the
   view that owns the capability.
3. The verification outcome already recorded — passing layer result, failing
   result, or "could not run" — with the revision it applies to.
4. The deployment record and post-deploy check, if a `Released` claim is being
   considered. If absent, `Released` is out of reach.
5. Any known limitation or accepted deviation declared in the PR or Issue.
6. The exact scope under reconciliation. Namespace it explicitly: the whole
   capability, or the slice of it this unit covered.

## Workflow

1. Restate the target for the scope under review, quoting the owning canonical
   location. Do not restate the rest of the target the unit never touched.
2. Establish reality from evidence, not from Issue state or recollection.
   Inspect the source, contract and configuration that exist now; use the
   verification result for behavioural claims. Record what was checked, where,
   and at which revision.
3. Apply the classes in `evolution-process.md` §8.1 to each part of the scope.
   Pick names only from that set: Aligned, Partially implemented, Not
   implemented, Implemented, not verified, Released, Accepted deviation, Gap
   requiring work. Do not invent, rename or rank them.
4. Combine the classes where they answer different questions. A capability may
   be both `Released` and `Aligned`; coverage, environment reach and attitude
   to a difference are separate axes. State each class that applies and the
   evidence behind it.
5. For every difference, name it with the §8.2 vocabulary: a temporary
   limitation, an accepted deviation, or a gap requiring work. Then write the
   record `docs/AGENTS.md` §12 prescribes for that category — a PR/Issue note,
   an ADR plus a canonical update, or an Issue with evidence and completion
   condition. Do not create a record for a minor difference.
6. When evidence contradicts an assumption the specification relied on, decide
   which of three cases it is, using `work-management.md` §2.5 and
   `evolution-process.md` §6.7:
   - **Wording or a stale supporting statement, target unchanged** — correct
     the owning canonical document in the same change and say why in the Issue
     comment.
   - **The target itself changes** — a separate work item with Issue Type
     Modelling; reconciliation records the finding and routes it, it does not
     make the decision.
   - **An accepted decision no longer holds** — write a superseding ADR; never
     edit the accepted ADR to match the code, including partial supersession
     under `docs/AGENTS.md` §10.
7. For every material gap, search for an existing Issue before opening one; if
   none tracks it, open a work item with Issue Type Remediation carrying the
   gap class, the evidence, the affected canonical location, and a completion
   condition. Link it from the finished unit.
8. When the unit delivered behaviour under a Change Specification, evaluate
   the promotion conditions: did canonical promotion complete — the owning
   canonical documents updated, the ADRs `docs/AGENTS.md` §10 triggers
   written, the catalog and context map current? If it did not, record the
   pending promotion as the explicit follow-up on the unit's Issue. Never
   auto-update canonical documents just because the PR merged; promotion is
   an explicit act — the point where the spec's accepted target decisions
   become canonical, which they do not before it
   (`docs/changes/README.md` §3) — and the same check applies to the unit's
   dependencies.
   When the delivered change is itself material for dependent Change
   Specifications, route the impact assessment to `change-impact` — its
   impact classes are a different axis from the reconciliation classes of
   step 3.
9. Record the result as a comment on the Issue of the unit just finished. State
   the scope reconciled, the class per part with its evidence, the records
   created or updated, the promotion state when a Change Specification was
   involved, and the remaining limitation. Use clear prose per
   `docs/AGENTS.md` §2, and write human-facing Issue text in the language `AGENTS.md`
   `Language` requires.
10. Decide closure against `work-management.md` §2.6. Close as `completed` only
    when the outcome is met, evidence exists, and this reconciliation comment is
    present. Use `not planned` with the decision and where it was recorded, or
    `duplicate` with a link to the retained Issue. When verification failed,
    leave the Issue open and let the Remediation unit carry the remainder.
11. Check that nothing recorded asserts a state above its evidence: a closed
    Issue, a merged PR, green CI or a successful deploy are not proof of a
    higher capability state.

## Allowed changes

- Comment on the Issue of the unit just finished, and update its body when a
  recorded assumption or scope changed (`work-management.md` §2.5).
- Open a work item with Issue Type Remediation, or reuse an existing one that
  already tracks the gap.
- Record in the Issue that evidence changed an assumption. Correcting a stale
  supporting statement whose target is unchanged is allowed in the same
  change; changing the target is a separate work item with Issue Type
  Modelling (`work-management.md` §2.5), routed through `domain-modelling`
  or `architecture-evolution`. Do not settle a decision inside a
  reconciliation.
- Write a new ADR that supersedes the part of an accepted decision that no
  longer holds, updating the old status line and both index rows.
- Close the unit's own Issue with the correct closure reason.

## Prohibited changes

- Editing an accepted ADR, or any canonical decision record, so it matches
  current code. Supersede it with a new ADR instead. Correcting a stale
  supporting statement — where the target does not change — is not an edit to
  a decision and is allowed.
- Adding or maintaining a manual capability-status table in `docs/`, or any
  second backlog, dashboard or roadmap file.
- Asserting a business outcome, production runtime state, or architectural
  quality without external data and a named confirmer
  (`evolution-process.md` §8.3).
- Closing an Issue whose verification failed, or whose scope has no
  classification and evidence recorded.
- Claiming `Released` without a deployment record and a post-deploy
  environment check.
- Opening new implementation work before the comparison is written down.
- Auto-updating canonical documents because a PR merged. Canonical promotion
  under a Change Specification is an explicit act — accepted target decisions
  become canonical there, not at merge (`docs/changes/README.md` §3); an
  unfinished one is recorded as the pending follow-up, not papered over.
- Classifying a dependent Change Specification's fate with the §8.1
  reconciliation classes, or a target-reality delta with the impact classes
  of `docs/changes/README.md` — they are different axes.
- Reclassifying the Issue Type silently, or reopening or editing another
  session's Issue instead of commenting.
- Inventing a class, severity, or deviation category outside the canonical
  sets.

## Evidence to collect

- The canonical location stating the target, with the section quoted.
- The source, contract or configuration inspected for `Implemented` evidence,
  with paths.
- The verification result used for `Verified`, and its revision.
- The deployment record locator and post-deploy check for `Released`, or the
  explicit statement that none exists.
- The declared limitation or deviation, if any, with where it was declared.
- The class assigned to each part of the scope, and the evidence supporting it.
- Records created or updated: Issue numbers, ADR numbers, canonical paths.
- When a Change Specification was involved: whether canonical promotion
  completed, and where the pending promotion is recorded when it did not.
- The closure reason selected, and the condition from §2.6 that authorises it.
- Whatever could not be automated or confirmed, and who must confirm it.

## Completion criteria

- Every part of the reconciled scope has one or more §8.1 classes with
  evidence, and no class is used outside that set.
- Each difference is named as a limitation, an accepted deviation or a gap, and
  carries the record its category requires.
- Canonical documents no longer contradict the accepted reality; a contradicting
  decision has a superseding ADR rather than an edit.
- With `Closes #N` GitHub auto-closes at merge, before this comment exists; the
  comment is still owed, and a failed reconciliation reopens the Issue. The
  reconciliation comment exists on the unit's Issue before closure.
- The closure reason matches §2.6, and no claim exceeds its evidence.
- When a Change Specification was involved, the promotion state is recorded:
  promoted, or pending with its explicit follow-up.
- No new status table, second backlog, or invented vocabulary was introduced.

## Escalation

Stop and report when:

- the target cannot be identified, or two canonical documents disagree about
  it — do not choose a winner;
- a `Released` claim needs a deployment record that does not exist;
- the evidence needed is production runtime data, business telemetry or human
  judgement that this session cannot obtain;
- the difference is material enough to need an ADR, and the decision is not
  yours to accept;
- closing the Issue would contradict a failed verification or an open
  Remediation dependency;
- the Issue belongs to another session or person and you lack authorisation to
  close or edit it.
