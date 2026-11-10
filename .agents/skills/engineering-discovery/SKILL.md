---
name: engineering-discovery
description: Apply when an unknown from understanding or planning must be reduced before a decision can be made. Two modes — Discovery collects and evaluates evidence that already exists (code, configuration, contracts, docs, ADRs, git history, Issues, runtime state); Experiment creates new evidence by running something under fixed, pre-declared criteria. USE WHEN stuck on "which is true", "does this exist", "which direction is cheaper", or when a hypothesis needs a controlled measurement. NOT FOR deciding a design (domain-modelling), implementing the chosen slice (delivery-slice), verifying a delivered change (verification), or reconciling target against reality after merge (reconciliation).
---

# Engineering Discovery and Experiment

## Objective

Reduce an unknown to the point where a direction can be chosen or rejected,
and record the result where the decision will look for it. Evidence comes
first; a conclusion without evidence is a guess with better formatting.

This skill owns two distinct activities. Pick the mode before doing any work:

| Mode           | Source of evidence           | Ends when                                       | Artifact                                                       |
| -------------- | ---------------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| **Discovery**  | Already exists               | Enough to choose or reject a direction          | Issue with evidence and conclusion; no production change       |
| **Experiment** | Created by running something | Hypothesis supported, rejected, or inconclusive | Issue with criteria, experiment code on a branch, and a result |

Discovery finds existing evidence. Experiment creates new evidence by running
something. If the answer is already written down, measured, or visible in
state somewhere, it is Discovery. Only build an experiment when no existing
evidence can answer the question.

The two modes are the Issue Type values **Discovery** and **Experiment**
(`evolution-process.md` §4.1): the mode chosen here is the type the owning
Issue carries, recorded per `work-management.md` §2.3. Discovery feeding a
product's future horizon (Feature Discovery) is normal work, not misplaced
effort — the product's identity comes from the Product Registry owned by
`work-management.md` §4.1, never from `docs/features/README.md` feature
areas, feature directory names, bounded contexts, Nx projects or
applications, and horizons are read from the product's Milestone commitment
declarations (`work-management.md` §4.1).

## Canonical references

These documents outrank this skill. Where this skill and a canonical document
disagree, the document wins.

- [`docs/engineering/evolution-process.md`](../../../docs/engineering/evolution-process.md)
  — §4.1 (Discovery and Experiment as Issue Type values; Experiment never
  enters the production path — it lives on a branch and is not merged), §6.1
  (unknowns come out of Understand), §6.2 (Discover & Model: Discovery finds
  evidence, Modelling changes the spec, Experiment answers a technical
  question), §6.8 (an open decision stays open until evidence settles it).
- [`docs/AGENTS.md`](../../../docs/AGENTS.md) — §11 (proposal, accepted
  decision, unresolved boundary and deferred decision; the `Experiments`
  subsection lists the six parts a durable record needs), §9 (artifact
  lifecycle, including the Experiment states planned → running → concluded),
  §6 (do not promote an unaccepted option to a decision).
- [`docs/architecture/04-platform-facts.md`](../../../docs/architecture/04-platform-facts.md)
  — verified platform facts with source, date and confidence. A platform claim
  not recorded there is not a fact; check current provider documentation
  before relying on it.
- [`AGENTS.md`](../../../AGENTS.md) — `Source of truth`, `Non-negotiable
  architecture`, `Workflow`.
- [`docs/engineering/work-management.md`](../../../docs/engineering/work-management.md)
  — whether the unknown needs its own Issue, how to reuse an existing one,
  §2.3 (how the Issue Type is recorded), §4.1 (the Milestone commitment
  declarations behind the horizon a Discovery may be feeding).
- [`docs/changes/README.md`](../../../docs/changes/README.md) — a conclusion
  that shifts a target is a material change; impact classes govern what it
  does to dependent Change Specifications.

## Required inputs

- The unknown, with why it blocks a decision and what decision it feeds.
- The evidence already checked, so the search does not repeat it.
- The constraints the answer must respect: invariants, ADRs, platform facts.
- For an Experiment: an environment where the measurement can run, the
  versions involved, and permission to put code on a throwaway branch.

## Workflow

Run exactly one of the two sub-workflows below. They share a start — the
unknown and the decision it feeds — and never run in the same pass.

### Discovery workflow

1. **Restate the question so it can be answered yes/no or with a value.**
   "Is the outbox relay implemented for this context?" is answerable;
   "how does messaging work?" is not.
2. **Search in decreasing order of authority.** Canonical documents and ADRs
   first, then machine-readable contracts, then source and configuration,
   then git history and merged PRs, then Issues and comments, then runtime
   or deployment state when it is observable. Record where you looked.
