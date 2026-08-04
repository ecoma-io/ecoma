---
title: "Review Rubric & Method"
status: design-end-state
---

# Review Rubric & Method

---

## PART I — JUDGEMENT, AS THIS CORPUS INSTANTIATES IT

The laws of judgement themselves — object boundary, the one-copy law, the verdict
laws, the finding shape, immunity, tension, the owner's question, nothing
silently unreviewed — live in
[review-constitution](review-constitution.md) and are not repeated here. What
follows is only what this corpus fills them with: which defects are severe for a
document tree, which canon outranks which, what a gap in _this_ corpus may be
excused as, and what a new document owes.

**Retired numbers.** R1, R4, R6, R8 and R9 named laws that now belong to the
constitution, and their numbers are retired: never reused, never aliased. A
sentence that used to cite one of them cites the constitutional law **by name**
instead, because the name is what survives a reader holding only this file. R2,
R3, R5, R7 and R10–R12 remain this rubric's own.

### R7. Precedence when criteria collide

`Invariant (5) > canonical principle (4, North Star §3) > domain principle (RPA/Hub §3) > policy or template`

A collision may never be resolved silently. It is recorded as a `tension`
finding.

### R5. Severity — an objective test

This table instantiates the constitution's severity law for a document corpus:
the three levels and the requirement that each be an objective test come from
there, and what follows is only which defects of _this_ object land in which
level.

| Level     | Test                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------- |
| `blocker` | Violates an invariant or a canonical principle, **or** the default is unsafe — simpler means looser |
| `major`   | Two engineers reading it would implement differently; or a load-bearing concept is undefined        |
| `minor`   | Wording, a reference, a missing label                                                               |

### KNOWN-GAP in this corpus

The falsifiable-PASS law, the FAIL-carries-a-reproduction law and the
known-gap law are the constitution's. What this corpus adds to the last of them is
a second admissible ground and one closing verdict:

**KNOWN-GAP** is valid here when the constitution's condition holds — it was
self-declared in the documents **before** the run — **or** when the gap belongs to
the **commercial domain**, which this published tree deliberately does not carry.
A gap that qualifies on neither ground is a FAIL, closed by a fix or by an
`accepted-by-owner` verdict carrying a reason and the owner's confirmation.

### The finding shape in this corpus

The finding shape is the constitution's. This corpus fills its last field with
`reasoning or fix reference`, and names the second field `file`, so a finding
reads:

`(criterion, file, citation or scenario, verdict, severity, reasoning or fix reference)`

The ledger is append-only.

### R10. The owner channel

Across every review of this corpus so far, the most effective finder of holes has
been **the owner, asking a naive question** — "what is X?", "why is there no Y?".
That observation is what makes the constitution's law of the object's owner's
question load-bearing here rather than ceremonial: an owner question the documents
cannot answer with a single citation is a formal finding, at a severity set by R5.

### R11. Owner-fact sync

Every convention, decision or fact the owner states is **written into the
documents in the same session**. Anything left only in conversation is
automatically a finding.

Before each freeze, a mandatory **five-question owner debrief**: is there a
convention or decision you have stated that is not in the documents? Which part
_feels_ thin to you? What have you recently read or seen from a competitor? Has
anyone asked you something the documents cannot answer? What are you betting on
that has not been written down?

### R12. No document is silently unreviewed

This instantiates the constitution's law that nothing is silently unreviewed —
naming the unit, the level and the label it leaves behind. A new file or section
— of any class: ceiling, charter, living — passes a **cluster run in the same
session that created it**, or carries an `unreviewed` label in the index until it
does. `cluster`, not `incremental`: the per-patch level is what a change to an
existing document owes, and a new document is not a patch.

The coverage matrix declares **document class × applicable groups** explicitly. A
charter takes the full J/G/K/G9 treatment exactly as the ceiling does; the
precedent is a defect that slipped through because a charter was treated
lightly.

### R2, R3. The freeze conditions

