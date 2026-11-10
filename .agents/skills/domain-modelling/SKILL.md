---
name: domain-modelling
description: Apply when discovering or evolving a bounded context's domain model — boundary and ownership, aggregates, invariants, domain events, provider-owned contracts, or the ADRs that constrain them. USE WHEN the answer changes what a context owns, what a rule means, what state an aggregate guarantees, what event or contract crosses a context edge, or when a requirement needs a domain design. NOT FOR the shape of a contract crossing a boundary, dependency direction or deploy-unit topology (architecture-evolution) — model the meaning and invariants of a contract this context owns, not where it is placed; NOT FOR application composition, product capability framing (feature-modelling), implementation of the model in code (delivery-slice), or collecting evidence about an unknown (engineering-discovery).
---

# Domain Modelling

## Objective

Change the domain model deliberately, at its canonical location, with the
decision recorded — and leave implementation to a separate unit. A model
change is a specification or ADR change; code that behaves differently is not
a model change until the model says so.

A bounded context that does not exist canonically yet is modelled in a Change
Specification under [`docs/changes/`](../../../docs/changes/README.md): the
**introduce** change type carries the full target model, **evolve** carries
the delta plus the target state, **retire** carries the removal scope and the
post-retire state ([`_template.md`](../../../docs/changes/_template.md) §5).
Canonical promotion moves the model into `docs/domains/<context>/` —
explicitly, never automatically on PR merge: the owning documents are
updated, the ADRs `docs/AGENTS.md` §10 triggers are written, and the domains
catalog and context map gain the context. Until that promotion, a pending
introduce is indexed only in `docs/changes/README.md`, never in the domains
catalog.

Produce:

1. The owning bounded context and the exact section being changed.
2. The model delta: boundary, aggregate, invariant, event or contract shape.
3. Separation of what is decided from what stays open.
4. The record: specification edit, ADR, and index update.

## Canonical references

These documents outrank this skill. Where this skill and a canonical document
disagree, the document wins.

- [`docs/engineering/evolution-process.md`](../../../docs/engineering/evolution-process.md)
  — §3 (view Domains and what it owns; contracts are provider-owned), §4.1
  (Modelling ends when a specification or ADR is accepted; a docs-only PR is
  Modelling, a PR that changes behaviour and its own documentation is one
  Delivery), §6.2 (Discover & Model), §7 (prerequisite work: a contract or
  model that no application consumes yet is `Implemented, not verified`),
  §8.2 (temporary limitation versus accepted deviation).
- [`docs/AGENTS.md`](../../../docs/AGENTS.md) — §3 (`domains/` scope, the
  shared domain language in `docs/domains/glossary.md`, the rule that a deploy unit
  does not create a context), §4 (canonical source table, including
  machine-readable contract as the owner of exact shapes), §5 (README index
  updated in the same change), §6 (no proposal becomes a decision without an
  ADR or a canonical update), §9 (specification and ADR lifecycles), §10 (ADR
  governance: when an ADR is required, location, numbering, index, partial
  supersession), §11 (open, deferred and proposed decisions), §12
  (deviation).
- [`docs/domains/README.md`](../../../docs/domains/README.md) — §1.1 (bounded
  context versus deploy unit, Nx scope and deployment project), §1.2 (no
  implementation-status columns), §2 (shared domain language), §3 (context
  catalog), §4 (context map), §5 (undecided business boundaries), §8
  (decision register).
- [`docs/architecture/01-architecture.md`](../../../docs/architecture/01-architecture.md)
  — §4 (data ownership), §8 (system decisions `A<n>`), §9 (invariants).
- [`docs/architecture/05-code-architecture.md`](../../../docs/architecture/05-code-architecture.md)
  — §4 (contracts), §6.3 (Nx scope is not the same axis as the bounded
  context catalog), §7 (dependency rules).
- [`docs/changes/README.md`](../../../docs/changes/README.md) — the Change
  Specification that carries a context's model before canonical promotion;
  its catalog rule (a pending introduce is indexed only here) and its
  promotion rules.
- [`AGENTS.md`](../../../AGENTS.md) — `Non-negotiable architecture` (one
  service owns each database; cross-service communication uses contracts).

## Required inputs

- The capability or question under modelling, with its owning context already
  identified by `engineering-understanding`.
- The current specification of that context and its ADR index, read in full
  for the sections touched.
- The open and deferred items the change interacts with.
- The evidence behind the need: a Discovery conclusion, an Experiment result,
  a reconciliation gap, or an explicit user requirement.
- For a contract change: the machine-readable contract that currently owns
  the exact shape.

## Workflow

1. **Read the owning context specification before proposing anything.** Note
   the boundary, the entities and value objects, the invariants, the domain
   operations, and the open decisions section. Do not propose from memory or
   from another context's shape.
2. **Map the change onto the context map.** Check
   [`docs/domains/context-map.md`](../../../docs/domains/context-map.md) for
   the relations involved and
   [`docs/domains/open-boundaries.md`](../../../docs/domains/open-boundaries.md)
   for whether the boundary is already open. A change that moves
   responsibility between contexts starts here, not in code. When the context
   does not exist canonically yet, the modelling vehicle is a Change
   Specification under `docs/changes/`, not a new `docs/domains/<context>/`
   directory — that directory is created by canonical promotion.
3. **Separate decided from open.** For each element of the delta, mark it
   _decided by_ (an ADR, an `A<n>`, an accepted requirement) or _open_. Open
   items stay in the owning open section — never in a new register, and never
   silently resolved by the wording of the change.
4. **Express the delta in domain terms.** Boundary and ownership, aggregate
   and its invariants, state transitions, domain events, error conditions,
   and the contract at the context edge. Exact payload shape belongs to the
   machine-readable contract, not the prose.
