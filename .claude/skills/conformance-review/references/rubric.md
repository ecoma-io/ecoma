# Conformance rubric (Ecoma)

One question, applied to the whole workspace: **does reality match what this
repository declares?** Its gates against the rules they claim to enforce, its
tests against the intent they claim to pin, its config against its single
sources, its docs against its code, and its implementation against the published
doctrine ceiling.

Every group below is a different place that question can be answered "no".

Four neighbours own different objects, and this file owns none of theirs:

| Instrument                                                                                 | Object                                          | Not this file because                                                                              |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`review-constitution.md`](../../../../shared/libs/doctrine/method/review-constitution.md) | the form of judgment shared by every instrument | this file **instantiates** that form; the laws, the procedure and the generation method live there |
| `shared/libs/doctrine/method/review-rubric.md`                                             | the published doctrine tree                     | it asks whether the design is coherent; this file takes the design as given                        |
| `/preflight`, the rule cards in `practice-index.json`                                      | one diff                                        | a diff cannot show a gate that is missing everywhere                                               |
| the deterministic gates themselves                                                         | one rule each                                   | they answer "was this rule broken", never "is this rule owned"                                     |

A finding this rubric produces is about the workspace's standing state, and it
survives every diff until someone changes the workspace.

---

## Part I — What this rubric fills in

The judgment laws themselves are the constitution's, and this file may not
restate them. What follows is only what this instrument instantiates for **its**
object — the workspace.

### 1. Severity

Instantiating the constitution's severity law (law 3) for a workspace: three
levels, each an objective test, and these are the tests. Law 3 also settles what
a mixed report may do with them — a count of these levels is comparable only to
another count from this rubric, so a report spanning instruments names the
instrument beside every number.

| Level     | Objective test                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `blocker` | A gate reports green on a state that violates the rule it claims to enforce, or a documented guarantee does not hold   |
| `major`   | An invariant is half-covered: enforced at some sites, silently absent at others — or a stated claim is currently false |
| `minor`   | Cost, wording, or an inconsistency with no reachable failure                                                           |

### 2. Verdicts, and the one this object needs

The falsifiable-PASS law, the FAIL-carries-a-reproduction law and the WITHDRAWN
law are the constitution's. This rubric adds one verdict its object needs:

- **DECLARED** is how the constitution's known-gap law lands on a repository:
  the repository already says this in prose, in a file that travels with it,
  **before** the run started. A gap you discover and the repository does not
  admit is a FAIL. A gap the repository admits is not a finding, and claiming it
  as one inflates the run.

### 3. Finding shape, as this rubric fills it

The shape is the constitution's (law 9). This rubric names its second field
`file:line` and keeps `consequence` under that name:

`(criterion, file:line, reproduction, verdict, severity, consequence)`

Law 9 already says the `consequence` field names what breaks in the real world
rather than the rule cited. What that forbids here, concretely: "Violates SR1"
fills the field with a rule name and is therefore not a consequence; "a Go bump
changes one file and CI keeps installing the old toolchain" is.

### 4. Immunity law

The constitution's (law 8), and it binds this file: a finding no criterion here
caught obliges a new criterion in the same change, which is why editing this
rubric is inside a run rather than after it.

### 5. Scope boundary

This rubric judges **conformance**: whether what exists matches what was
declared — including whether the code matches the doctrine ceiling (group TR).

It cannot tell you whether the ceiling itself is worth building. A perfectly
traced implementation of a wrong design passes every criterion here. Nor can it
tell you whether the architecture survives real load, or whether one maintainer
can carry the workspace. Those need different instruments, and pretending
otherwise is the failure mode this section exists to prevent.

This section is this rubric's answer to the constitution's object-boundary law
(law 1): it states what this instrument takes as given, so a finding about the
ceiling itself is referred to `/doctrine-review` rather than claimed here.

### 6. What a new unit of this object owes

The constitution's law 12 says a new unit of the object passes, in the session
that created it, the level its instrument designates for a new unit. Here the
unit is an **Nx project, a gate, or a workflow**, and the designated level is
**`area`** — not `spot`, which is what a suspicion about an existing unit owes.
A new unit that has not had its `area` run carries that fact in its own
`CLAUDE.md` until it does.

---

## Part II — Criteria

> Each group opens with the **question it really asks** — the constitution's
> Goodhart guard, instantiated for this object, with `tension` as its outcome
> (law 10).

### GA — Gate integrity

_Is the enforcement layer as large as it claims to be?_

- **GA1 — every stated rule has a named owner**: a gate, a lint rule, a review
  step, or an explicit written admission that it stays on human judgment. A rule
  in prose with no owner and no admission is a wish being read as a guarantee.
