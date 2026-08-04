---
title: "Engineering & Delivery Charter"
status: design-end-state
---

# Engineering & Delivery Charter

The published half of this workspace's delivery system: how code travels from
a commit to a signed artifact. **A charter describes an end state.** Most of
what follows is designed and not yet built — that is the normal condition of a
charter, and it is the roadmap, not this document, that says when each piece
arrives. Reading it as a description of what runs today would be a category
error; reading it as the shape every mechanism here must grow into is the
intended use.

Two halves are deliberately absent, each for its own reason. What already
binds a contributor — the commit convention, the definition of done, the test
tiers, the pull-request flow — lives in `CONTRIBUTING.md` and the root
`CLAUDE.md`, where it reaches a contributor automatically; restating it here
would be a third copy free to drift. What concerns the private control-plane
workspace — its CI, its credentials, the commercial cadence — stays in the
delivery playbook (withheld), because it governs a repository this one does
not reference.

> **Class: System Charter.** It defines no product mechanism committed to
> tenants, so it is not a North Star; but it is **bound one-way by product
> mechanisms** — the unified release train, protocol-version + handshake,
> migration-as-entry, node distribution through the Hub, and ◆G gates as
> freeze + conformance suite. The charter may change freely; the ceiling's
> mechanisms may not. A conflict resolves in the ceiling's favour.

## 1. Position & scope

In scope: **branching · CI · quality gates · release cut · publish**.

Out of scope: deploy and infrastructure operations (the
[deploy charter](./deploy.md)), artifact commerce
([Hub](../north-star/hub.md)), and the product's versioning mechanism
([Platform NS](../north-star/platform.md) §8 — this charter only _executes_
it).

The editorial law behind those exclusions:

| If the rule…                                    | Its home                                                        | This charter               |
| ----------------------------------------------- | --------------------------------------------------------------- | -------------------------- |
| already binds contributors today                | `CONTRIBUTING.md` · root `CLAUDE.md` · the gates enforcing them | **points, never restates** |
| is a product mechanism                          | the ceiling (North Star / spec)                                 | executes, never legislates |
| is settled design with no machinery running yet | **here**                                                        | the only home              |

A third home for a rule is a third copy free to drift: when two homes
disagree, there is no way to tell which one binds.

## 2. Branching — trunk-based

| Convention                               | Content                                                                                                                                                                   | Reasoning                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One trunk** (`main`), always green     | Short-lived branches off trunk, merged by pull request; no long-lived area or domain branches                                                                             | A direct consequence of the unified release train: one `X.Y.Z` tag cuts _every_ artifact, and long-lived per-area branches drift the three domains of one monorepo apart. Gitflow is rejected by mechanism, not by taste                       |
| **Release branches cut only at release** | `release/X.Y` forks from trunk at the cut; a hotfix is fixed on trunk and cherry-picked onto the release branch, never fixed forward on the branch                        | Trunk stays the single source of truth for code                                                                                                                                                                                                |
| **Unfinished features**                  | Merge early behind a **build-time or config** feature flag                                                                                                                | Hard boundary: a flag never becomes an entitlement check, a licence key, or a phone-home at runtime. Flags are development tools and die at build; a flag that survives into runtime gating by buyer identity violates the ceiling's non-goals |
| **Merge queue**                          | An approved pull request does not merge directly: it queues, CI re-runs on the **would-be trunk** (trunk plus the pull requests ahead of it), and it lands only on a pass | Two individually-correct changes can still be wrong together. Only a merge queue catches that class. "Trunk always green" is the queue's _result_, not an assumption that precedes it                                                          |
| **One pull request, one intent**         | Refactor and behaviour change are not mixed; an oversized diff is asked to split; a change touching schema carries its **down-migration before merge**, never as debt     | These are the conditions that make revert the cheapest available operation — without them, "we can always revert" is a word rather than a capability                                                                                           |
| **Revert first**                         | Trunk red or drift suspected → **revert first, investigate after**: one operation, no need to understand the content, no blame. The revert records its reason             | In trunk-based development a low revert cost is the primary safety valve, and every rule above exists to keep that valve cheap                                                                                                                 |

## 3. CI — the executor of every quality gate, in three speed tiers

Speed and safety are not traded off against each other; they are tiered.
_Fast at the pull request, strict at the queue, complete on a cadence._

| Tier                     | When                            | Runs                                                                                        | Budget                     |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| **Pull request**         | every push                      | build and test **by affected area** · lint · the conformance suite of any touched interface | minutes                    |
| **Merge queue**          | before landing                  | the same suites on the **would-be trunk** — the interference case §2 names                  | minutes to tens of minutes |
| **Post-merge / nightly** | after landing, and on a cadence | full suite across the repository · cross-area integration · litmus automation · soak        | hours — blocking nobody    |