3. **Judge the source.** Note whether it is accepted or proposed, current or
   superseded, code or documentation, verified or inferred. An accepted ADR
   is authoritative for a decision; source code is authoritative for current
   behaviour; neither is authoritative for the other.
4. **Read the evidence, not its title.** Open the file, the ADR body, the
   contract, the Issue body. A file name or a merged PR title is not evidence
   of behaviour.
5. **State the conclusion with its evidence.** One conclusion, the locators
   that support it, and the confidence: verified, inferred from named
   evidence, or inconclusive because a source could not be read.
6. **Stop when the direction can be chosen or rejected.** Do not keep
   searching for completeness. Further evidence that would not change the
   decision is out of scope.
7. **Record the result in the Issue that owns the question**, using
   Vietnamese prose and keeping identifiers, paths and commands in English.
   If the finding changes the target, it moves to `domain-modelling` or an
   ADR — the Discovery record never replaces the decision.

### Experiment workflow

1. **Write the hypothesis and the question it answers** before anything runs.
   State what would count as support and what would count as rejection.
2. **Fix the evaluation criteria before running.** Name the metric, the
   threshold, the pass/fail rule and the comparison baseline. Criteria
   written after the run are not criteria.
3. **Define scope and environment.** What is measured, on which environment,
   with which versions of the runtime, dependencies and tools. Record how the
   environment differs from the target environment.
4. **Build the experiment where it cannot ship.** Code lives on a branch and
   is not merged, per `evolution-process.md` §4.1. If the measurement
   requires merging, it is a Delivery with a measurement criterion, not an
   Experiment — say so and hand it to `delivery-slice`.
5. **Run it and capture raw output.** Commands, versions, timings and
   observed values, not a summary of intent. A number appears only when it
   was measured.
6. **Apply the criteria as written.** Conclusion is exactly one of
   _supported_, _rejected_ or _inconclusive_. Inconclusive is a valid result;
   it is never a soft yes.
7. **Link the result to the decision it informs**, the follow-up work, and
   the Issue that owns the question. A conclusion that changes the target
   becomes an ADR or a canonical update through `domain-modelling`; the
   experiment record is linked from it and never substitutes for it. When a
   Change Specification depends on the result, the shifted target is a
   material change: classify its effect on the dependent specs with the
   impact classes in [`docs/changes/README.md`](../../../docs/changes/README.md)
   (the `change-impact` skill) rather than editing the specs inline.

## Allowed changes

- Read repository files, contracts, history, Issues, PRs and metadata.
- Run read-only inspection commands and existing test targets
  (`test`, `test-integration`, `system-test`) to observe behaviour.
- For an Experiment: add throwaway code on a dedicated branch, and write the
  result into the owning Issue or a dedicated evidence document when the
  conclusion must outlive the Issue (`docs/AGENTS.md` §11).
- Update the Issue with evidence, conclusion and links.

## Prohibited changes

- Inventing measurements, numbers, versions, benchmarks or observed output.
- Reinterpreting criteria after the run, or reporting a result that the raw
  output does not show.
- Merging experiment code into the default branch, or wiring it into a
  production path, a deploy unit, or serving configuration.
- Turning an inconclusive result into a decision, or leaving an inconclusive
  result as an implicit assumption in code.
- Editing an accepted ADR or a canonical document to match the finding
  instead of recording a new decision.
- Promoting a proposal or a spike alternative to a committed decision.

## Evidence to collect

- The question, in answerable form, and the decision it informs.
- Every source checked, with a locator: path and section, ADR number with
  owning context, project name, commit hash, Issue or PR number.
- The authority status of each source: accepted, proposed, superseded,
  verified, inferred.
- The conclusion with its confidence, and the explicit unknowns that remain.
- For an Experiment: hypothesis, criteria fixed before the run, environment,
  versions, raw output, and the supported/rejected/inconclusive result.

## Completion criteria

Deliver when:

- The unknown is reduced enough to choose or reject a direction — or is
  explicitly recorded as still open.
- Each conclusion cites the evidence and names its confidence level.
- Discovery made no production change; Experiment code exists only on an
  unmerged branch.
- Experiment criteria are the ones declared before the run, and the result
  is one of the three permitted conclusions.
- The owning Issue reflects the result, and the decision this informs is
  linked.

## Escalation

Stop and report when:

- The question cannot be answered from existing evidence and cannot be
  measured in an environment you can safely use.
- Answering requires a production credential, production data, or access the
  session does not have.
- The experiment would have to merge to be measurable, so it is really a
  Delivery and needs its own Issue and scope.
- A source conflicts with another source of equal authority. Name both and
  the documents that govern.
- The result is inconclusive and a decision is still expected from you.
  Report inconclusive; do not upgrade it.