Zero open blockers and zero open majors; every KNOWN-GAP named in a North Star or
the index; **the coverage matrix closed** (every file × every group, each cell
marked scanned or not-applicable with evidence); and the litmus catalogue
**fully passed** by desk simulation rather than by the mirror alone.

---

## PART II — THE CRITERIA, A–P

> Each group carries a **spirit question** above its criteria — the constitution's
> Goodhart guard, instantiated for this corpus.

### A — Fidelity to the founding viewpoint

_Spirit: does the corpus still serve the person who started it?_

- **A0, run first**: rebuild the **viewpoint inventory from source** and diff it
  against the current group A. Group A can only judge what it remembers, and it
  has been shown to be missing items more than once.
- A1 the two workforces are unified by a _mechanism_ — Role/Filler, trust tiers,
  one Judgment scale — rather than by a slogan.
- A2 the n=1 to N growth argument has a mechanism and requires no rewrite.
- A3 not one line of `if deterministic` in the engine; duality emerges from what
  was declared.
- A4 all three ML ambitions have a named data source and none precedes the
  flywheel.
- A5 pair-design has a mechanical footing.
- A6 the settled decisions still hold: a self-built inbox, a self-built runtime,
  Docker and Kubernetes, no BPMN, the SUL, fair-code never labelled "open
  source", one ML core, memory belonging to the organisation.
- A7 RPA is integration-first; standalone is a projection of it.

### B — The four mechanism principles, as attacks

_Spirit: is the engine quietly doing policy?_

- B1 every sentence containing "person", "human" or "AI" — which of them is an
  _engine law_ rather than a _template default_?
- B2 everything that is calibrated — which lacks a stable identity or lineage?
- B3 every hard number — which sits in the engine rather than in a template?

### C — The five invariants, as attacks

_Spirit: are the five founding promises still impossible to violate?_

- C1 is there a scenario where changing a Filler forces a process edit?
- C2 any action without a trace — an override with no Judgment, the engine
  editing something itself, an intervention that is not a Task of a Role?
- C3 does every point that consumes attention have triage, priority and storm
  control?
- C4 trace one byte of learned data from creation to use — where does it leave
  the tenant without an opt-in?
- C5 any silently stuck state, or any timeout or deadlock that becomes an
  auto-pass?
- **C6 — the soft workspace wall**: every mechanism that _aggregates,
  generalises or pools_ — distillation, calibration pooling, analytics
  aggregation, block install, collections, shared projections — must declare its
  **workspace dimension**; undeclared defaults to **narrowest**. C4 guards only
  the hard tenant boundary, and the soft wall is where a real customer — an
  agency with many clients — bleeds.

### D — Architectural boundaries

_Spirit: can the domains still not blur into one another?_

- D1 any third channel smuggled outside (Filler + Session effect) and
  (`resolve/pull/verify`) — including learning signals, proposals, updates,
  telemetry?
- D2 unplug the Hub and list what stops: is any of it runtime? Any entitlement,
  licence key or phone-home inside the engine?
- D3 any enterprise feature bypassing an extension point — a disguised fork?
- D4 does the control plane _patch_ rather than _call_?
- D5 any mechanism that only holds on SaaS — tenant cardinality must be ≥ 1?
- D6 does the platform know about selectors or vision? Does RPA know about Gates
  or calibration?
- D7 any shared mutable state outside a Handoff or a DataTable event?
- D8 any opt-in module that, when off, is **not** zero-overhead?

### E — Identity, versioning, the flywheel

_Spirit: does the system burn its own learned data?_

- E1 is pinning complete — is there one place a silent upgrade breaks a running
  instance?
- E2 does every new version carry a parent and a decay factor — verifier, filler,
  contract, criterion, script, profile, driver, table, metric?
- E3 does per-tenant cold start have all three remedies, and does anywhere quietly
  depend on cross-tenant data?
- E4 is there a second ML brain — a micro-consumer exceeding statistics, an ML
  index touching tenant calibration?