- **GA2 — every gate is reachable**: invoked from a `project.json` target, a
  lefthook stage, a CI step, or a scaffold template — and the invocation is
  discoverable from the gate's own documentation. A registered, documented,
  never-invoked gate reads as protection and provides none.
- **GA3 — every gate is tested on its failing path**, not only its clean one. A
  gate proven only to return 0 on good input may be a no-op.
- **GA4 — gate placement is a stated policy**: which gates run pre-commit,
  pre-push, and CI-only is written down with its reason, and any CI-only gate is
  runnable locally by one documented command. "Discovered on a red pull request"
  is not a placement policy.
- **GA5 — enforcement reach equals enforcement claim**: for each invariant, name
  the languages and file types the enforcement actually touches. A rule written
  workspace-wide but enforced for one language is half-covered, and the
  unenforced half is where it will be violated.
- **GA6 — no gate degrades to a warning.** A warning in a log is read by nobody;
  widening a refusal reopens the hole it closed.
- **GA7 — a gate's visibility reach is a stated policy, not a per-gate
  accident.** Where the tree contains material some readers cannot open — a
  private submodule, a generated directory — each gate either audits it or
  deliberately does not, and the rule is written once rather than decided
  independently at each call site. Both mistakes are silent: a gate that reaches
  into what a contributor cannot open fails for everyone but the owner, and a
  gate that stops at the boundary leaves a whole subtree ungated while reporting
  green.

### EV — Evidence honesty

_Can this repository report green while being broken?_

- **EV1 — no masked exit codes**: `|| true`, `continue-on-error`, empty-suite
  masks, or retry loops that swallow a real failure. A mask that was a
  legitimate seam at scaffold time must be removed by a gate once real content
  exists, not by intention.
- **EV2 — a cached green is invalidated by every input that can change it.**
  Name the inputs a cached target hashes and the ones it does not.
- **EV3 — unfinished work is loud**: it throws, `TODO`s, or is a visible `.todo`
  — never a placeholder returning a plausible value.
- **EV4 — a required check cannot be satisfied by a skipped job.**
- **EV5 — advisory layers degrade loudly.** A judgment layer that can stop
  running (a rate limit, a downgraded token, a missing credential) must say so
  when it does. Silence is indistinguishable from "nothing found".
- **EV6 — flake is recorded, not absorbed.** A widened timeout, a pinned worker
  count, or a retry is legitimate only with the measurement and the mechanism
  written beside it; without those it is a green bought on credit.

### TT — Test truth

_Could the important logic change without a failure?_

- **TT1 — tier discipline**: a unit test isolates every project-internal
  collaborator; an integration test exists because the interaction _is_ the
  behavior; an e2e test drives built artifacts from an `type:e2e` project.
- **TT2 — tests pin intent**, titled by the behavior they hold, not the task
  that produced them.
- **TT3 — coverage gates are peer-consistent.** Two projects of the same kind
  either both carry a threshold or the exemption is written down where a reader
  meets it. An unexplained gap is a hole that widens on its own.
- **TT4 — the riskiest module is not the least-tested one.** Rank by blast
  radius, then check the ranking against the coverage.
- **TT5 — a deliberate duplication is pinned by a test that fails when the
  copies diverge.** "Keep these identical" in a comment is an instruction to a
  reader who will not be there. If a source-level import is genuinely
  impossible, the test is what makes the duplication honest.

### SR — Single source, then derivation

_How many places must a human remember to change together?_

- **SR1 — a value in ≥2 files is derived or centralized, never copied.** A
  copied value was an unsynced config that skipped the centralization rung.
- **SR2 — a value that already exists in a machine-readable source** (a
  manifest, the tree, git state, a lockfile) **is read from it**, not restated.
- **SR3 — a centralized value has exactly one parser.** Where the parser must be
  duplicated for a structural reason, TT5 applies to the parser.
- **SR4 — no config pair requires human memory to stay in sync.** Name the pair,
  name the gate; if there is no gate, that is the finding.

### BD — Boundary and graph integrity

_Can something reach where the graph says it cannot?_

- **BD1 — every project declares the tags its boundaries key on**, and the tag
  matches the directory it lives in.
- **BD2 — dependencies the graph cannot infer are declared**, and the repository
  runs at least one unselected build because a graph is only as complete as its
  declarations.
- **BD3 — peers of the same kind carry the same target set.** A project missing
  a target its peers have is exempt from a gate nobody decided to exempt it
  from.
- **BD4 — nothing crosses a boundary through the filesystem** where the graph is
  the declared channel.

### DT — Documentation truth

_Is every claim in these files still true of this code?_

