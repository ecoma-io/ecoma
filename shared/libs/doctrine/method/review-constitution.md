---
title: "Review Constitution"
status: design-end-state
---

# Review Constitution

The shared half of every review instrument in this project: the laws a judgment
obeys, the procedure a run follows, and the method that produces a rubric for an
object that does not have one yet.

**Common is form; particular is content.** A law here fixes the _shape_ of a
judgment — what a verdict must carry, when a PASS may be claimed, what a run
owes before it may call itself finished. What fills that shape is the instrument's
own: which defects earn which severity, which criteria a run must cover, which
blind spots that instrument has. Content may never be moved here, and form may
never be restated there.

---

## PREAMBLE

### What counts as an instrument

Three conditions, and an instrument is bound by this document only when **all
three** hold:

1. **It judges a standing object.** The object survives every diff — a corpus, a
   workspace, a class of proposal — rather than being the change in front of it.
2. **It carries its own verdict vocabulary**: findings, verdicts, and a severity
   scale it defines for its own object.
3. **It owns a standing criteria set**, whose per-run coverage is declared by
   protocol level rather than assembled fresh each time.

The classification, stated here so no surface has to guess where it stands:

| Surface                                                  | Bound | Why                                                                                                                                                                                                  |
| -------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The review rubric for this document corpus               | yes   | All three: the corpus is standing, it defines its own severity tests, and its criteria groups are fixed with coverage declared per protocol level                                                    |
| The conformance rubric for the workspace                 | yes   | All three, over a different object — what the repository declares against what it does                                                                                                               |
| The proposal rubric                                      | yes   | All three; it lives inside an issue thread rather than a file, which is a proportionality decision about where a rubric is _kept_, never about whether it is one                                     |
| The automated practice review of a pull request          | no    | Fails (1) and (3): its object is one diff, and its rubric is assembled per pull request from the practice cards that change activates. It has verdicts and findings but no severity scale of its own |
| The pre-merge diff reviews                               | no    | Fails (1) for the same reason: a diff cannot show what is missing everywhere                                                                                                                         |
| The issue hunt over a project                            | no    | Fails (3): its rotation rule deliberately never sweeps everything in one run, so there is no standing set whose coverage a run could declare                                                         |
| The procedure documents that drive the bound instruments | no    | They carry procedure, not criteria — so nothing here binds them directly. Law 2 binds them anyway: a procedure document that restates a law owned here is a second copy                              |

**The reverse obligation.** A new review surface runs this admission test in the
same change that creates it. A surface that passes the test and does not cite
this document is a finding under law 2 — not a follow-up for whoever reads it
next.

### Citation runs one way

This document never cites an instrument. It is written to be readable by someone
holding none of them, because a law that can only be understood through one of
its instantiations is that instantiation's law, misfiled.

An instrument cites this document **by law name and number**, in that order. The
name is what survives a reader who has only the citing document open; the number
is what makes the citation checkable.

### The numbering policy

Law numbers (Part I, 1–12) and step numbers (Part II, 1–11) are **stable,
append-only, never renumbered and never reused.** A law that is withdrawn leaves
its number vacant; a law that is replaced keeps its number and changes its text.
A retired number is never given to a different law, because every citation
written before the retirement would then point at something else and read as
correct.

This is the same discipline the instruments apply to their own identifiers, and
it exists for the same reason: a citation is only checkable while the thing it
names has not moved underneath it.

---

## PART I — THE LAWS OF JUDGMENT

1. **Object boundary.** An instrument judges exactly one object and does not
   reach into a neighbour's. Where two instruments look at the same artifact from
   opposite sides, each states what it takes as given — and a finding about what
   the other owns is that other instrument's finding, referred rather than
   claimed.

2. **The one-copy law.** An instrument declares its own procedure and content,
   and never restates a rule that already has an owner: a second copy is a second
   rule, and no reader can tell which one binds. When the rule changes, it changes
   in the owning tier; everywhere else cites. This law applies to this document
   before it applies to anything else — every sentence here is one an instrument
   is then forbidden to repeat.

3. **Severity is an objective test, in three levels.** Each level is defined by a
   test a reader can apply to the object without consulting the person who wrote
   the finding. The tests themselves are the instrument's content, because what
   makes a defect severe is a property of the object, not of judgment in general.

   **Severity is ordinal _within_ one instrument and comparable nowhere else.** A
   `blocker` against a document corpus and a `blocker` against a workspace are
   not two of the same thing, and adding them produces a number that means
   nothing. A report covering more than one instrument therefore **names the
   instrument beside every count**, and a count with no instrument name is an
   unfinished report rather than a total.

4. **A PASS must be falsifiable.** A criterion passes by naming the mechanism
   that holds it, with a citation — or, for a criterion of the form "find a case
   where…", by recording the attacks that failed to produce one, at least three
   by default. "Nothing found" is not a pass; it is the absence of a run.

