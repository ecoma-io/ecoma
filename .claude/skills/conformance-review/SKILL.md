---
name: conformance-review
description: Adversarial review of whether this workspace matches what it declares — its gates against the rules they claim to enforce, its docs against its code, its configuration against its single sources, and its implementation against the published doctrine ceiling (two-way traceability) — using the conformance rubric in `references/rubric.md`. Use when asked to review, audit, attack, or assess the repo/workspace as a whole, to check that the code still serves the published ceiling, or before trusting the workspace with a new subsystem. Not a diff review (`/preflight`, `/code-review` own those) and not a review of the doctrine itself (`/doctrine-review` owns the published tree).
---

# Conformance review (Ecoma)

One question, asked of the whole workspace: **does reality match what this
repository declares?** Gates against the rules they claim to enforce, docs
against the code, config against its single sources, and the implementation
against the published doctrine ceiling.

Three documents, three owners. [`review-constitution.md`](../../../shared/libs/doctrine/method/review-constitution.md)
owns the judgment laws and the shape of a run. The rubric
([`references/rubric.md`](./references/rubric.md)) owns this object's criteria,
its severity tests, and the `DECLARED` verdict a repository needs. **This file
owns only the procedure** — which level, in which order, and what counts as proof
a run happened. Never restate a criterion or a law here: a second copy is a
second rule and no reader can tell which one binds. If the rubric is hard to run
from, fix the rubric.

Read the constitution's laws and the rubric's Part I before judging anything. A
finding written before you know the severity test and the `DECLARED` rule has to
be rewritten, and so does one written before you know that a killed suspicion is
recorded rather than dropped (the constitution's WITHDRAWN law).

Its sibling reviews the other side of the same relationship: `/doctrine-review`
judges the ceiling against itself — whether the design is coherent. This one
never re-litigates that. It takes the ceiling as given and asks what the
workspace did with it.

## 1. Open on green, or you are judging a known-broken tree

```bash
pnpm nx run-many -t lint test typecheck build --skip-nx-cache
node shared/tools/dev-cli/src/main.mjs check-journey-markers-workspace
node shared/tools/dev-cli/src/main.mjs check-doc-links
node shared/tools/dev-cli/src/main.mjs check-claude-md
node shared/tools/dev-cli/src/main.mjs check-doctrine
node shared/tools/dev-cli/src/main.mjs check-practice-index
node shared/tools/dev-cli/src/main.mjs check-subsystem-readmes
node shared/tools/dev-cli/src/main.mjs check-subproject-readmes
node shared/tools/dev-cli/src/main.mjs check-project-conventions
```

This is the constitution's gates-first step, with this workspace's gate list
filled in. What it means here: every criterion in the rubric exists because these
gates cannot see it.

## 2. Name the protocol level, in the report

- **spot** — one criterion group, or one suspicion. Owes that group's evidence.
- **area** — one subsystem or one concern (all gates, the supply chain, one
  spec's trace). Owes phases 1–3 scoped to it, plus one walk.
- **full** — the whole workspace. Owes every phase including the two-way trace,
  plus one probe never run before.

These are the levels the constitution's declare-your-level step refers to for
this object. Naming one in the report is that step's requirement, not this
file's.

## 3. The phases this object owes, in the order the constitution fixes

1. **Inventory, derived not remembered.** Enumerate projects, targets, tags,
   gates and their invocation sites, workflow triggers and permissions, doc
   tiers, root config files and their consumers, and the published documents in
   `shared/libs/doctrine/**`. Derive every list from the tree or the graph — a
   list you recall is a list from the last repository you read.
2. **Claim harvest.** Grep the prose for every "must / never / always / the only
   / exactly one". Each becomes two questions: who owns it, and is it true right
   now. This phase produces most DT and GA findings and produces them cheaply.
3. **Cross-file invariants.** Copied values, peer asymmetries between projects
   of the same kind, config pairs held together by human memory. Compare
   siblings against each other — a defect invisible in one file is obvious
   beside its peer.
4. **Trace the ceiling both ways.** Forward: each mechanism the published
   documents declare → the code that implements it, the loud seam that stands in
   for it, or the written absence. Backward: each unit of product code → the
   promise it serves. The artifact is a table with both columns filled and every
   blank cell named. Two things this phase must refuse: reading a mechanism's
   presence off a document that merely mentions it, and reporting a clean sheet
   when the product surface is empty — an empty trace is a recorded state, never
   a pass.
5. **Walk a real operation end to end.** A fork pull request. A new library. A
   deleted project. A dependency bump. A renamed subsystem. Follow it through
   every gate and name which one catches what. **This is the only phase that
   finds interactions** between mechanisms that are each individually correct,
   and it is the phase that gets skipped when a run is rushed.
6. **Attack.** Try to land a specific defect that every gate lets through, and
   write down the ones that failed to land. This is where the recorded attacks a
   falsifiable PASS is made of come from.
7. **Verify every survivor before it is written.** Run the command, read the
   file, probe the tool. This phase is where the constitution's verify-survivors
   step is discharged, and a suspicion that dies here leaves a WITHDRAWN behind
   it.

## 4. What a phase owes

The constitution's evidence-table step and immunity law own these; what is here
is what they cost in this workspace.

- **An evidence table, never a verdict line** — a tick with no citation and no
  recorded attack is an unrun phase claiming to have run.
- **A phase that finds nothing is written down anyway.** Here that record is what
  the rotation of probes reads: an unwritten empty phase is a probe that looks
  untried forever.
- **A finding no criterion caught obliges a new criterion in the same change**,
  which means editing `references/rubric.md` is inside the run — never a
  follow-up for someone else.
- **One probe per full run the workspace has never faced.** If none comes to
  mind, that inability is the run's finding about its own ceiling.

## 5. Findings, and what to do with them

- Report before you fix — one of the two divergences the constitution names as
  deliberate. A conformance review that arrives as a patch removes the owner's
  choice about scope and priority, and these findings are usually several
  unrelated changes, not one.
- Separate FAIL from DECLARED ruthlessly. A gap the repository already admits in
  prose is not yours to claim; counting it inflates the run and teaches the next
  reader to discount the whole report.
- **A trace gap is reported upstream-first.** When code and ceiling disagree,
  say which one is wrong before proposing a fix — a code change that quietly
  redefines a declared mechanism is a doctrine edit performed in the wrong file,
  and the fix for it starts in `shared/libs/doctrine/**`, not in the code.
- Rank by the failure each one causes, not by which rule it cites.
- The run's own history — what each round added, which suspicions died — belongs
  in the report, the pull request, or the thread (the constitution's
  episode-coordinates step). Never in the rubric: the rubric records the end
  state, the thread records the run.

## 6. A run is finished when

The constitution's finished-run step lists the general conditions and is not
repeated here. Two are specific to this object and are easy to miss:

- a full run's trace table has **both directions** filled, with every blank
  named — including the cells recorded as withheld by policy;
- the phase-1 gates are green **again** after any patch the run landed, since a
  conformance patch usually touches a gate.

Anything the constitution's step or these two ask for and the run cannot show
means the run is unfinished — report it as unfinished rather than reporting a
verdict.