- **DT1 — a claim is verifiable and currently true.** Documents that present
  themselves as a map ("which command blocks what", "who consumes this") are
  judged strictly: an incomplete map is worse than none, because it is trusted.
- **DT2 — one source of truth.** A rule is stated in its owning tier and pointed
  to elsewhere; a second copy is a second rule, and no reader can tell which
  binds.
- **DT3 — language variants agree on facts.** Note the failure mode this creates:
  variants that are consistently wrong pass every parity gate. Parity proves
  agreement, never correctness.
- **DT4 — a rationale and the rule it justifies travel together.** A comment
  explaining why a rule exists, with no rule beneath it, is a defect: one of the
  two is wrong and the reader cannot tell which.
- **DT5 — documents record the end state.** The journey — rounds, phases,
  dates, ticket ids — belongs in the commit message, the pull request, or the
  thread, never in the artifact that outlives them.
- **DT6 — one term, one object.** A load-bearing word names exactly one thing
  across the whole workspace — prose, command names, config filenames, workflow
  names, comment titles, identifiers. Where one word names two objects, every
  reader who learned one meaning misreads the other, and the misreading is
  silent: it produces confident wrong action, never an error. Two tests catch it
  cheaply — list every surface carrying the word and name the object each one
  means; and check whether an `x-index` really indexes `x`. The fix is a rename
  on one side. A disambiguating sentence is not one: it lives in a file the name
  does not travel with.

### TR — Traceability to the doctrine ceiling

_Is the thing being built the thing that was declared?_

The ceiling is the mechanisms this system promises. This group is the only place
the ceiling and the code are held against each other, and it runs **both
directions** — one direction alone always reports comfort, because a corpus with
no implementation traces forward to nothing and a codebase with no ceiling
traces backward to nothing.

**Trace against `shared/libs/doctrine/**` — the published layer — and nothing
else.** The corpus is single but only part of it is published, per document and
sometimes per section, by the Publishing policy that document tree owns. The
rest lives where most contributors cannot read it. A run that treats the private
side as missing manufactures a gap for every withheld page; a run that assumes
it says what the public side implies is guessing. Both are avoided the same way:
what is withheld is recorded as **withheld by policy**, a state distinct from
both PASS and FAIL, and never counted as either.

- **TR1 — forward (ceiling → code).** Every mechanism a published document
  declares traces to code that implements it, to a seam that fails loud in its
  place, or to a written absence. A mechanism with none of the three is a
  promise the workspace is not keeping — and the longer it stands, the more the
  ceiling reads as a description of a system that exists.
- **TR2 — backward (code → ceiling).** Every unit of product code names the
  promise it serves. An orphan is either scope creep or an undeclared mechanism;
  both need a written reason, and the second one belongs in the ceiling before
  it belongs in the code.
- **TR3 — one concept, one name, on both sides.** A concept named in the ceiling
  and implemented in code carries the same name in both. A rename on one side
  forks the concept silently, and the fork is only visible to a reader holding
  both files open.
- **TR4 — the ceiling leads.** When code and ceiling disagree, the ceiling is
  settled first. A code change that quietly redefines a declared mechanism is a
  doctrine edit performed in the wrong file, and reviewing it as a code change
  ratifies it.
- **TR5 — a declared invariant is held by structure, and the structure is
  named.** An invariant the ceiling calls non-violable, held in practice only by
  "the developer will remember", is not held. Name the boundary, the type, the
  gate, or the test that makes the violation impossible rather than merely
  discouraged.
- **TR6 — the trace is derivable, not remembered.** Name where the mapping
  between ceiling and code is read from. A mapping that lives in a hand-kept
  table or in one person's memory is stale from its second edit.
- **TR7 — an empty trace is a recorded state, never a pass.** Where no product
  surface exists yet, TR1 and TR2 return "nothing to trace" and the run says so.
  Reporting conformance over an absence is the same defect as a green test suite
  that collects no tests.

### SC — Supply chain and repository security

_What does an outsider get to influence?_

- **SC1 — third-party actions are pinned by commit SHA**, with the human-readable
  version beside them.
- **SC2 — every workflow declares least-privilege `permissions`.** An omitted
  block inherits the repository default, which is a setting nobody reviews in a
  diff.
- **SC3 — untrusted input is data, never code.** Pull-request heads, issue text,
  and model output reach a write-token job as content; that job checks out only
  a trusted ref.
- **SC4 — no secret reaches a log, an artifact, or a model prompt.**
- **SC5 — dependency updates have an owner** — a bot, or a written cadence.
- **SC6 — a workflow's trigger matches the permission its job needs.** A job
  that must write on a fork pull request cannot run on a trigger whose token is
  read-only there; the mismatch is invisible until an outside contributor
  arrives.
