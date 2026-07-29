---
name: repo-review
description: Adversarial review of the repository itself — its gates, tests, derivations, boundaries, docs, supply chain, and the proportion between all of that and the code it protects — against the repository rubric in `references/rubric.md`. Use when asked to review, audit, attack, or assess the repo/workspace as a whole, or before trusting it with a new subsystem. Not a diff review (`/preflight`, `/code-review` own those) and not a doctrine review (`/doctrine-review` owns the published tree).
---

# Repository review (Ecoma)

The rubric owns the criteria, the severity scale, and the verdict laws:
[`references/rubric.md`](./references/rubric.md). **This file owns only the
procedure.** Never restate a criterion here — a second copy is a second rubric
and no reader can tell which one binds. If the rubric turns out to be hard to
run from, fix the rubric.

Read Part I before judging anything. A finding written before you know the
severity test, the DECLARED rule, and the WITHDRAWN obligation has to be
rewritten.

## 1. Open on green, or you are judging a known-broken tree

```bash
pnpm nx run-many -t lint test typecheck build --skip-nx-cache
node shared/tools/dev-cli/src/main.mjs check-journey-markers-workspace
node shared/tools/dev-cli/src/main.mjs check-doc-links
node shared/tools/dev-cli/src/main.mjs check-claude-md
node shared/tools/dev-cli/src/main.mjs check-doctrine
node shared/tools/dev-cli/src/main.mjs check-doctrine-index
node shared/tools/dev-cli/src/main.mjs check-subsystem-readmes
node shared/tools/dev-cli/src/main.mjs check-subproject-readmes
node shared/tools/dev-cli/src/main.mjs check-project-conventions
```

A red gate is CI's finding, not yours. **A fully green run is where this review
starts, not where it ends** — every criterion in the rubric exists because the
gates cannot see it.

## 2. Name the protocol level, in the report

- **spot** — one criterion group, or one suspicion. Owes that group's evidence.
- **area** — one subsystem or one concern (all gates, all tests, the supply
  chain). Owes phases 1–3 scoped to it, plus one walk.
- **full** — the whole repository. Owes every phase, plus one probe never run
  before.

A run that does not name its level cannot be audited for a skipped phase, which
makes every "no findings" in it unfalsifiable.

## 3. Phases, in order — each is blind to what the next one catches

1. **Inventory, derived not remembered.** Enumerate projects, targets, tags,
   gates and their invocation sites, workflow triggers and permissions, doc
   tiers, root config files and their consumers. Derive every list from the tree
   or the graph — a list you recall is a list from the last repository you read.
2. **Claim harvest.** Grep the prose for every "must / never / always / the only
   / exactly one". Each becomes two questions: who owns it, and is it true right
   now. This phase produces most DT and GA findings and produces them cheaply.
3. **Cross-file invariants.** Copied values, peer asymmetries between projects
   of the same kind, config pairs held together by human memory. Compare
   siblings against each other — a defect invisible in one file is obvious
   beside its peer.
4. **Walk a real operation end to end.** A fork pull request. A new library. A
   deleted project. A dependency bump. A renamed subsystem. Follow it through
   every gate and name which one catches what. **This is the only phase that
   finds interactions** between mechanisms that are each individually correct,
   and it is the phase that gets skipped when a run is rushed.
5. **Attack.** Try to land a specific defect that every gate lets through, and
   write down the ones that failed to land. Recorded surviving attacks are what
   a falsifiable PASS is made of.
6. **Verify every survivor before it is written.** Run the command, read the
   file, probe the tool. A suspicion that dies here is recorded as WITHDRAWN
   with what killed it — never quietly dropped, and never reported as a finding
   because it was expensive to investigate.

## 4. What a phase owes

- **An evidence table, never a verdict line.** A tick with no citation and no
  recorded attack is an unrun phase claiming to have run.
- **A phase that finds nothing is a result**, and it must be written down: the
  rotation of probes depends on knowing which ones came back empty.
- **A finding no criterion caught obliges a new criterion in the same change.**
  Editing the rubric is inside the run, never a follow-up for someone else.
- **One probe per full run the repository has never faced.** If none comes to
  mind, that inability is the run's finding about its own ceiling.

## 5. Findings, and what to do with them

- Report before you fix. A repository review that arrives as a patch removes the
  owner's choice about scope and priority — and these findings are usually
  several unrelated changes, not one.
- Separate FAIL from DECLARED ruthlessly. A gap the repository already admits in
  prose is not yours to claim; counting it inflates the run and teaches the next
  reader to discount the whole report.
- Rank by the failure each one causes, not by which rule it cites.
- The run's own history — what each round added, which suspicions died — belongs
  in the report, the pull request, or the thread. Never in the rubric: the
  rubric records the end state, the thread records the run.

## 6. A run is finished when

- the protocol level is named, and every phase that level owes carries evidence;
- every finding carries a verdict, a severity, and a reproduction;
- every withdrawn suspicion is recorded with what killed it;
- any criterion the run had to invent now exists in the rubric, in this change;
- the phase-1 gates are still green after any patch the run did land.

Anything missing means the run is unfinished — report it as unfinished rather
than reporting a verdict.