- **E5 — one truth, one home**: list every _kind of truth_ and ask which has two
  or more places that write it. Precedents already blocked: memory-about-a-filler
  against calibration; a self-writing table against the event log; **and a new
  _label or field_ is a kind of truth too — `run_kind` had its consequences
  declared for four consumers with no home of its own, so a projection written
  later would forget to filter.** Operationally: any patch declaring "the
  consequences of X in several places" must first name **where X lives**.

### F — Safety and accountability

_Spirit: is the worst outcome blocked by structure rather than by instruction?_

- F1 any effect that can run without a class? Is "undeclared means irreversible"
  consistent across Platform and RPA actions?
- F2 any unwind path crossing the commit point?
- F3 trace one credential or secret — where does the value reach an executor, a
  log, evidence or a prompt? Is masking a single chokepoint at perception,
  **at input capture**, **and on every replay or live-view channel**?
- F4 can an unenrolled node claim work or receive a secret? Is there a permanent
  control channel? Any takeover input that does not become an Action with an
  actor?
- F5 block supply chain: manifest disagreeing with analysis → reject? A block's
  filler → gated or shadow? Code → verified plus opt-in?
- F6 lease and claim: any scenario of a silent re-run after an action has been
  written?
- F7 two-layer egress by classification, static and runtime — can a dynamically
  spawned branch slip past? Is the leakage gate in the right place?
- **F8 — subsystem FMEA**: does every tier-1 subsystem (Event Log, Artifact
  Store, Lease, Node, Channel, vector adapter) carry a _failure mode × detection
  × recovery_ table? A missing table is a finding.

### G — The taxonomy of textual and design faults

This group is the compass for classifying any finding.

- G1 staging language in a ceiling document ("v1", "early phase", "for now").
- G2 policy disguised as mechanism — for every absolute imperative, ask whether it
  is an engine law or a template default.
- G3 a load-bearing concept left undefined: a noun three or more documents rely on
  with no home. Precedents: template, tenant, trigger, storage, event log.
- G4 an optimisation loop that destroys its own calibration.
- G5 over-absolutism killing a legitimate use case. Precedent: "no remote control"
  against takeover.
- G6 divergent duplicates — content in two or more places with no canonical.
- G7 disguised privilege — one kind of filler or product with a private path not
  justified by data or declaration.
- G8 ambiguous identity under delegation — what does calibration bind to, and what
  is a sub-actor?
- **G9 — interaction faults**: two mechanisms each correct alone that produce a
  fault when combined. _Only desk simulation catches these_; reading each
  specification separately never will. Precedents: scene masking against input
  capture; floor propagation against a chatbot that needs internal knowledge.

### H — Litmus

Each answer is a **desk-simulation transcript** — walking the scenario through
each mechanism, citing every step. Pointing at a section proves only that
something is _written_, never that it _runs_.

### I — Versioning and migration

- I1 completeness: does every evolvable entity carry an id and a version?
- I2 does semver carry declared semantics, applied consistently from Contract to
  Block?
- I3 no silent upgrade at any tier — auto-migration, node update, block, cascade
  snapshot.
- I4 every migration is a Task of a Role with a Gate.
- I5 can two versions of one entity run side by side, pinned per entity?
- I6 lineage plus a semantic diff per typed entity.
- I7 rollback is defined as an explicit two-way migration.

### J — The ceiling mechanism, regardless of complexity

_Spirit: the destination is always the STRONGEST mechanism. Complexity is never a
reason to stop, and "good enough" is never the destination. Every decision must
win an adversarial contest against every stronger alternative raised._

- J1 traces of compromise — "good enough", "to keep it light", "too hard so we
  did not".
- J2 every reduction carries **mechanism reasoning** in the decision log.
- J3 "what is the more ideal option, and why was it not chosen?" — answering with
  effort is a fail; answering with a less-clear mechanism or a principle violation
  is a pass.
- J4 complexity accumulates in the engine, once; simplicity goes to the user,
  every time.
- J5 the ceiling remains executable — every mechanism has at least one proven
  technology or precedent.