5. **A FAIL carries a reproduction** — the command, the file and line, or the
   walk that exposes it. A verdict a reader cannot re-derive is an opinion with a
   label on it.

6. **A known gap counts only if the object declared it before the run.** A gap
   the object already admits, in prose that travels with it, is not a finding, and
   claiming it inflates the run. A gap discovered _during_ the run is a FAIL,
   closed by a fix or by an explicit acceptance carrying its reason.

7. **WITHDRAWN is a required outcome, not an embarrassment.** A suspicion that
   verification killed is recorded together with what killed it. The next run does
   not spend the same hour again — and an instrument whose runs never withdraw
   anything is reporting suspicion as fact.

8. **The immunity law.** A finding no existing criterion would have caught
   obliges a new criterion **in the same change**, recorded with the precedent
   that forced it. Editing the rubric is inside the run, never a follow-up
   somebody else inherits. The consequence is that no rubric is ever "complete" —
   only "the strongest so far, still evolving", because a claim of completeness is
   exactly the unfalsifiable claim law 4 forbids.

9. **The shape of a finding.**

   `(criterion, object, citation or reproduction, verdict, severity, consequence)`

   The consequence names what breaks in the real world, never which rule was
   cited. Each instrument declares the field names its own object needs in place
   of `object` and `consequence`, and may add fields; none may drop one.

10. **Tension is a verdict.** Where every criterion passes but the group's own
    spirit question still wobbles, or where two laws pull against each other, the
    outcome is `tension` — recorded, never resolved silently by whoever noticed
    it first.

11. **The object's owner's question is a finding.** A question from whoever owns
    the object, which the object cannot answer with a single citation, is a formal
    finding at a severity set by law 3, and law 8 applies to it like any other.
    Across every instrument so far, this has been the cheapest finder of holes
    there is.

12. **Nothing is silently unreviewed.** A new unit of the object passes, **in the
    session that created it**, the level its instrument designates for a new unit
    — never the per-patch minimum — or carries an explicit label until it does.
    Which level that is, and what a "unit" is, are the instrument's content; that
    a new unit cannot quietly skip review is not.

### Deliberate divergences

Two differences between the instruments are kept rather than reconciled, and
naming them here is what stops a later reader from filing either as drift.

- **Report-before-fix against patch-in-session.** One instrument reports findings
  and leaves the fix to the object's owner; another patches inside the run.
  That is a property of the object — who may change it, and whether a run's author
  is allowed to — not a disagreement about judgment.
- **The names of the protocol levels.** Each instrument names its own levels for
  its own object. Law 12 and Part II's step 2 refer to "the level the instrument
  designates", never to a level by name, precisely so the names can differ.

---

## PART II — THE PROCEDURE OF A RUN

1. **Gates first.** Run the deterministic checks before judging anything. A red
   gate is the automation's finding, not the run's, and a review opening on one is
   judging a state already known to be broken. A green gate set is where a review
   _starts_. Where an object has no gates, the equivalent first step is verifying
   the mechanism claims the object makes about itself.

2. **Declare the protocol level in the report.** The level decides which phases
   the run owes. A run that does not name its level cannot be audited for a
   skipped phase, which makes every "no findings" inside it unfalsifiable.
   Downgrading mid-run is allowed; doing it silently is not.

3. **Phases in order, each blind to the class the next one catches.** The order is
   load-bearing rather than bureaucratic: merging two phases deletes exactly the
   defect class the merged-away phase owned.

4. **A phase ends with an evidence table, never a verdict line.** A phase that
   found nothing is a result and must be written down — the rotation of methods
   depends on knowing which ones came back empty.

5. **Verify every survivor before writing it.** A suspicion that dies at
   verification is recorded as WITHDRAWN with what killed it: never dropped
   quietly, and never reported anyway because it was expensive to investigate.

6. **One probe per full run the object has never faced.** If none comes to mind,
   that inability is itself the run's finding about its own ceiling, and is
   written as one.

7. **Counting is the last operation.** Every total is recomputed by script after
   the final patch, with the computation recorded so the next run can re-derive
   it. A number patched mid-run is a defect the next reader inherits.

8. **Episode coordinates stay outside the artifact.** The history of a run —
   its rounds, its phases, what died — belongs to the report, the pull request, or
   the thread. The artifact records mechanisms and their reasons, so that a reader
   who was not present can still check it.

9. **A run is finished when** the level is declared and every phase that level
   owes carries evidence; every finding carries a verdict, a severity, and a
   citation or reproduction; every withdrawn suspicion is recorded; every
   criterion the run had to invent exists in the rubric in this change; and the
   gates are green again after the last patch. Anything missing means the run
   reports itself **unfinished** — never a verdict.

