---
name: feature-modelling
description: Apply when a user problem, desired outcome, product capability or product-level requirement must be clarified before delivery — separating the problem from a proposed solution, stating non-goals, and writing requirements someone can verify. USE WHEN the request says "we need X for users", when an outcome has no verified requirement behind it, or when a capability must be stated precisely enough to select a delivery slice. NOT FOR Issue mechanics such as searching, titling or filing (github-issue), domain boundaries, aggregates or invariants (domain-modelling), topology, deploy units or architecture trade-offs (architecture-evolution), collecting evidence about an unknown (engineering-discovery), or implementing anything (delivery-slice).
---

# Feature Modelling

## Objective

Turn a vague desire into a framed problem and a set of verifiable
requirements, and put that text in a place that is allowed to hold it. This
skill creates **no new document location** — the Features knowledge view is
canonical at [`docs/features/`](../../../docs/features/README.md), future
targets that meet the spec gate live in Change Specifications under
[`docs/changes/`](../../../docs/changes/README.md) (a small well-scoped
feature needs no spec), and inventing a third place would create a second
source of truth.

Produce four things:

1. The user problem, stated without the proposed solution inside it.
2. The desired outcome, as observable behaviour, plus explicit non-goals.
3. Requirements precise enough that a delivery slice can be scoped and
   verified against them.
4. The correct record: a Feature document under `docs/features/` for
   capability that is implemented, a Change Specification under
   `docs/changes/` for a future product target that meets the spec gate
   (`docs/changes/README.md` §1), or the canonical document
   that genuinely owns requirements at that level.

## Canonical references

These documents outrank this skill. Where this skill and a canonical document
disagree, the document wins.

- [`docs/engineering/evolution-process.md`](../../../docs/engineering/evolution-process.md)
  — §3 (the four knowledge views; the Features view is canonical at
  `docs/features/`; Change Specifications are not a fifth view and never
  baseline), §4.1 (the five Issue Type values; a requirement change with no
  behaviour change is Modelling), §6.3 (identify gaps), §6.4 (Select & Plan),
  §7 (vertical slice: state what is covered and what is not).
- [`docs/AGENTS.md`](../../../docs/AGENTS.md) — §3 (`domains/<context>/`
  `domain-model.md` owns business rules and invariants;
  `applications/<component>/` owns application-specific requirements;
  `features/` owns user problems and product capability — implemented
  capability only; `changes/` owns future-target specifications;
  `architecture/` is not a backlog), §4 (canonical source table), §6 (a
  proposal does not become a decision without the owning record).
- [`docs/features/README.md`](../../../docs/features/README.md) — the Features
  view rules: a Feature document describes implemented capability, carries no
  status, and is never a backlog.
- [`docs/changes/README.md`](../../../docs/changes/README.md) and
  [`docs/changes/_template.md`](../../../docs/changes/_template.md) — the
  spec gate (§1: when a Change Specification is required at all), the
  Change Specification lifecycle, the change types (introduce, evolve,
  retire) carried by each Affected scope entry, and the ten required
  sections.
- [`docs/engineering/work-management.md`](../../../docs/engineering/work-management.md)
  — §2.1 (when an Issue must exist), §2.3 (how the Issue Type is recorded),
  §2.4 (minimum Issue content per Issue Type), §5.2 (`Closes #N` versus
  `Refs #N`).
- [`docs/domains/README.md`](../../../docs/domains/README.md) — §1.1 (bounded
  context versus Application and deploy unit), §2 (catalog),
  [`docs/domains/open-boundaries.md`](../../../docs/domains/open-boundaries.md)
  (undecided business boundaries).
- [`AGENTS.md`](../../../AGENTS.md) — `Workflow`, `Language` (Issue bodies are
  Vietnamese), `Change discipline`.
- [`docs/AGENTS.md`](../../../docs/AGENTS.md) §2 — writing quality for the
  Feature document, Issue body and any prose produced here.

## Required inputs

- The request in the requester's own words, including priority instructions.
- The audience and the situation that motivates the request.
- Any proposed solution already present in the request — named as a proposal,
  not as a requirement.
- The existing Issues that may already track this outcome (search first; the
  `github-issue` skill owns that step).
- The owning bounded context or deploy unit, if one is already known.

## Workflow

1. **Separate problem from proposal.** Restate the request without any
   solution in it. If the requester proposed a mechanism, record it under
   _proposal_ and keep it out of the problem statement.
2. **State the outcome as observable behaviour.** "Users can do X and see Y",
   not "build Z". A statement you cannot observe is not an outcome.
3. **Name the audience and the current workaround.** Who is affected, what
   they do today, and what that costs. Evidence beats assumption: label
   inferred claims as inferred.
4. **Fix the level.** Decide which view would own this content:
   - A **product capability that is implemented** — what users get,
     independent of any context's design — belongs to the Features view under
     `docs/features/`, following
     [`docs/features/_template.md`](../../../docs/features/_template.md).
   - A **product capability that does not exist yet** is a future target. A
     Change Specification under `docs/changes/` is required only when the
     change meets the spec gate
     ([`docs/changes/README.md`](../../../docs/changes/README.md) §1), with
     the change type (introduce, evolve, retire) on each Affected scope
     entry per
     [`docs/changes/_template.md`](../../../docs/changes/_template.md); a
     small well-scoped feature needs no spec — the Issue carries the work
     request and acceptance criteria, and canonical promotion happens after
     delivery. Either way it becomes a Feature document through canonical
     promotion and delivery — never by writing it into `docs/features/`
     ahead of the implementation.
   - A **business rule, invariant or policy** of one bounded context belongs
     in `docs/domains/<context>/domain-model.md`. It is not a product
     requirement and does not go into a Feature document.
   - A **technical requirement of one Application** — protocol compatibility,
     runtime constraint, availability — belongs in
     `docs/applications/<component>/02-requirements.md`.
   - A **business boundary between contexts** belongs in
     `docs/domains/open-boundaries.md`, as an open item, not a requirement.

   Do not create a new location for any of these.