- **J6 — operating economics**: "regardless of complexity" is about _design_
  effort, never the _user's runtime_ cost. Any mechanism with write
  amplification, storage growth or token cost — event-per-write, evidence,
  calibration, extraction — must declare its _cost shape_ and its _regulating
  valve_: sampling, retention, batching, cascade.

### K — Complexity is the user's choice

- K1 the zero-config test: what must a minimal installation declare to run? More
  than a few lines means the minimal default is fake.
- K2 the cascade covers every parameter the engine forces to exist.
- K3 advanced capability is opt-in, never opt-out.
- K4 growth is gradual, with no configuration cliff.
- K5 **simpler means more conservative, never looser** — undeclared reversibility
  is irreversible, undeclared classification is confidential, a timeout is not a
  pass.
- K6 every escape hatch is permitted but labelled and traced.

### L — Standard specification structure

Every specification carries: L1 entity definitions with identity · L2 canonical
references rather than copied principles · L3 non-goals · L4 a decision log with
reasoning for every choice · L5 its own litmus · **L6 a canonical glossary** —
one concept, one name, tabulated in the index; the same concept under two names
is a finding.

- **L7 — Document identity carries no version number.** The corpus is an
  _evolvable entity_, so it is subject to the same I1 it imposes on the product —
  but the answer is not a number that has to be synchronised by hand in two
  places. A document carries **no version number** in its title, in the index, or
  in any cross-reference: say "specification X", never "specification X v0.4".
  Per-file versions are a second source of truth about document identity, and
  they drifted across a dozen files.

  **Git is the history.** An earlier answer to the same problem had each file open
  with a hand-kept changelog block; that has been withdrawn, because a hand-kept
  history is a second source that cannot be checked, while git's cannot drift.
  The index therefore holds no version column either.

### M — Promise traceability

_Spirit: every promise has a mechanism; every mechanism has a promise._

- M1 **forward**: every clause of the end-state statement in all three North Stars,
  plus the arguments beneath them, traces to at least one concrete mechanism. A
  shortfall is a blocker — an empty promise.
- M2 **backward**: every mechanism and specification serves some promise or
  viewpoint. An orphan is suspected scope creep and must be justified.