| Check                                      | Content                                                                                                                                   | Binding source                                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build and test by affected area            | The monorepo's dependency graph decides what runs; never the whole repository per pull request                                            | Monorepo topology (Platform NS §8). The concrete runner is a tooling choice — a default is not a coupling                                                                    |
| **The conformance suite of every ◆G gate** | A pull request touching a frozen interface must pass that interface's suite; **failing blocks the merge structurally**, not by convention | [Roadmap](../method/roadmap.md) §1b rule #7 — "a gate with no suite is a paper gate". CI is where a suite lives; suites are versioned, and changing one is a breaking change |
| Lint and static analysis by area           | Workspace lint rules, and later Ecoma's own static analysis over every process definition in the repository                               | Incremental dogfooding (§5)                                                                                                                                                  |
| Supply-chain security                      | Locked dependencies and audit; **CI is the only environment that produces a signed artifact** — a developer machine never signs a release | The Hub trust model: signing identity is CI's, not a person's                                                                                                                |

## 4. Release & publish — executing the ceiling, adding no mechanism

1. **Cut**: tag `vX.Y.Z` on trunk, then the release branch. One tag covers
   **every** artifact — server images, node binary, helm chart, SDK — so no
   artifact runs off-beat.
2. **Reproducible build**: every artifact traces to exactly one commit and
   tag, with build provenance attached.
3. **Sign**: keyless signing bound to the CI identity — the same trust chain
   Hub publishers use.
4. **Publish**: the node binary and first-party blocks go to the **Hub as a
   publisher** ([RPA NS](../north-star/rpa.md) §4: nodes update through the
   Hub, with no separate update channel). Ecoma's own release pipeline is
   therefore the first customer of the distribution channel it sells. Server
   images and charts go to a standard OCI registry under the same digest
   discipline.
5. **Deprecation and end of life**: on the ceiling's window and the release
   compatibility spec — this charter executes that calendar and does not
   legislate it.

## 5. Dogfooding, in two phases

A charter may speak of phases; the ceiling may not.

| Phase | CI/CD runs on                                                                                                                         | Transition                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1     | An external CI vendor (a default, not a coupling: every step is a script any runner can call)                                         | —                                                                      |
| 2     | The review and release-approval loop runs **as an Ecoma process**: approving a release is a Gate, with migration entry and provenance | When the team is confident, after the first milestone — no forced date |

## 5b. AI-assisted development — drift and revert

This is _the problem Ecoma exists to solve_ ([Platform NS](../north-star/platform.md) §2 —
AI multiplies output until verification becomes the bottleneck), applied to
the team building it. An AI writing code is **a Filler of the development
process**: the ceiling's own mechanism turned on the workspace, not a new one
invented for the occasion.

| Law                                       | Content                                                                                                                                                                                                                                                                                                     | Reasoning                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Every pull request takes one path**     | Human or AI, the path is the same; an AI-generated pull request starts fully reviewed, and loosens by **change type** as history accrues: documentation, tests and pure refactors may become sampled, while **core mechanisms, frozen interfaces and migrations stay fully reviewed regardless of history** | Trust tiers dogfooded into the development process — AI speed is not braked wholesale, only exactly where the risk is       |
| **AI never self-merges in phase 1**       | Every landing goes through a human and the merge queue. In phase 2, real calibration decides sampling                                                                                                                                                                                                       | No auto-pass before calibration exists                                                                                      |
| **Drift has two kinds and two medicines** | _Semantic drift_ — code diverging from the ceiling: a change touching a mechanism **must cite the ceiling document and section** it implements, checked in CI; missing means blocked. Plus a periodic spec-versus-code audit over the diff. _Quality drift_ — regression: the test tiers plus revert-first  | Without an anchor, a locally-optimising author drifts off the ceiling in small steps, each one reasonable and the sum wrong |
| **Provenance**                            | An AI-assisted commit carries its tool identity in a trailer; in phase 2 it is a sub-actor in the log proper                                                                                                                                                                                                | Who or what wrote which line is the same audit question the product answers for its own tenants                             |

## 5c. ADR — the home of implementation decisions

- **Three decision tiers, three homes**: product mechanisms → the **ceiling**
  (North Star / spec) · team process → **this charter** · implementation
  choices (language, library, data layout, framework) → **an ADR**, numbered,
  append-only, superseding with lineage — the ceiling's version discipline
  mirrored down to implementation. The [ADR ledger](../method/adr-ledger.md)
  hosts them.
- Each ADR carries context → options → **a mechanism-grounded verdict** (an
  option loses for being a weaker mechanism or for violating a principle,
  never for effort) → consequences. An ADR **may not contradict the ceiling**;
  where it does, the ceiling wins.
