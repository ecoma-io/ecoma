---
name: architecture-evolution
description: Apply when evaluating system architecture — topology, service and deploy-unit boundaries, dependency direction, data ownership across services, cross-service contracts, Nx project tags, or a trade-off between architectural options — and when deciding whether a system-level decision needs an ADR. USE WHEN the question is which constraint decides a design, whether an invariant or accepted decision blocks a change, or where a system-level decision must be recorded. NOT FOR the meaning, aggregates or invariants of a domain model (domain-modelling) — architecture decides placement, dependency direction and whether a boundary exists, not what a contract means; NOT FOR product problem and requirement framing (feature-modelling), implementing the chosen change (delivery-slice), gathering evidence about an unknown (engineering-discovery), or comparing delivered reality with the target (reconciliation).
---

# Architecture Evolution

## Objective

Change the system's architecture deliberately: name the decision, find the
constraint that governs it, compare the real options, and record the outcome
where the policy says it belongs — or record that it is still open. Leave
implementation to a separate unit.

Produce four things:

1. The decision, stated in one sentence, with the deploy units it touches.
2. The invariant, `A<n>` or ADR that constrains it, cited exactly — or the
   statement that none exists and the decision is open.
3. The options compared against stated criteria, including rejected ones.
4. The record required by `docs/AGENTS.md` §10: an ADR, a canonical edit, or
   an open item with a trigger.

## Canonical references

These documents outrank this skill. Where this skill and a canonical document
disagree, the document wins.

- [`docs/architecture/01-architecture.md`](../../../docs/architecture/01-architecture.md)
  — §1 topology, §2 service/deploy boundaries, §4 data ownership, §5
  cross-service communication, §6 security boundaries, §7 hostname/routing,
  §8 decisions `A<n>`, §9 system invariants, §10 unresolved architecture.
- [`docs/architecture/05-code-architecture.md`](../../../docs/architecture/05-code-architecture.md)
  — §1 principles, §2 and §2.1 project structure and deployment, §3
  dependency direction, §4 contracts, §6 tags, §7 dependency rules, §8
  enforcement.
- [`docs/architecture/02-delivery.md`](../../../docs/architecture/02-delivery.md)
  — §7 release and rollout, §9.1 resource ownership, §12 delivery
  uncertainty.
- [`docs/architecture/04-platform-facts.md`](../../../docs/architecture/04-platform-facts.md)
  — verified platform limits only; verify current provider documentation
  before relying on one.
- [`docs/AGENTS.md`](../../../docs/AGENTS.md) — §4 canonical source table,
  §9 artifact lifecycle, §10 ADR governance (trigger, location, numbering,
  index, supersession), §11 proposals and open decisions, §12 deviations.
- [`docs/engineering/evolution-process.md`](../../../docs/engineering/evolution-process.md)
  — §3 (Architecture view ownership), §4.1 (Modelling as an Issue Type
  value), §6.2 (Discover & Model), §6.8 (never implement an unaccepted
  decision), §8 (deviation).
- [`docs/changes/README.md`](../../../docs/changes/README.md) — §1 (the
  four-trigger gate that decides whether a change needs a Change
  Specification), §3 (the three decision states), and the impact classes a
  material change applies to dependent specs.
- [`AGENTS.md`](../../../AGENTS.md) — `Non-negotiable architecture`,
  `Change discipline`, `Source of truth`.

## Required inputs

- The decision being asked for, in the requester's words, and whether the
  request is an outcome or an already-chosen solution.
- The deploy units, bounded contexts and Nx projects the decision touches.
- The current canonical statement of each affected area, read in full.
- Evidence of current behaviour (code, configuration, contracts), kept
  separate from target documents.
- The existing ADRs of the owning context, and `01-architecture.md` §10 for
  whether the item is already open.

## Workflow

1. **Read the canonical architecture before proposing anything.** Target and
   current implementation are different things: documents describe the
   target, code and configuration describe what runs today. Label each claim
   as verified, inferred or unknown.
2. **State the decision in one sentence**, then name its blast radius: which
   deploy units, contexts, Nx projects, contracts and databases change.
3. **Find the governing constraint.** Search §8 for an `A<n>`, §9 for an
   invariant number, and the owning context's `adr/` for an accepted ADR.
   Cite the identifier. A constraint without an identifier is an assumption,
   not a constraint.
4. **Check whether the item is already decided or open.** A superseded
   decision keeps authority only for the parts not superseded. An item in
   §10, `docs/domains/open-boundaries.md`, or a context's open section is open — do not
   implement it and do not write it as settled.
5. **Inspect the project graph rather than assuming it.** The graph, tags
   and deployment map are the machine-readable form of the boundary claims:

   ```bash
   pnpm nx show projects --json
   pnpm nx show project <name> --json
   pnpm nx graph --print
   pnpm dx arch-check
   ```

   State which tags (`scope:*`, `type:*`, `runtime:*`) the change adds or
   moves, and which dependency rules in `05` §7 it relies on. `arch-check`
   runs on the whole workspace, so a tag error elsewhere also fails here.

6. **Compare options against criteria fixed before comparing.** Criteria
   come from the canonical constraints — ownership, failure model,
   reversibility, blast radius, cost, platform limits — not from preference.
   Record rejected options with the criterion that rejected each one.