5. **Check the ADR trigger.** Write a new ADR when the change alters data
   ownership, storage engine or database/schema name, which context owns a
   responsibility, a system invariant or `A<n>`, or a published contract's
   shape — or when it reverses or narrows an accepted decision. Otherwise a
   direct edit to the canonical document is the record.
6. **Write the record at its canonical location.**
   - Business model change → `docs/domains/<context>/domain-model.md`. It
     carries business knowledge only; runtime, storage, protocol and
     deployment mechanics belong to `docs/applications/<component>/`.
   - Not-yet-canonical context → a Change Specification under
     `docs/changes/`, following
     [`_template.md`](../../../docs/changes/_template.md): introduce carries
     the full target model, evolve the delta plus target state, retire the
     removal scope and post-retire state. Add the spec's index row to
     `docs/changes/README.md` in the same change; the domains catalog and
     context map change only at canonical promotion.
   - Decision → a new ADR under `docs/domains/<context>/adr/`, numbered
     above every ADR already in the repository, with the header convention of
     the directory it joins.
   - Index → the context's `adr/README.md` row and the context `README.md`,
     updated in the same change per `docs/AGENTS.md` §5 and §10.
   - Boundary change → `docs/domains/open-boundaries.md`, with the old text
     replaced by a pointer, not duplicated.
   - Shared term → `docs/domains/glossary.md`; semantic relation →
     `docs/domains/context-map.md`.
7. **Supersede rather than rewrite.** An accepted ADR is never edited to
   change its decision. Write a new ADR, update the old status line, name the
   exact scope superseded, and carry the partial-supersession note in the
   index and the new body.
8. **State the shift to implementation.** Note which capability target the
   model now specifies, which parts remain unimplemented, and which delivery
   slices consume it. That note belongs in the Issue or PR, not in the domain
   document — domain documents carry no implementation status.
9. **Route the implementation separately.** Hand the model to `delivery-slice`
   as a Delivery unit. A PR that changes code and also updates the
   specification it implements is one Delivery; a PR that only changes the
   model is Modelling.

## Allowed changes

- `docs/domains/<context>/domain-model.md` — business knowledge only. Runtime,
  storage, protocol and deployment mechanics belong to
  `docs/applications/<component>/`.
- A Change Specification under `docs/changes/` and its index row in
  `docs/changes/README.md`, when the context or model does not exist
  canonically yet.
- New ADRs, old ADR status lines for supersession, and ADR index rows.
- `docs/domains/open-boundaries.md` when the change really is a boundary
  change; `docs/domains/glossary.md` and `docs/domains/context-map.md` for a
  new shared term or semantic relation.
- Context `README.md` indexes, in the same change that adds or renames a
  document.
- Issue and PR prose that states the model delta, its limits and its evidence.

## Prohibited changes

- Creating a new bounded context without architecture backing: the catalog
  admits one only when the architecture docs define new business
  responsibility and data ownership.
- Indexing a pending introduce in the domains catalog or context map before
  canonical promotion: until then, `docs/changes/README.md` is the only index
  entry the context has.
- Treating a merged Change Specification as a completed canonical promotion.
  Promotion is an explicit later step — it never happens automatically on PR
  merge.
- Rewriting or deleting an accepted ADR to change its decision. Supersede it.
- Putting implementation status, progress, or a "done/not done" column into
  domain documents.
- Changing a published contract's shape without the ADR that decision
  requires.
- Cross-context database access, or moving data ownership without an ADR and
  an architecture update.
- Splitting a context because one deploy unit exists, or treating an Nx
  scope as the catalog entry.
- Promoting a proposal to a decision without an ADR or a canonical update.
- Writing code in this skill. Implementation is `delivery-slice`.

## Evidence to collect

- The owning context and the exact sections read, with their current status.
- The ADR or `A<n>` that decides each element of the delta, or the explicit
  statement that none exists and an ADR is required.
- The Discovery, Experiment or reconciliation result that motivates the
  change, by Issue or PR number.
- The machine-readable contract that owns the exact shape, when the edge is
  a contract.
- The open and deferred items still open after the change, with where each is
  tracked.

## Completion criteria

Deliver when:

- The specification is edited at its canonical location, or the ADR is
  written, with no duplicated copy elsewhere.
- Every decided element names its deciding record; every open element sits
  in the owning open section.
- An ADR exists wherever §10 requires one; numbering and index rows are
  correct; supersession names its exact scope.
- The context README and any affected index reflect the change in the same
  diff.
- When the model rode a Change Specification, the promotion state is stated:
  promoted — owning documents, the ADRs §10 triggers, the catalog and the
  context map updated — or pending, indexed only in
  `docs/changes/README.md`, with the explicit follow-up recorded.
- No implementation status entered a domain document.
- The implementation handoff is stated: capability target, open parts, and
  the delivery unit that consumes it.
- The documentation change is ready to pass `pnpm dx pr-check` as one
  reviewable logical change.

## Escalation

Stop and report when:

- The change moves data ownership or a responsibility across contexts, or
  requires a new bounded context, and the architecture documents do not back
  it. The architecture owner decides first.
- The change depends on an open boundary in `docs/domains/open-boundaries.md`.
  Record it, keep it open, and move to another unit.
- Two accepted records constrain the change in opposite directions. Name both
  ADRs and the conflict; do not choose quietly.
- The model would have to encode a product capability, which belongs to
  `docs/features/`, or application composition, which belongs to
  `docs/applications/`.
- The requested change is really application composition or runtime topology,
  which belongs to another view. Say so instead of modelling it here.