- **M3 — a deferral comes due**: where a document defers a mechanism to a
  **named future document** ("blocked by X", "when X is written", "X is an input
  constraint on Y"), the arrival of that document closes every such sentence in
  the same change. Grep the corpus for the new document's name before the change
  is finished; a deferral left standing beside the document that discharges it
  is a `major`, because the two now answer the same question differently and a
  reader has no way to tell which is current. _Precedent: the runtime sandbox,
  clickstream ingest and quota specifications were each named as unwritten in
  three to five places — a North Star, a specification, the ADR ledger, the
  roadmap and the scenario catalog — and no criterion re-read those sentences
  when the documents landed. M1 and M2 both pass in that state: the promise has
  a mechanism and the mechanism serves a promise. Only the deferral is stale._
- **M4 — the Publishing policy resolves in both directions**: every row of the
  corpus map's Publishing policy that withholds a document or a section must
  resolve to something that actually exists in the withheld tier, and every
  document in that tier must be named by a row. A clause withholding a section
  that exists in **neither** half is a `minor` where it is merely stale and a
  `major` where content was lost — and only the corpus's history tells those
  apart, so the check is a `git log` rather than a reading of the current tree.
  **This criterion is runnable only from the workspace that holds both halves.**
  The published tree cannot see the withheld tier by construction — the boundary
  is repository permission — so no gate here can ever enforce it, and review is
  the sole arbiter. That is the reason it is written as a criterion and not
  filed as a missing gate. _Precedent: the policy's roadmap row withheld "the §7
  line citing a threshold" when §7 had never carried one, and its
  scenario-catalog neighbour named "Parts 2–3" for a document whose withheld half
  runs to Part 3c — while the inventory recorded a bet ledger of B1–B8 that had
  since grown to B12. Three stale claims about the far side of a boundary the
  reader cannot cross, none of which M1 or M2 would ever have caught._

### N — The threat-actor battery

_Spirit: the attacker has a name and the asset has an owner._

A matrix of seven personas against assets, run as a phase: **a malicious tenant
administrator** (a database back door, editing the log?) · **a malicious block
publisher** (traps in code, manifest or knowledge) · **a compromised model
provider** (a verifier or agent returning poisoned results) · **a malicious end
user** (memory poisoning, prompt injection, trigger spam) · **an insider filler**
(a person or agent approving their own work, exfiltrating knowledge) · **a
compromised node** (faked placement, extracting secrets) · **a malicious curator**
(poisoning knowledge or an App Profile).

Each cell holds a concrete attack, the mechanism that blocks it, and a citation.
An empty cell is a finding.

### O — Competitive and standards coverage

_Spirit: competitors ship every quarter; the rubric may not wait for the owner to
notice on its behalf._

- O1 a **dated feature inventory** per tracked competitor — n8n, Dify, Astron, and
  an open list — held in the scenario and competitive catalog. An inventory not
  refreshed within a quarter is a `stale` finding.
- O2 every feature carries a verdict from the taxonomy: `equivalent` /
  `stronger` with the mechanism named / `weaker tooling` (a roadmap item, not a
  specification patch) / `deliberately not matched, with reasoning` / **`GAP`**,
  which enters the decision pipeline.
- O3 **a re-run trigger**: a competitor's major release, or a new competitor, runs
  group O locally without waiting for a full run.
- O4 a standards inventory — OCI, sigstore, MCP, computer-use APIs — where J5's
  precedents are dated; a standard heading for deprecation or replacement is a
  finding.

### P — Lifecycle completeness

_Spirit: do not ask "is what exists correct" — ask "does EVERY lifecycle stage
have a home". An empty cell with no ledger entry is a finding._

This checklist is deliberately a priori, as the cure for the rubric's own blind
spot: a rubric derived from what has already been written can only see what has
already been written.

- **P1 Product**: build → version → release → deploy → upgrade → operate →
  backup/restore → **deprecate and EOL** → sunset.
- **P2 Entity**: create → version → migrate → rollback → delete and GC.
- **P3 Data**: ingest → classify → retain → **backup/restore** → export → shred.
  **A mandatory interaction rule**: every deletion or forgetting mechanism must
  declare its relationship to the backup path — a "deletion" a backup can revive
  is an empty promise. Precedent: keys outside the backup, Event Log §4.
- **P3b — the interaction rule in REVERSE, and by KIND of copy**: (a) every
  _recovery_ mechanism must declare **what is sufficient to read again** — key,
  adapter, schema version. "Restore from backup" without the key path is the
  symmetric empty promise to P3. (b) Forbidding every _place_ is not enough: the
  permitted **kind** of copy has to be declared too. A **rewind or point-in-time**
  copy revives exactly what was just destroyed, so only a **forward-moving
  replica**, one a deletion command can reach, is valid. _Reasoning: P3 ran in one
  direction for a long time and declared the backup-revives-shredded-data hole
  closed; the same hole was then found at another door — a key-store snapshot —
  along with its inverse: losing the machine loses everything despite an intact
  backup._
- **P4 Actor, Node, Adapter**: enroll or register → update → suspend →
  **decommission with a graceful drain** → revoke.
- **P5 Change and Contribution**: propose → review → integrate through a queue,
  against interaction faults → land → **cheap revert or rollback**. This applies
  to EVERY stream of change: code, specification, block, knowledge,
  configuration. A revert cell with no cheap way back is a finding, and a
  "revert" with no prepared down path is a sentence rather than a mechanism.

---

## PART III — THE METHOD

> The founding lesson: **each method catches the class of fault the previous one
> was blind to.** The observed curve: manual reading catches G3 → noun scanning
> catches hidden infrastructure → desk simulation catches G9 interactions →
> competitive adversarial work catches use-case holes → specifying a ledger
> catches the questions the simulation skipped. One method running dry does not
> mean the corpus is clean.

| Phase | Work                                                                                                                                                                                  | Fault class caught                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 0     | **A0**: rebuild the viewpoint inventory from source, diff against group A                                                                                                             | A rubric missing a viewpoint                       |
| 1     | Mechanical scanning: grep for G1 staging language, G5 absolutes (a roll-call of deliberate ones), B3 hard numbers, cross-references, duplicates                                       | G1, G6, B3                                         |
| 2     | Read each file against A–P, filling the **coverage matrix** — every cell needs evidence, against coverage theatre                                                                     | The full static spectrum                           |
| 3     | **Infrastructure noun scan**: every noun appearing in two or more files, asked "does it have a home?"                                                                                 | G3                                                 |
| 4     | **Desk-simulation battery**: basic → moderate → complex → boundary and adversarial → meta, at least five rounds, stopping at saturation; each scenario walked through every mechanism | **G9 interactions** — only this phase catches them |
| 5     | **Competitive adversarial pass**: enumerate a competitor's customer scenarios fully, then trace each through ecoma                                                                    | Use-case holes, positioning                        |
| 6     | Full litmus pass (Part IV) by desk-simulation transcript                                                                                                                              | H                                                  |
| 7     | Findings → patch, each patch re-running the principle × invariant matrix before being written → post-check grep → update the ledger and the index                                     | Regression                                         |

**Supporting techniques — scenarios are an asset, not a by-product:**

- **The scenario catalog** ([scenario-catalog](scenario-catalog.md), append-only):
  every scenario ever run, with an id and a verdict. Each session is
  **regression** — re-running the catalog against the new documents, so a patch
  that breaks an old scenario is caught — plus **exploration**, generating new
  ones and adding them to the catalog.
- **A dimension model for exploration**, so scenarios are generated by measuring
  coverage gaps rather than by inspiration: `trigger type × filler mix
(person/AI/rule/external/process) × irreversible? × external party? ×
knowledge or memory? × deterministic/reasoning/hybrid × scale (n=1 / team /
multi-client agency) × mode (happy / failure / adversarial)`. A cell that has
  never had a scenario is a declarable blind spot.
- **Phase 4b — the persona review battery**: read the documents through five
  viewpoints — SRE or operator, compliance officer, implementing developer,
  agency buyer, community contributor — with five characteristic questions each.
  A question the documents cannot answer is a finding.
- **Phase 4c — subsystem FMEA**, which feeds F8: a systematic table per tier-1
  subsystem.
- **The implementation-sketch test**, an active ambiguity probe: pick a mechanism,
  sketch two _independent_ pseudo-implementations from the same passage of
  specification. A divergence is a major ambiguity found before a real engineer
  finds it.

**The coverage matrix, document class × group:**

| Document class                      | Examples                          | Groups required                              | Exempt, with reasoning                                                                                                       |
| ----------------------------------- | --------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Ceiling** (North Star plus specs) | 3 North Stars, 27 specifications  | A–P in **full**                              |                                                                                                                              |
| **System charter**                  | the funnel playbook               | B, D, F, G including G9, I, J, K, L, M, N, P | A (it carries no founding viewpoint), C (it defines no invariant), E (it owns no flywheel), H → the charter's **own** litmus |
| **Meta**                            | this rubric, the scenario catalog | G, L, **self-conformance** below             | A–F, I–K — they describe no product mechanism                                                                                |
| **Living**                          | the market ledger                 | J for reasoning, L4 for the decision log     | The remainder — market truth is not for a rubric to judge                                                                    |

_An "exempt" cell needs its reasoning stated here; a silent exemption is coverage
theatre._

**Further techniques:**

- **A rubric self-conformance pass**, mandatory at the start of every full run:
  does the rubric obey its own **L7** — no version number anywhere in its
  identity — and its own **R12**, the coverage matrix declared and this document
  not the one silently exempted from review? And does it obey the constitution's
  **immunity law (law 8)**, under which every criterion an earlier run had to
  invent exists here rather than only in that run's report? The precedent is this
  document surviving several sessions with a wrong title and no coverage matrix,
  because nobody was assigned to check the checker.
- **Reconciling scattered debt against the central ledger, in both directions**:
  grep the whole corpus for "later", "ledger", "awaiting spec", "gap", and
  reconcile both ways against the ledger.
- **The patch adversarial pass, mandatory at phase 7, BEFORE writing**: every
  patch takes three attacks, and failing one means rewriting the patch rather
  than writing it and fixing it later. Does it create a boundary or a second
  source of truth? Does it hold at n=1? Does it survive the strongest
  alternative?
- **Which numbers the counting-last step of the procedure covers here**: the total
  litmus, the milestone exit litmus, and the specification counts.
- **An FMEA table is a condition of existence for a tier-1 subsystem**: any new
  specification declaring itself a tier-1 subsystem carries its FMEA table **in
  the same session that created it** (R12).

**The method-rotation law**, this corpus's own and elevated nowhere: two
consecutive sessions of the _same method_ producing zero blockers force a change
of method. It is the reason the procedure's report step demands that an empty
phase be written down — the trigger cannot fire on evidence nobody recorded.

**This corpus's three protocol levels**, the names and contents the procedure's
declare-your-level step refers to here: `incremental` for each patch — the
principle × invariant matrix plus a post-check grep; `cluster` for each new
specification or cluster — phases 2 and 4 locally, plus the cluster's litmus; and
`full`, which owes every phase.

**A run report over this corpus** names two sources of discovery and only two —
the system or the owner — which is what makes the owner channel (R10) something
the rubric can measure rather than merely assert.

---

## PART IV — LITMUS MIRROR

> Scope: this mirrors the **system-level** litmus — three North Stars plus three
> core specifications raised to system level (Working Data, Memory, Tenant &
> Identity). The canonical litmus lives in each specification. Before each
> session, diff this mirror against its canonical sources.

**Platform**: swap a human Filler for an AI without editing the flow · shadow mode
with a self-generated comparison table · one confidence scale for people and AI
alike · cost and quality per Role regardless of who fills it.

**RPA**: one automation running as script _and_ as agent without changing its
definition · a broken script healed by an agent, with lineage and without a
person · replaying a session from log plus evidence · takeover in the same log ·
a secret never reaching a log, a screenshot or a context.

**Hub**: unplug it and every tenant runs forever · the same digest across public,
mirror and air gap · a manifest disagreeing with the analysis is rejected · a
publisher disappears and the buyer is unaffected · two Contract versions running
side by side.

**Working Data**: rebuild tables, indexes and metrics from log plus
content-addressed storage equivalently · time-travel a join by log position · a
manual database edit detected and rebuilt with a record · every write, including
bulk, carrying exactly one actor identity.

**Memory**: swap the filler and the memory about the customer survives · every
entry traceable to its original evidence · no path by which a customer's claim
becomes a fact without a Gate · no scenario where customer A sees customer B.

**Tenant & Identity**: at n=1 every concept is invisible · an employee leaves and
asks to be forgotten, and the pseudonymous audit survives while the PII dies · no
path merges a party without a Gate · an agency's client approves without an
account.

---

## PART V — ATTACKING THE RUBRIC ITSELF

Self-declared blind spots, so whoever runs this next holds no illusions.

| Blind spot                                                                                                                                                                           | Mitigation in place                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **Self-marking**: the corpus's author runs the rubric on their own work                                                                                                              | The constitution's falsifiable-PASS law plus evidence-backed coverage; its fresh-reader step decides the final freeze pass |
| **The rubric looks backwards**: it is written for fault classes already found, and is blind to the next one                                                                          | The method-rotation law, plus at least one new method per full run                                                         |
| **Goodhart**: passing the letter while failing the spirit                                                                                                                            | A spirit question per group, and the `tension` finding                                                                     |
| **Coverage theatre**: ticking a cell without reading                                                                                                                                 | Every PASS cell demands a citation or a recorded attack                                                                    |
| **The saturation illusion**: "not found" is not "not there"                                                                                                                          | PASS means surviving N recorded attacks; saturation is defined measurably                                                  |
| **Reference drift**: the documents renumber a section and the rubric points at nothing                                                                                               | The rubric cites the _concept_ first and the section number second; any patch changing section structure re-checks         |
| **Cost kills discipline**                                                                                                                                                            | The three protocol levels                                                                                                  |
| **An ontological limit**: this rubric measures only _internal consistency_ — a corpus perfect internally can still be the wrong product for the market                               | Stated outright: the rubric replaces neither customer interviews, nor ICP work, nor kill criteria                          |
| **A single mind's echo chamber**: the attacker and the defender are the same person                                                                                                  | Phase 5's competitor viewpoint is a proxy; the standing recommendation is a human red team                                 |
| **The blind spot of patching itself**: the rubric measures the _corpus_, not the _patch_ — and a patch is where a new concept is most easily born, under pressure to close a finding | The patch adversarial pass at phase 7, plus the counting-last law                                                          |

---

## PART VI — THE FOUNDING VIEWPOINT INVENTORY

The source for running A0 — self-contained, depending on no conversation.

| #   | Viewpoint                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | The core problem: unifying two workforces, human and AI                                                                                                                                                                                       |
| V2  | Deterministic and reasoning, seamless; the engine has no `if deterministic`                                                                                                                                                                   |
| V3  | The one-person-company is a bubble; at n=1 the pain is coordination — AI multiplies output and verification becomes the bottleneck; hiring carries that pain along; **and growing must not require a rewrite**                                |
| V4  | ML is an added feature — the three ambitions (process, checkpoint, prompting) never precede the data                                                                                                                                          |
| V5  | 20% of BPMN solves 90%; not following BPMN 2.0; competitors "come up from a trade"                                                                                                                                                            |
| V6  | A self-built inbox                                                                                                                                                                                                                            |
| V7  | A self-built agent runtime                                                                                                                                                                                                                    |
| V8  | Pair-design: people and AI designing processes together                                                                                                                                                                                       |
| V9  | Docker and Kubernetes                                                                                                                                                                                                                         |
| V10 | Fair-code under the SUL, open-core, four revenue streams, blocking commercial redistribution, never labelled "open source"                                                                                                                    |
| V11 | Learned data belongs to the tenant; learning is per tenant                                                                                                                                                                                    |
| V12 | **Complexity and effort are not the constraint — the destination is always the STRONGEST mechanism**: every decision must be the strongest option surviving adversarial contest. Falsifiable: name a stronger alternative that was not chosen |
| V13 | Complexity is the user's choice                                                                                                                                                                                                               |
| V14 | Verifiers are installed by whoever designs the process; multiple verifiers run in parallel or in sequence; re-marking after completion is allowed                                                                                             |
| V15 | RPA is a separate product in its own domain, integration-first, in the monorepo                                                                                                                                                               |
| V16 | Hub, Block and Template — the community extends the long tail                                                                                                                                                                                 |
| V17 | Enterprise and Cloud are two parallel layers; the tenant core has cardinality ≥ 1                                                                                                                                                             |
| V18 | Knowledge: many stores, permissioned, classified, switched on or off per tenant                                                                                                                                                               |
| V19 | A chatbot on ecoma is a first-class use case                                                                                                                                                                                                  |
| V20 | DataTable has advanced joins, unlike a workflow tool; the default is a Postgres stack; no reinventing wheels                                                                                                                                  |
| V21 | Locking must exist, and it is the Lease                                                                                                                                                                                                       |
| V22 | Memory belongs to the organisation, keyed by subject                                                                                                                                                                                          |
| V23 | Culture: multi-round adversarial review; a self-evolving rubric                                                                                                                                                                               |

A0 diffs group A against this table. A new owner viewpoint adds a new V row,
append-only.