10. **A freeze-grade run needs a fresh reader.** Self-marking is a standing blind
    spot, and the final pass before a freeze is run by someone who did not write
    the object, working from the object and the instrument alone.

11. **The run report** records findings by phase, by severity, and by **source of
    discovery**; which methods have now come back empty and how often; and which
    criteria have never caught anything and are due for re-examination. Where a report covers more than one instrument, law 3 applies:
    every count names its instrument.

---

## PART III — GENERATING A RUBRIC FOR A NEW OBJECT

The laws and the procedure already exist. This part produces the one thing an
object does not inherit: its criteria.

1. **Inventory the object, derived rather than remembered** — from the tree, the
   graph, or the corpus itself. A list recalled is a list of the last object you
   read.

2. **Harvest the claims.** Every "must / never / always / the only / exactly one"
   becomes two questions: who owns it, and is it true right now.

3. **Cross-file invariants.** Compare siblings against siblings — a defect
   invisible inside one file is obvious beside its peer.

4. **Organise the criteria along nine axes**, instantiating each axis's question
   for the object:

| Axis                  | The universal question                                                                                                                                     | The defect class it catches                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1. Reference truth    | Is every claim checkable from a source by a reader who was not present?                                                                                    | A claim true only to whoever wrote it                      |
| 2. Enforcement truth  | Is the enforcement layer as large as it claims, and is the unenforced residue declared?                                                                    | A wish being read as a guarantee                           |
| 3. Ceiling fidelity   | Does this match what was declared upstream, traced in both directions?                                                                                     | A silent fork between what was promised and what was built |
| 4. Promise coverage   | Does every promise have an arbiter, and does the suite reach as far as the freeze?                                                                         | A promise nothing could falsify                            |
| 5. Boundary integrity | Can anything reach where the declared structure says it cannot?                                                                                            | A boundary held only by habit                              |
| 6. End-state survival | Is it right at the end state, and does every lifecycle stage have a home?                                                                                  | A stage nobody owns until it arrives                       |
| 7. Safety             | Is the worst outcome blocked by structure rather than by instruction?                                                                                      | A hazard guarded by a sentence                             |
| 8. Decision hygiene   | Is unfinished work loud, are non-goals named, do open questions have owners — and did each decision win a contest against the strongest alternative named? | A decision that was never contested, defended by effort    |
| 9. Proportionality    | Is the governance worth what it governs?                                                                                                                   | Ceremony that outgrew its object                           |

**An axis earns its place from at least two independent instruments**, and this
is an obligation at the moment a rubric is generated rather than a property to be
re-proved afterwards: an axis only one instrument has ever needed is that
instrument's own criterion group and stays there. The evidence — which instrument
contributed which axis — belongs to the report of the run that generated the
table, not to this document. Provenance carried inside the artifact is an episode
coordinate, and the next generation of the table would have to carry two.

5. **Write each criterion as an attack**, never as an assertion. A criterion is a
   probe that tries to falsify one of the object's promises.

6. **Give every group a spirit question**, as the guard against Goodhart: if
   every criterion passes and the question still wobbles, the outcome is `tension`
   (law 10).

7. **Declare the rubric's own blind-spot table**, with what is installed against
   each one. A rubric that declares none is claiming the completeness law 8
   forbids.

8. **Run the proportionality check last**, before the rubric exists: an object
   rare enough may deserve a rubric that lives in a thread rather than a file.

9. **Close the immunity loop** — the rubric ships knowing that its next finding
   may rewrite it (law 8).

---

## PART IV — THIS DOCUMENT'S OWN BLIND SPOTS

Declared under Part III's step 7, which this document cannot demand of others and
skip for itself.

| Blind spot                                                                                                                          | What is installed against it                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-marking** — the laws are judged by the instruments they govern, written by whoever wrote those instruments                   | Part II's step 10: the pass that matters is run by someone who did not write the object. The next proposal after this one runs Part III's nine axes against this document itself |
| **Derived from three instruments** — the form declared here is the form those three happened to share, not the form judgment has    | Law 8 reaches this document: a law an instrument had to invent belongs here, in the same change that invented it                                                                 |
| **The form/content line is a judgment call** — nothing mechanical decides whether a rule is shared shape or object-specific content | Stated outright rather than hidden. A disputed placement is a `tension` verdict (law 10), never settled by whoever moved the text                                                |
| **Non-comparability is declared, not enforced** — nothing stops a report from adding two instruments' blocker counts                | Law 3 requires every count to name its instrument, so an unnamed count is visibly an unfinished report rather than a plausible total                                             |
| **The one-copy law is held by review alone** — no automated check reads this document against the instruments that instantiate it   | Named here, so that a green gate set is never read as evidence that the copies were removed                                                                                      |