5. **Write requirements that are verifiable.** Each requirement states a
   condition someone can check without reading the author's intent. Avoid
   quality words — "fast", "robust", "user-friendly" — unless qualified by a
   measurable condition the requester actually supplied. Do not invent
   thresholds.
6. **State non-goals.** What this outcome deliberately does not cover, and
   why. A non-goal is a boundary, not a TODO.
7. **Mark every open question.** Unresolved product decisions stay open, with
   who or what would settle each one. An open item is not a default value.
8. **Record the result.** Write the framed problem, outcome, requirements and
   non-goals into the record chosen in step 4 — the Feature document, the
   Change Specification, or the existing canonical document that owns content
   at that level. Never both: the other place gets a pointer. An Issue tracks
   the work; it does not become the long-lived requirements record.
9. **Hand off, do not implement.** Delivery scope selection is
   `delivery-slice`; domain design is `domain-modelling`; architecture
   trade-offs are `architecture-evolution`. State which of those the next
   unit is, and stop.

## Allowed changes

- A Feature document under `docs/features/<area>/<feature>.md`, per
  [`docs/features/_template.md`](../../../docs/features/_template.md),
  written in Vietnamese per `AGENTS.md` `Language` — for capability that is
  implemented.
- A Change Specification under `docs/changes/`, per
  [`docs/changes/_template.md`](../../../docs/changes/_template.md), with its
  index row in [`docs/changes/README.md`](../../../docs/changes/README.md)
  added in the same change — for a future product target that meets the
  spec gate (`docs/changes/README.md` §1); a small well-scoped feature needs
  no spec.
- `docs/domains/<context>/domain-model.md`, only as a pointer when a business
  rule is involved; the rule itself is `domain-modelling` work.
- `docs/applications/<component>/02-requirements.md`, when the requirement is
  application-specific and that document already owns it.
- `docs/domains/open-boundaries.md`, only when the unresolved item genuinely
  is a business boundary between contexts.
- README indexes, when a document already covered by an index changes scope.

## Prohibited changes

- Creating a second location for feature specifications, a parallel
  requirements registry, or a new knowledge view. `docs/features/` is the
  one canonical location for the Features view; `docs/changes/` is the one
  location for future targets.
- Writing an unimplemented capability into `docs/features/` as if it existed.
  The Features view records implemented capability only
  ([`docs/features/README.md`](../../../docs/features/README.md)); a future
  target is a Change Specification, and it reaches `docs/features/` through
  canonical promotion and delivery, not through an early edit.
- Defining a new knowledge view, status vocabulary, requirement identifier
  scheme, or label taxonomy.
- Copying the same requirements into an Issue and a document; one owns the
  text and the other points at it.
- Presenting a proposal as a decision, or an inferred user need as a verified
  one.
- Writing a specification that prescribes implementation, schema, endpoints,
  or Nx project layout — those belong to other views.
- Creating a Project, Milestone, label or field as part of this work.

## Evidence to collect

- The request verbatim, and which parts of it are requirements versus
  proposals.
- The audience and the current workaround, with the source of each claim.
- The chosen owning view and the exact document or Issue that will hold the
  text, with the reason it is allowed to hold it.
- Each requirement's verification condition.
- The non-goals and the open questions, each with what would settle it.
- Existing Issues or documents that already cover part of this outcome, with
  their numbers.

## Completion criteria

- The problem is stated without a solution embedded in it.
- The outcome is observable, and each requirement is verifiable without
  guessing the author's intent.
- Non-goals and open questions are explicit.
- The text lives in exactly one allowed location, and any other reference is
  a pointer.
- The record matches reality: implemented capability in `docs/features/`,
  future target in `docs/changes/` as a Change Specification — never a future
  target written into the Features view.
- No new canonical location, view, status or taxonomy was created.
- When a requirement lands in `applications/<component>/02-requirements.md`,
  it states application-specific behaviour and acceptance there only;
  invariants, aggregate rules and domain events stay with `domain-modelling`,
  and the same text is never written in two places.
- The Issue, if that is the record, follows `work-management.md` §2.4 and
  reads as one independently trackable unit.

## Escalation

Stop and report when:

- The only correct home for the content would be a view, area or document
  that does not exist yet, and establishing it has not been decided. Name the
  missing location and stop rather than inventing one.
- The request mixes several independent outcomes. Name them, and let the
  requester pick which one this unit covers.
- A requirement contradicts an accepted ADR, an `A<n>` decision or a system
  invariant. The conflict belongs to `architecture-evolution`, not to a
  rewrite of the requirement.
- A verifiable threshold is needed but no one has supplied one. Ask; do not
  invent a number.
- Two canonical documents disagree about what the product is supposed to do.
  Name both and stop.
