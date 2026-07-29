---
name: doctrine-review
description: Run an adversarial review pass over the published doctrine tree (`shared/libs/doctrine` — North Stars, specs, charters, method documents) against its own rubric — pick the protocol level, run the phases in their order, and leave evidence someone else can re-check. Use when asked to review, attack, harden, or freeze doctrine documents, when a new spec or a batch of doctrine edits needs judging before merge, or when a claim in those documents is challenged. Not a code review — `/preflight` and `/code-review` own diffs of code.
---

# Doctrine review (Ecoma)

The rubric owns the criteria, the severity scale, and the verdict laws:
`shared/libs/doctrine/method/review-rubric.md`. **This skill owns only the
procedure** — which protocol level, in which order, and what counts as proof a
run happened. Never restate a criterion group here: a second copy is a second
rubric, and no reader can tell which one is binding. If the rubric turns out to
be hard to run from, fix the rubric — do not grow a replacement in this file.

Read the rubric's Part I (verdict laws) before you judge anything. A finding
written before you know the severity test and the PASS rule has to be rewritten.

## 1. What the machine already holds — do not spend a run on it

Run the gates first. A review that opens on a red gate is judging a tree already
known to be broken, and its findings will be about things CI would have said for
free.

```bash
node shared/tools/dev-cli/src/main.mjs check-doctrine
node shared/tools/dev-cli/src/main.mjs check-doc-links
node shared/tools/dev-cli/src/main.mjs check-practice-index
node shared/tools/dev-cli/src/main.mjs check-subproject-readmes
node shared/tools/dev-cli/src/main.mjs check-journey-markers-workspace
```

| Gate                       | Holds mechanically                                                                                                                                                                                                                                                                                               | Residue left to you                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `check-doctrine`           | no episode coordinates in the published tree; no reference family cited whose owning document did not travel with it; no translation variant missing or behind its `canonical-sha`; no published document the corpus map does not route to; no inventory row that neither links a document nor marks it withheld | whether a translation that _matches_ its fingerprint still says the same thing; whether a routed document's row still describes it |
| `check-doc-links`          | every relative Markdown link resolves                                                                                                                                                                                                                                                                            | whether the linked document actually says what the citing sentence claims it says                                                  |
| `check-practice-index`     | every card's `quote` still appears in its `source`; every `scope` glob still matches a tracked file                                                                                                                                                                                                              | whether the card's `summary` is still semantically right                                                                           |
| `check-subproject-readmes` | the README triad exists and every variant names the same technical tokens                                                                                                                                                                                                                                        | whether the prose _around_ those tokens agrees across the three                                                                    |
| `check-journey-markers-*`  | the regex-safe subset of Rule 13                                                                                                                                                                                                                                                                                 | journey prose no regex can judge                                                                                                   |

Everything else in the rubric is judgment, and judgment is the whole job here.
Do not re-report a failure any row above already owns — the gate said it first,
and a finding that duplicates a gate inflates the run report without adding a
reader.

## 2. Name the protocol level before reading anything

The rubric defines three levels and what triggers each. Pick one, and **write it
into the report** — a run that does not name its level cannot be audited for a
skipped phase, which makes every "no findings" in it unfalsifiable.

The level decides how much of §4 you owe: an incremental run owes the per-patch
checks, a cluster run owes a local static-read plus simulation for the cluster,
a freeze run owes every phase. Downgrading mid-run is allowed; doing it silently
is not — say which phases you dropped and why (Rule 11).

## 3. Reading order

The corpus is large and layered. Reading it out of order does not merely waste
time, it manufactures wrong findings.

1. **The rubric** — Part I first (verdict laws, severity, finding schema), then
   the criteria groups. This is also where the run's first obligation lives: the
   rubric's own self-conformance pass, which opens every full run.
2. **`shared/libs/doctrine/overview/index.md`** — the corpus map, the reading
   order the corpus proposes for itself, and the self-declared known-gaps table.
   Read it _before_ the specs: a gap already declared there is not a finding
   under the rubric's KNOWN-GAP rule, so reading it afterwards manufactures
   findings that will all be withdrawn.
3. **The canonical layer, North Star before its dependants** — a spec judged
   before the North Star it derives from is being judged against nothing.
4. **`shared/libs/doctrine/method/scenario-catalog.md`** — the regression asset.
   Every run re-runs the catalog against the current documents before generating
   anything new; a scenario the corpus used to survive and now does not is the
   cheapest finding available. Add `method/adr-ledger.md` when the run touches
   implementation decisions.
5. **Only then the documents actually under review.**

## 4. Run the phases in their order

The rubric's methodology part owns the phase list and what class of defect each
one catches — read it there. What that table does not tell you, and what this
skill exists to say:

- **Order is load-bearing, not bureaucracy.** Each phase is blind to the class
  the next one catches. The mechanical scan is cheap and narrows what the
  expensive phases must read; the static read produces the coverage matrix that
  the simulation needs in order to know which mechanisms exist to be crossed;
  the simulation is the only phase that catches interaction between mechanisms
  that are each individually correct. Merging phases to save time deletes
  exactly the defect class the merged-away phase owned.
- **A phase ends with an evidence table, never a verdict line.** `✅` with no
  per-proposition citation or recorded attack is an unrun phase claiming to have
  run — the rubric's artifact-table law, and a Rule 11 violation here.
- **A phase that finds nothing is a result, not a skip** — record it, because
  the method-rotation law is driven by consecutive empty runs of the _same_
  method, and it cannot fire on evidence you did not write down.
- **A finding no existing criterion catches obliges a new criterion in the same
  change.** That is the rubric's immunity law, and it means editing the rubric is
  in scope for the run — never a follow-up someone else inherits.
- **One probe the corpus has never been attacked with, per full run.** If you
  cannot think of one, that inability is itself the run's finding about its own
  ceiling; write it as one rather than skipping the requirement quietly.

## 5. Findings and patches

- **Shape** comes from the rubric's finding schema. Write findings in the
  language of the corpus they judge — a finding the document's own readers cannot
  read does not reach anyone who can fix it.
- **Every patch takes the rubric's adversarial pass before it is written**, not
  after it lands. The patch is where new concepts, new boundaries, and new
  sources of truth get born under the pressure of closing a finding, and no
  amount of re-reading the corpus catches that — only simulating the patch does.
- **Counting is the last operation of the run.** Recompute every total by script
  after the final patch lands, and put the computation in the report so the next
  run can re-derive it. A number patched mid-run is a defect the next reader
  inherits.
- **Episode coordinates stay out of the tree.** The run report, the finding
  ledger, and the round-by-round history belong in the PR or issue thread;
  `check-doctrine` rejects them inside `shared/libs/doctrine/**` and is right to
  — a published document must be checkable by a reader who was not present. The
  documents record mechanisms and their reasons; the thread records the run.

## 6. A run is finished when all of these are true

Not when the reading is done — when each of these has an artifact someone else
could open and disagree with:

- the protocol level is named, and every phase that level owes carries its
  evidence table;
- every finding carries a verdict, a severity, and the citation or reproduction
  scenario its verdict law demands — a PASS reached by "nothing found" instead of
  by recorded surviving attacks does not count;
- every finding is closed by a patch, by an owner acceptance with its reason, or
  by a known-gap that was already declared before the run started;
- any criterion the run had to invent now exists in the rubric, in this change;
- the §1 gates are green **again** after the patches — a patch can break a link,
  strand a reference family, or leave a translation behind its canonical;
- the run report is written, including which methods returned nothing and which
  criteria have never yet caught anything.

If any of them is missing, the run is unfinished — report it as unfinished
rather than reporting a verdict (Rule 11).
