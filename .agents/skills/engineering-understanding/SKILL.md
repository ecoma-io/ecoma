---
name: engineering-understanding
description: Apply at the start of any non-trivial request, before planning or editing — when the task is new, ambiguous, or touches an area you have not yet located in the repository. Establish the owning knowledge view, the constraints in force, what the code actually does today, and the Issue Type. USE WHEN asked to understand or scope work, when unsure which document owns a capability, when a request could fit several Issue Type values, or before opening an Issue or writing a plan. NOT FOR searching GitHub, writing or filing an Issue (github-issue) — run this skill first when the request is unclear, then hand the Issue itself to `github-issue`; NOT FOR product problem or requirement framing (feature-modelling), gathering evidence or running measurements (engineering-discovery), deciding a domain or architecture design (domain-modelling), implementing a change (delivery-slice), verifying a result (verification), or reconciling after merge (reconciliation).
---

# Engineering Understanding

## Objective

Turn a request into a sourced understanding before anyone plans or changes
anything. The output is not prose for its own sake: it is the input the next
step consumes — an Issue body, a plan, or a decision to investigate further.

Produce five things:

1. The question, stated so it can be answered.
2. The owning knowledge view and its canonical location.
3. The constraints that apply, each with a source.
4. The Issue Type, chosen by the nature of the change — plus the unknown list.
5. The work's context, when applicable: the product, its horizon, the
   authoritative baseline, and the Change Specifications in force.

## Canonical references

These documents outrank this skill. Where this skill and a canonical document
disagree, the document wins.

- [`docs/engineering/evolution-process.md`](../../../docs/engineering/evolution-process.md)
  — §3 (four knowledge views and what each owns), §4.1 (the five Issue Type
  values and the priority order for choosing one), §5 (capability states; the
  authoritative baseline is the canonical documents plus accepted ADRs, never
  a Change Specification), §6.1 (the Understand step: input, activity, output,
  completion condition), §6.3 (gap classification before selection), §6.8
  (what the loop may and may not do while Delivery runs).
- [`docs/AGENTS.md`](../../../docs/AGENTS.md) — §2 (documentation principles),
  §3 (document scope per axis, including `changes/`), §4 (canonical source
  table: exactly one owner per fact or decision), §5 (index maintenance), §11
  (proposals, open and deferred decisions).
- [`AGENTS.md`](../../../AGENTS.md) — `Source of truth` (code defines current
  behaviour; docs describe target), `Non-negotiable architecture`, `Change
  discipline`, `Workflow`.
- [`docs/architecture/01-architecture.md`](../../../docs/architecture/01-architecture.md)
  — §8 (architectural decisions `A<n>`), §9 (system invariants), §10
  (unresolved architecture).
- [`docs/engineering/work-management.md`](../../../docs/engineering/work-management.md)
  — when an Issue must exist, what "independently trackable" means, when to
  reuse one, §2.3 (how the Issue Type is recorded, across the three
  windows: the `## Loại công việc` body channel before org configuration,
  native Issue Type authoritative after it while form-created issues still
  record through the body channel, native-only after cleanup), §4 (product
  attribution and Milestone delivery commitments — single-product or
  cross-product), §4.1 (the Product Registry that owns product identity,
  and horizons read from the Milestone commitment declarations), §4.2
  (milestone completion, activation and release as independent states).
- [`docs/changes/README.md`](../../../docs/changes/README.md) — Change
  Specification vocabulary: change types, material changes, the two
  promotions, and the index of live specs.
- [`docs/engineering/contribution-workflow.md`](../../../docs/engineering/contribution-workflow.md)
  — how an understood unit moves into planning, execution and review.

## Required inputs

- The request, verbatim, including anything the user said about priority or
  scope. Do not paraphrase away a constraint.
- The area named or implied: an Nx project, bounded context, deploy unit,
  document, or repository-wide concern.
- Read access to the repository and to the GitHub API (`gh`), or an explicit
  statement that one is unavailable.
- Knowledge of whether this is exploratory (scope unclear) or well-defined
  implementation work — if unclear, treat it as exploratory.

## Workflow

1. **State the question in one sentence.** Separate what the user asked for
   from what you inferred from it. If the request contains several outcomes,
   name them and pick the unit that can be tracked independently.
2. **Locate the owning view.** Use the `docs/AGENTS.md` §4 table. If two views
   could own the same fact, name both and say which one wins, linking the
   section that decides ownership. A request that maps to the Features view
   belongs in `docs/features/<area>/<feature>.md`, following
   [`docs/features/_template.md`](../../../docs/features/_template.md).
3. **Read the canonical document for the target.** Note what it says, its
   status (accepted, proposed, open, deferred, superseded), and any cross
   reference it defers to. An ADR superseded in part keeps authority only for
   the parts not superseded.
4. **Read code and configuration for current behaviour.** Docs describe
   target; only source, schema, contract and configuration show what runs
   today. Useful reads:
   - `pnpm nx show projects` and `pnpm nx show project <name>` for resolved
     project configuration and targets.
   - `pnpm nx graph --print` for dependency edges.
   - `git log` / `git blame` on the affected paths when the reason behind a
     shape matters.
   - `pnpm dx arch-check` when ownership tags or the deployment map are part
     of the question.
5. **List the constraints with their source.** Each line names the constraint
   and where it comes from: an `AGENTS.md` rule, an `A<n>` decision, an
   invariant number, an ADR, a dependency rule, or a platform fact. A
   constraint without a source is an assumption, and belongs in step 8.