- **Hard-to-reverse ADRs are written before the code** — runtime and language
  choices, durable execution, storage layout — and each survives at least one
  adversarial pass. Cheap-to-reverse ADRs are written at the milestone that
  needs them. There is no big design up front at the implementation tier: the
  target architecture already lives in the ceiling, and an ADR only records
  how it is executed.

## 5d. Reference architecture inside a package

The ceiling is already strategic DDD plus hexagonal: bounded contexts are the
three domains, the ubiquitous language is the glossary, ports and adapters are
the adapter taxonomy. Tactical patterns inside a package are permitted under
four reconciliation laws; every architecture ADR obeys them, and on conflict
the ceiling wins.

| #   | Law                                                                                                                                                                                                                                                | Reasoning                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | **Event-sourced first**: aggregates rehydrate from the [Event Log](../spec/event-log.md); state is a projection; a CRUD repository as the write source is forbidden                                                                                | Events are the truth and state is derived — a state-based aggregate creates a second source of truth     |
| 2   | **Redraw the Clean circles**: the Event Log, content-addressed storage and leases, with their append-only and projection laws, sit in the **domain ring** — they belong to the ceiling and carry invariants. Only the concrete backend is a detail | "The database is a detail", read crudely, pushes the log into infrastructure; that reading is fatal here |
| 3   | **Naming follows the glossary, more strictly than DDD asks**: no homonyms across contexts — rename rather than accept a meaning-per-context; code identifiers use glossary names exactly                                                           | One word with two meanings across two areas of one monorepo is an interference failure waiting to fire   |
| 4   | **Area-first outside, layers inside**: the repository root is organised by area (physical bounded contexts); Clean layers live inside each package and never invert the root into layer-first                                                      | The root shape is settled convention                                                                     |

Full tactical DDD is a **per-package choice made by ADR** — adopted
incrementally, never imposed repository-wide.

## 6. Review & ownership

- Pull-request review is mandatory, with **owners assigned by area**. A
  `packages/` directory carries its own owners, because a separate licence layer
  without an owner is a boundary nobody is accountable for — and this one grants
  a third party rights that cannot be withdrawn. The `license:*` tag is what
  _enforces_ that boundary, while ownership only decides who reviews.
- Changing a **frozen (◆G) interface** additionally requires the owner of
  _every consuming area_ — the roadmap's cost-of-change-after-freeze
  expressed as a review mechanism rather than as a reminder.
- **An external contributor can never reach the signing pipeline.** The
  contributor gate decides whether code is accepted; it has never decided who
  signs. These are separate questions and the machinery keeps them separate.
- **Legal review covers licensing at file level**, not only the root terms:
  this tree carries several licence layers at once, and a review that reads
  only the root would miss exactly the boundary that matters.
- **The contributor's road is written where contributors read it.** An
  outside contribution is an ordinary pull request against this repository,
  and every step of it lives in `CONTRIBUTING.md` and `CLA.md`, enforced by a
  gate. A charter that declared a gate without declaring a road would be
  describing a door with no path to it — and describing that path in a
  document contributors do not open would repeat the same mistake in a
  quieter way.

## 7. Non-goals

- No CI vendor or tooling is hardcoded into this charter — a default is not a
  coupling.
- No new versioning or compatibility law: the ceiling is canonical and this
  charter executes it.
- No runtime feature flag ever evolves into an entitlement.
- No long-lived domain branches, and **no repository split by product
  domain** — the private control-plane workspace is the single exception, with
  its reasoning in the ceiling, and it is executed as two standalone
  workspaces joined by a pinned dependency. This repository is the origin; no
  machine-followed reference points from here to there.

## 8. Litmus

1. Change the CI vendor — do the release train, the artifact contract,
   signing and publish-through-Hub survive with zero mechanism change?
2. Does a release `vX.Y.Z` trace to exactly one trunk commit, with **every**
   artifact carrying that tag?
3. A change breaks a ◆G gate's conformance suite — is the merge blocked
   **structurally**, with no override outside a traceable process?
4. Sweep the tree: does any flag read at runtime to toggle behaviour by
   _buyer identity_?
5. Is there any path by which a personal machine produces a release-signed
   artifact?
6. Can any pull request — including one carrying a migration — be reverted in
   **one operation, in under fifteen minutes, without understanding its
   content**, because the down path shipped with it?
7. Two changes correct alone but wrong together — are they stopped at the
   merge queue **before** touching trunk?
8. Does an AI-assisted change have any path onto trunk without human review
   in phase 1?
9. Clone this repository: does **any machine-followed reference** to the
   private workspace exist — a gitlink, a path, a config or workflow entry?
   (Required: none.) And can an outsider tell **where their pull request
   goes** without opening any withheld document? (Required: yes — a litmus
   only a maintainer can answer is measuring the wrong person.)