- **SC7 — every tree a reader could copy names its terms**, or explicitly
  declares that none are granted.

### RP — Reproducibility and onboarding

_Can a stranger reach green on a fresh machine?_

- **RP1 — one documented command takes a fresh machine from clone to green**,
  and it is the same path the automation uses.
- **RP2 — a toolchain version is pinned in exactly one place, and every consumer
  reads that place.** A second pin is drift with a delay.
- **RP3 — the documented definition of done equals the gate set that blocks a
  merge.** Anything CI enforces beyond the documented command is a trap that
  only fires on strangers.
- **RP4 — platform claims are exercised somewhere**, or declared unverified.

### LC — Lifecycle of the repository's own units

_What must a human remember when a unit is born, renamed, or removed?_

- **LC1 — create**: scaffolding produces a fully-gated unit, with no manual
  follow-up list. A checklist a human must run after the generator is a
  generator that is not finished.
- **LC2 — change**: every class of change (code, config, doc, generated asset)
  has a review path and a cheap way back.
- **LC3 — delete**: removing a unit drops it out of every derived list on its
  own. Any list that must be edited by hand after a deletion is a stale list
  waiting to happen.
- **LC4 — rename**: names are derived from one source, so a rename is one edit.
- **LC5 — release**: a unit that emits an installable artifact carries a version
  and a release path; one that does not, says so.

### VS — Vestigial surface

_What is here that nothing needs?_

- **VS1 — no configuration for a thing that does not exist**, unless it is
  declared a reserved seam together with what will activate it.
- **VS2 — no reserved seam without a named first consumer** or an explicit note
  that it is reserved and why.
- **VS3 — no unit with neither a consumer nor a stated purpose.**

### AG — Agent-operated surface

_The repository is largely built by agents; that surface is code too._

- **AG1 — a skill or hook states procedure, never a second copy of a rule.**
  Where a rule already has an owning tier, the agent surface points at it.
- **AG2 — a hook fails loud.** A hook that can silently no-op (a missing
  interpreter, a swallowed non-zero exit) is worse than no hook, because the
  work proceeds believing it ran.
- **AG3 — an obligation is reachable where the work happens** — in the nested
  file or the routing index that loads there — not only at the root, where it
  arrives too late to change what gets edited.
- **AG4 — a model-driven step has a code-side schema gate and a bounded blast
  radius.** The model picks from an enum; code owns the control flow, the
  budget, and the validation.

### PR — Proportionality

_Is the governance worth what it governs?_

- **PR1 — the governance surface is proportional to the code it protects.**
  Every gate, doc tier, and convention costs maintenance forever. Count them
  against what would actually break without them.
- **PR2 — meta-work does not crowd out the product it serves** — and if it
  currently does, that is a stated strategy with a stated exit, not an accident
  nobody has named.
- **PR3 — an invariant that has never fired and cannot be shown to have
  prevented anything is a candidate for removal**, judged on the cost of the
  failure it guards rather than on the effort that produced it.

---

## Part III — This rubric's own blind spots

Declared so the next run does not mistake a clean sheet for a safe repository.

| Blind spot                                                                                                                       | What is installed against it                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Self-judgment** — whoever wrote the gates runs the rubric on them                                                              | The constitution's falsifiable-PASS and WITHDRAWN laws; its fresh-reader step puts a freeze-grade run in someone else's hands |
| **Derived from defects already seen** — blind to the next class                                                                  | The constitution's immunity law, plus its per-full-run probe, aimed at what the repository has never been attacked with       |
| **Green-gate illusion** — a fully green workspace reads as a healthy one                                                         | Every group asks what the gates _cannot_ see; a green run is where this rubric starts                                         |
| **Parity illusion** — consistency gates confirm agreement, never correctness                                                     | DT3 states it explicitly; facts are re-derived from the code, never from a sibling file                                       |
| **No load-bearing evidence** — nothing here judges runtime behavior, performance, or architecture                                | Part I §5; use a different instrument and do not let a clean sheet imply those                                                |
| **Proportionality is judged from inside** — the group most likely to be graded generously                                        | PR3 demands the failure a rule prevents be _named_, not assumed                                                               |
| **Conformance to a wrong ceiling still passes** — TR proves the code matches the design, never that the design deserved matching | Part I §5 says it outright; `/doctrine-review` is the instrument that judges the ceiling                                      |
| **An empty trace looks like a clean one** — a workspace with no product surface passes TR trivially                              | TR7 forces the absence to be recorded as a state rather than reported as conformance                                          |