6. **Place the work in its context**, when the request has one:
   - The **product attribution** and the **horizon**. Product identity comes
     from the Product Registry owned by `work-management.md` §4.1 (stable
     product IDs) — never from `docs/features/README.md` feature areas,
     feature directory names, bounded contexts, Nx projects, applications,
     issue counts or Milestone titles; applications of a product are not
     products; a product ID stays valid with no implemented Feature document.
     Attribute the unit to one product, to one explicitly identified shared
     context, or — for a cross-product root issue — name the participating
     products instead of picking one global product (§4). The horizon is
     read from the product's Milestone commitment declarations per §4.1 —
     never from creation order, due dates, names or issue counts, and not
     from a document marker. A Milestone is a product-independent delivery
     commitment: it may carry one product or several, participating in a
     cross-product milestone does not merge horizons or release schedules,
     and milestone completion implies neither activation nor release (§4,
     §4.2). Shared or cross-cutting work has no product pipeline of its
     own: associate it with the driving pipeline's product ID, name the
     shared context explicitly, or leave it unassigned when no pipeline
     genuinely drives it; ambiguity is reported with the evidence read,
     never guessed. Work feeding a product's future horizon (Feature
     Discovery) is normal, not misplanned.
   - The **authoritative baseline** the work stands on: the canonical
     documents of the four views plus accepted ADRs (`evolution-process.md`
     §5). A Change Specification is design-ahead, never baseline.
   - The **applicable Change Specifications**, found through the index in
     `docs/changes/README.md` and read for their Baseline references and
     Dependencies.
7. **Classify the Issue Type** using the priority order in
   `evolution-process.md` §4.1, stopping at the first match: Remediation →
   Experiment → Modelling → Delivery → Discovery. State which rule matched
   and why each earlier value did not. Classify by the nature of the change,
   never by size or by who performs it; the classification is recorded as the
   Issue Type per `work-management.md` §2.3, not in a label or a Project
   field.
8. **Record the unknowns.** For each: what is unknown, why it blocks a
   decision, and what evidence would settle it. Separate _unknown_ from
   _inferred_ and from _verified_. Unknowns that need existing evidence, or a
   new measurement, are the input to `engineering-discovery`.
9. **Produce the output** in the form the next step needs: an Issue body
   (Vietnamese, per `AGENTS.md` `Language`, using the `github-issue` skill),
   or a short plan linked to the request. Keep the evidence with the claim.

## Allowed changes

- Read any repository file, run read-only inspection commands, and read
  GitHub Issues, PRs and metadata.
- Draft the Issue body or plan text, and post it through `github-issue` when
  the request authorizes creating an Issue.
- Record unknowns and assumptions in the Issue, not in canonical documents.

## Prohibited changes

- Writing or modifying implementation code, tests, configuration or
  migrations. Understanding ends before execution.
- Creating an Issue without searching existing Issues and PRs first.
- Treating a document as evidence of current behaviour. `docs/features/`
  records implemented capability only, not a place to park an answer; and a
  Change Specification, even an accepted one, is design-ahead — never evidence
  that behaviour exists.
- Resolving an open decision, or presenting an inference or a proposal as a
  verified fact or an accepted decision.
- Choosing an Issue Type because it is convenient, or because a later value
  in the priority order sounds more impressive. §4.1 order is the only rule.
- Inventing a constraint, a label, a milestone, an assignee, a project field
  or a substitute classification — including GitHub's default Task/Bug/Feature
  types as stand-ins for the five canonical values. Before org configuration
  the `## Loại công việc` body channel is the authorized recording channel;
  report a blocker only when the requested classification or native GitHub
  capability has no documented recording channel at all
  (`work-management.md` §2.3).

## Evidence to collect

- The canonical location for each claim: file path and section, or ADR number
  with status and owning context when the number is ambiguous.
- The code or configuration locator for each statement about current
  behaviour: `file:line`, project name, or resolved `nx show project` output.
- The command and output behind any workspace fact you rely on.
- The Issue or PR number behind any prior decision you cite.
- The context when applicable: which Milestones the horizon was derived from,
  and which Change Specifications apply, by file name.
- An explicit list of what remains unknown, with the evidence that would
  settle each item.

## Completion criteria

Deliver the understanding only when:

- The question is one sentence and matches what the user asked.
- The owning view is named, with its canonical location, or the gap is stated
  as a gap.
- Every applicable constraint has a source; assumptions are labelled.
- Current behaviour is separated from documented target.
- The Issue Type is justified against §4.1, including why earlier values did
  not apply, and its recording path follows `work-management.md` §2.3.
- The context is stated when applicable: product attribution (one product,
  one shared context, or the participating products of a cross-product root
  issue), horizon, authoritative baseline, and the applicable Change
  Specifications.
- Unknowns have an owner step: `engineering-discovery`, an experiment, or an
  escalation.
- The next action is named: create/reuse an Issue, plan a delivery slice, or
  stop for a decision.

## Escalation

Stop and report instead of guessing when:

- The request conflicts with a non-negotiable rule or an accepted decision.
  Name both sides and the document that governs.
- Ownership is genuinely ambiguous, or the answer would require a view,
  document or area that does not exist yet.
- Progress requires an open decision to be settled. Record it, name where it
  is tracked, and move to another unit — do not implement around it.
- The request has no observable outcome, or several unrelated outcomes.
- Repository or GitHub access is unavailable, so current behaviour or prior
  work cannot be checked. State what could not be verified.