7. **Decide whether an ADR is required**, using the `docs/AGENTS.md` §10
   criteria: a change to data ownership, storage engine, database or schema
   name, or which context owns a responsibility; a change to a system
   invariant, an `A<n>`, or a published contract's shape; acceptance of a
   deviation that would make canonical docs contradict reality; reversing or
   narrowing an accepted decision. Wording, clarification and cross-reference
   fixes are direct edits, not ADRs.
8. **Write the record at its canonical location.**
   - New ADR → `docs/domains/<context>/adr/`, even for system-wide scope.
     There is no ADR directory under `applications/` and no second global one.
     Number it above every ADR that already exists in the repository; the
     historical overlaps described in §10 must not grow.
   - System-level pointer → `01-architecture.md` §8 gains or updates the
     `A<n>` row that points at the ADR. Do not restate the ADR's reasoning.
   - Change meeting the spec gate — any of the four triggers in
     [`docs/changes/README.md`](../../../docs/changes/README.md) §1, such as
     introducing or retiring a bounded context, moving ownership, or
     changing a shared contract or library → a Change Specification under
     `docs/changes/`, with the change type (introduce, evolve, retire) on
     each Affected scope entry; the canonical documents change at canonical
     promotion, not in the spec's PR. Canonical promotion is atomic at the
     spec's scope: it happens only when the spec's complete scope and
     acceptance/promotion criteria are met, never as an automatic
     consequence of the spec PR merging, a first slice landing, first
     user-visible behaviour, a delivery entering M1, or one of several
     dependent delivery units completing (`docs/changes/README.md` §3/§4).
     Size in PRs is not a trigger: a change
     meeting none of the four is a direct canonical edit or Delivery, and a
     spec written for it is a finding (overengineering). A decision settled
     inside the spec's target scope stays there as an accepted target
     decision — binding only that spec and its explicitly related delivery
     units, while unrelated M1 work keeps the current canonical baseline —
     until canonical promotion, unless it binds the current
     baseline now, in which case it is recorded canonically before or in the
     same logical change as the first change depending on it
     (`docs/changes/README.md` §3).
   - Undecided → `01-architecture.md` §10 with an explicit trigger, or
     `docs/domains/open-boundaries.md` for a business boundary.
   - Index → the context's `adr/README.md` row, in the same change.
9. **Supersede rather than rewrite.** An accepted ADR is never edited to
   make a historical decision read differently. Write a new ADR, update the
   old status line, and name the exact scope superseded in all three places
   §10 requires.
10. **Route implementation and impact separately.** Hand the accepted
    decision to `delivery-slice`; a decision is not implemented here, and an
    ADR records the decision, not a capability state. When the decision is a
    material change for dependent Change Specifications — it shifts the
    baseline, supersedes an accepted decision, changes a committed
    Milestone's scope, or alters a shared contract, library or bounded
    context — hand the impact assessment to `change-impact`; its verdicts use
    the impact classes in `docs/changes/README.md`, never the reconciliation
    classes.

## Allowed changes

- Canonical architecture documents under `docs/architecture/`.
- A Change Specification under `docs/changes/` and its index row, when the
  change introduces, evolves or retires capability or architecture as a
  design-ahead target rather than a direct canonical edit.
- A new ADR, the superseded ADR's status line, and its index rows.
- `docs/domains/open-boundaries.md`, and a context's open section, only when the
  item genuinely is that kind of record.
- `README.md` indexes when a document is added or renamed, in the same change.
- Issue and PR prose that states the decision, the options and the evidence.

## Prohibited changes

- Changing a data owner or a storage engine without the ADR that decision
  requires.
- Rewriting an accepted ADR, or editing one so it matches the code.
- Adding an ADR directory in a new location, or renumbering existing ADRs.
- Asserting a capability state (`Specified`, `Implemented`, `Verified`,
  `Released`) inside an ADR or an architecture document.
- Implementing the change in this skill, or opening implementation before the
  decision is accepted.
- Copying the same decision into several documents instead of pointing at one.
- Stating a platform limit from memory; `04-platform-facts.md` is
  time-sensitive and must be re-verified against provider documentation.
- Inventing a new decision identifier, tag dimension or status vocabulary.

## Evidence to collect

- The quoted canonical statement of the target, with path and section.
- The `A<n>`, invariant number, ADR number, or open-section item that governs
  the decision — or the explicit statement that none exists.
- The `nx graph --print` and tag facts the boundary argument depends on, and
  the `pnpm dx arch-check` result.
- The options considered, with the criterion that decided between them.
- For a new ADR: its number, the enumeration proving it is the next one
  above every existing ADR, and the index rows updated.
- What remains open after the change, and where each item is tracked.

## Completion criteria

- The decision, its scope and its governing constraint are stated with exact
  identifiers.
- Options are compared against pre-stated criteria; rejected options are
  named.
- The record exists at the canonical location §10 defines, with correct
  numbering, header convention and index row.
- No accepted ADR was rewritten; supersession names its exact scope.
- No capability state was asserted, and no decision was implemented.
- The change is one reviewable logical change that will pass
  `pnpm dx pr-check`.

## Escalation

Stop and report when:

- The change moves a data owner or a responsibility between contexts and no
  architecture record backs it. The architecture owner decides first.
- The work depends on an item that is open in §10 or `docs/domains/open-boundaries.md`.
  Record it, keep it open, and move to another unit.
- Two accepted records constrain the change in opposite directions. Name both
  and the conflict; do not pick a winner quietly.
- The decision needs a platform fact that cannot be verified currently.
- The requested change is product framing or a single context's domain model,
  which belong to `feature-modelling` and `domain-modelling`. Say so instead
  of modelling it here.
