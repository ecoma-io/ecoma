# Documentation Instructions

## 1. Language

- Documentation in `docs/` is written in **Vietnamese**.
- Keep **technical terms, domain terms, product/service names, framework/library names, protocol names, architecture patterns, identifiers, API names, configuration keys, commands** and other standard terms in English.
- Do not translate a term when translating it would reduce technical precision.

## 2. Documentation Principles

- **Concise first**: use the fewest words while still conveying the full meaning within the correct scope.
- Each document has **one clear responsibility**.
- Do not write long documents that gather many topics together.
- Do not repeat information already present in another document; use references instead of copying.
- If a document regularly exceeds about **200 lines**, consider splitting the scope. Do not aggressively compress a file to the point of losing information, unless you can rephrase more concisely while preserving the information.
- Do not record implementation details that are already evident in source code, configuration, or machine-readable contracts.
- Documentation describes **why / what / boundary / invariant**; source code and configuration describe **how**.
- Documentation describes **target architecture**, not current implementation status. Deltas between target and current reality belong in PR descriptions, not in docs — except a material deviation the target must acknowledge, which is recorded per §12.
- The one exception is `features/`, which by definition describes capabilities the repository actually implements. It records **what the capability is and what it excludes**, never a status field or a progress list; see §3.

## 3. Document Scope

### `architecture/`

- `01-architecture.md`: system boundaries, ownership, deploy units, dependencies, architectural decisions and invariants.
- `02-delivery.md`: Git, Nx, CI/CD, contracts delivery, migrations, environments, release and rollout.
- `03-operations.md`: deployment operations, observability, failure handling, backup/DR, recovery and operational policies.
- `04-platform-facts.md`: verified external platform facts only.
- `05-code-architecture.md`: Nx project structure, Bounded Context, DDD layers, dependency rules, contracts.
- `06-testing.md`: canonical testing architecture — taxonomy, ownership/layout, Nx target contracts, test environment.
- `README.md`: index of the architecture axis (four knowledge views explained).
- `local-development/`: local development platform — shared Docker network, Traefik, PostgreSQL, worktree isolation, Pulumi local backend, local TLS, account/auth local topology, operations/cleanup and measured evidence. It is infrastructure owned by Architecture, never an Application or a bounded context.

Architecture owns system topology, deploy/service boundaries, system-level data ownership, cross-service communication, security boundaries, system invariants, infrastructure and database hosting, delivery/deployment/release/backup/DR, Nx/code architecture, and the local development platform. It does **not** own a bounded context's domain model or an Application's internal design.

This directory is not a delivery backlog. Planned work lives in GitHub Issues and Milestones; see `engineering/evolution-process.md` §4.

### `domains/`

Domains own **business knowledge only**: ubiquitous language, bounded context boundaries, semantic context map, business concepts/aggregates/value objects, business operations and policy, state transitions and invariants, domain events and semantic contracts, and business authority. Domains must not contain HTTP endpoints, Nuxt/Hono/Worker/Queue, SQL schema/ORM/migrations, service bindings/Hyperdrive/D1, provider SDKs/adapters, runtime retry/lease/concurrency, or deployment/monitoring/runbooks.

Distinguish **domain state** (business state the system must guarantee) from **execution state** (technical state of a job run, lease, claim, retry or worker execution). Execution state does not become domain state merely because it is persisted in a database. A technical mechanism may enforce a business invariant, but the mechanism still belongs to the Application.

- `README.md`: the Domains view — purpose, catalog of every bounded context (name, short business responsibility, link to its README), and the ownership rules. No deploy-unit, Nx project or Pulumi mapping column; no background-job or non-domain component catalog; no decision register duplicating ADR indexes.
- `glossary.md`: shared domain language across contexts. Each term carries its Ecoma-specific meaning and the context that owns it; note confusable terms. No runtime, database or implementation terminology unless it carries business meaning.
- `context-map.md`: semantic relationships between bounded contexts only — upstream/downstream, customer/supplier, ACL, conformist, published language. No service bindings, HTTP, queues, workers or deployment graph; background jobs are never bounded contexts or domain relationships.
- `open-boundaries.md`: genuinely undecided **business** boundaries only. Each item states the question, involved contexts, what is settled, what is not, and the existing decision source. Decisions already settled by an ADR are removed and replaced by a pointer. No technical implementation uncertainty, deployment blocker or runbook issue.
- `domains/<context>/`: one bounded context. One context may be implemented by several Applications and deploy units; a deploy unit, Application or job does not create a context. `payment` has a folder but no design document of its own yet; its boundary lives in [`architecture/01-architecture.md`](./architecture/01-architecture.md) §2/§4 and the catalog in [`domains/README.md`](./domains/README.md).
- `domains/<context>/README.md`: short — what the context is responsible for, what it owns, what it explicitly does not own, which contexts need to know it, which canonical documents exist in the folder, and where the ADR index is. It never restates the domain model.
- `domains/<context>/domain-model.md`: canonical location for the context's business knowledge — purpose and scope, ubiquitous language, concepts and relations, aggregates/entities/value objects where they apply, business lifecycle and state transitions, policies/rules/invariants, actors/authority/business permissions, domain events and semantic contracts, business exceptions/correction/compensation, and undecided business points. Create it only when there is enough domain knowledge to be worth writing; section count is not forced to be uniform across contexts. It is never a technical architecture document.
- `domains/<context>/adr/`: architectural decision records of that context, plus an index `README.md`. Rules → §10.

There is no default `01-architecture.md` / `02-requirements.md` / `03-domain-design.md` triple per context. A separate requirements document survives only for a proven, independent reason that does not duplicate the domain model or a Feature.

### `applications/`

Applications own executable software components and their composition: application composition, BFF and UI integration, API service runtime, application use cases and orchestration, HTTP/protocol integration, adapters and provider integration, persistence implementation and schema/migration mechanics, runtime security mechanics, queue/outbox implementation, background job execution, retry/backoff/lease/concurrency/scheduling, and configuration/deployment/monitoring/recovery/runbook.

An Application is **not** a bounded context, an Nx project, a deploy unit or a Pulumi deployment project. One Application may contain several deploy units and host several bounded contexts; one bounded context may be implemented through several Applications. Do not write that an Application owns a domain merely because it hosts that context's implementation or database schema.

Keep three concepts apart, and never use "service" without saying which one is meant: **domain service** (business behaviour, belongs to Domains), **application service/use case** (orchestrates domain operations, belongs to Applications), and **deployable service/Worker/job** (runtime component, belongs to Applications and described in Architecture's system topology).

- `README.md`: index of documented components — name, component type (composition, UI/BFF, API service, control plane, data plane, background job, …), one-line responsibility, bounded contexts it hosts/composes/consumes by contract, and link. It is not a copy of the deploy-unit table in `architecture/01-architecture.md`.
- `applications/<component>/`: one Application. Background jobs are listed **flat** alongside API/BFF components — there is no `applications/jobs/` directory.
- `applications/<component>/README.md`: purpose, component type, responsibility and boundary, participating domain contexts, and the documents inside.
- `applications/<component>/01-architecture.md`: component-specific architecture — composition, runtime/process boundary, application flow and orchestration, API/protocol surfaces, integrations and adapters, persistence implementation, runtime security, execution/failure model, dependency on domain contexts, application-level invariants. Where a section states business semantics owned by a Domain Model, replace it with a pointer.
- `applications/<component>/02-requirements.md`: application-specific requirements only — protocol compatibility, interface requirements, runtime constraints, performance/scalability, technical security, availability/recovery, technical non-goals. Do not keep business rules merely because they carry FR identifiers from an older file.
- `applications/<component>/03-operations.md`: deployment, configuration/secrets, database migration operations, monitoring/alerting, failure handling, recovery, runbook. System-wide operational policy stays in `architecture/03-operations.md`.

A document beyond these three roles is allowed only when it owns a distinct subject with its own lifecycle — for example a measured spike, an upstream porting map or an E2E evidence record. It must be indexed in the component `README.md` and must not duplicate the three canonical roles.

### `engineering/`

- `README.md`: purpose of the process documentation and its relationship to the four knowledge views.
- `evolution-process.md`: canonical Engineering Evolution Process — Knowledge / Work Management / Reality & Evidence layers, four knowledge views and their ownership, five work kinds, the continuous lifecycle, Vertical Slice semantics, capability states and reconciliation/deviation semantics. It owns **process**, not system knowledge: architecture, domains and applications stay in their own canonical locations. The Features view is canonical at [`features/`](./features/README.md).
- `work-management.md`: canonical GitHub work-management policy — when a work item needs an Issue, how an Issue differs from a coordination ledger, precondition tracker, experiment record or decision Issue, how the five work kinds are recorded without adding a parallel label system, minimum Issue content and closure conditions, and the responsibilities of Project, Milestone and Pull Request. It owns **policy**, not the current GitHub configuration: label sets, Milestones, Projects and fields must be read from GitHub before use and never restated here as fact.
- `contribution-workflow.md`: canonical contributor procedure — the actions and handoffs that connect the seven lifecycle steps of `evolution-process.md` to repository constraints, which validation to run for which kind of change, and where guidance ends and `AGENTS.md` constraints begin.

`evolution-process.md` owns lifecycle and work-kind semantics; `work-management.md` owns GitHub tool semantics; `contribution-workflow.md` owns the procedure. Each may name the five work kinds so a reader can orient, but none restates another's definitions, conditions or rules — it links to the owning section. `CONTRIBUTING.md` at the repository root is an entry point that links to all three rather than a fourth copy.

### `features/`

- `README.md`: purpose of the Features view, its place among the four knowledge views, directory organisation and the rules that keep a Feature from becoming a domain spec, an API reference or a backlog.
- `_template.md`: the required structure of every Feature document — Problem, Outcome, Scope, Acceptance Scenarios, Domain & Application Mapping, Verification Mapping. It carries no status field, issue list, roadmap or implementation checklist.
- `features/<area>/<feature>.md`: one document per product capability — the user problem, the outcome the system produces, what the capability includes and excludes, the acceptance scenarios that matter, which domains and applications take part, and which tests verify it.

Rules:

- **A Feature belongs to the Features view, not to a deploy unit.** The directory groups Features by product area (`identity/`, `account/`, `pact-broker/`, …), never by Nx project. A bounded context, endpoint, worker or library does not become a Feature by existing.
- **Describe capability, not implementation.** A Feature document states the user problem, the outcome, the boundary and the acceptance scenarios. It does not restate domain rules or invariants, the API reference, the storage schema or the delivery plan — link to `domains/`, `applications/` and the machine-readable contract instead (`§4`).
- **Every capability statement must have evidence.** A behavior is described only when source code, configuration or a contract implements it. Anything that runs on a mock, a prototype or a disabled UI is named as such; anything unimplemented stays in the scope's exclusion list. Distinguish implementation evidence from verification evidence — a test file that exists proves nothing about a passing run.
- **No mutable state.** No status field, no issue/PR list, no roadmap, no phase, no implementation checklist. Capability state is derived per [`engineering/evolution-process.md`](./engineering/evolution-process.md) §5, never stored in a Feature document.
- **A Feature is not a slice.** A vertical slice delivers part of a Feature; the Feature document describes the capability, not the delivery order.

### `changes/`

- `README.md`: purpose of the Changes area, the Change Specification vocabulary (change type, horizon promotion, canonical promotion, material change, impact classes), the impact and revalidation rules, and the index of Change Specifications.
- `_template.md`: the required structure of every Change Specification — Problem, Outcome, Baseline references, Affected scope, Target model, Dependencies, Assumptions, Compatibility & impact, Open decisions, Acceptance & promotion criteria.
- `changes/<change>.md`: one Change Specification per future-target change — designing ahead the introduction, evolution or retirement of a bounded context, application, contract or shared library before any of it becomes canonical.

Rules:

- **A Change Specification is design-ahead, never baseline.** The authoritative baseline is the canonical documents of the four views plus accepted ADRs. A merged spec is accepted as design input only; it changes the baseline through canonical promotion — the owning documents are updated, ADRs are written where §10 triggers, and the spec is retired per §6. Horizon promotion (Feature Discovery → M2 → M1) is a separate portfolio commitment whose Milestone mechanics are owned by `engineering/work-management.md` §4.
- **Change type and impact classes are attributes, not GitHub fields.** Each Affected scope entry carries exactly one change type — introduce, evolve or retire; a replacement is one spec listing retire on the old target and introduce on the new one. The effect of a material change on a dependent specification is one of the impact classes owned by `changes/README.md` — a different axis from the deviation categories of §12 — and its verdict is recorded on Issues, never inside a spec.
- **Not a backlog, roadmap or status dashboard.** Planned work lives in GitHub Issues and Milestones; see `engineering/evolution-process.md` §4. A spec carries no lifecycle status, no M1/M2 markers, no progress and no issue lists; the only terminal marker is one supersession/withdrawal line, mirrored in the index row.

### `domains/README.md` rules

- The domain map describes the **target architecture**. A bounded context stays in the catalog because the architecture docs define it — missing runtime, database or provisioning never removes one. Never mark catalog entries or context-map relations as implemented/unimplemented.
- Distinguish "not yet implemented but architected" (stays in the catalog) from "decision not yet made" (goes to `domains/open-boundaries.md` only).
- Only genuinely undecided items belong in the open-boundaries section. A decision already settled by an ADR or an overview decision must not be re-listed as open; only the explicitly unresolved part of it may be.
- An Application spec (or a new app/job) does not create a bounded context. A new context enters the catalog only when the architecture docs define new business responsibility and data ownership.
- Shared infrastructure (`local-development`, `remote-cache` while disposable build state, `janitor`, `deploys/*`, provisioning projects) is never a bounded context.
- Do not copy the catalog or the context map into other documents; reference [`domains/README.md`](./domains/README.md), [`domains/context-map.md`](./domains/context-map.md) or [`domains/glossary.md`](./domains/glossary.md) instead.

## 4. Canonical Source

Each fact or decision has exactly **one canonical location**:

| Content                                                       | Canonical location                               |
| ------------------------------------------------------------- | ------------------------------------------------ |
| System architecture/policy                                    | `architecture/`                                  |
| Engineering evolution process                                 | `engineering/evolution-process.md`               |
| GitHub work-management policy (Issue/Project/Milestone/PR)    | `engineering/work-management.md`                 |
| Contributor procedure (actions, handoff, validation by scope) | `engineering/contribution-workflow.md`           |
| Features view (user problems, product capabilities)           | `features/`                                      |
| Future target specification (Change Specification)            | `changes/`                                       |
| Code architecture                                             | `architecture/05-code-architecture.md`           |
| Testing architecture                                          | `architecture/06-testing.md`                     |
| Domain language across contexts                               | `domains/glossary.md`                            |
| Bounded context catalog                                       | `domains/README.md`                              |
| Semantic context map (DDD relationships)                      | `domains/context-map.md`                         |
| Business model, rules, invariants of one context              | `domains/<context>/domain-model.md`              |
| Undecided business boundary between contexts                  | `domains/open-boundaries.md`                     |
| Application composition/runtime/design/operations             | `applications/<component>/`                      |
| Application-specific requirements (protocol/runtime/NFR)      | `applications/<component>/02-requirements.md`    |
| Local development platform                                    | `architecture/local-development/`                |
| Background job documentation                                  | `applications/<job>/`, flat alongside API/BFF    |
| External platform fact                                        | `architecture/04-platform-facts.md`              |
| Accepted architectural decision record                        | `domains/<context>/adr/` (§10)                   |
| Undecided item owned by one context                           | `domains/<context>/domain-model.md` open section |
| Undecided system-wide architectural decision                  | `architecture/01-architecture.md` §10            |
| Deferred decision with an explicit trigger                    | The canonical document that owns the decision    |
| Exact API/schema/contract                                     | Machine-readable contract                        |

Do not duplicate the same decision across multiple documents.

An item may appear in more than one document only as **a pointer**. A pointer states the fact and links to the canonical record; it never restates the reasoning, alternatives or consequences.

## 5. README Index

- `docs/README.md` must reflect the current documentation structure.
- `features/README.md` must list every Feature document of the view, grouped by area. Feature areas and their documents are added and removed in the same change as the documents themselves.
- Each `applications/<component>/README.md` and `domains/<context>/README.md` must reflect the actual documents of that component/context.
- When **adding, deleting or renaming a document/directory**, update the related README/index files in the same change.
- Do not leave READMEs pointing to documents that do not exist, or missing documents that fall within the README's scope.

## 6. Change Rules

- Do not turn a proposal, an unaccepted option or a spike alternative into a committed decision without an accepted architectural decision record (§10) or an explicit update to the canonical document that owns the decision.
- When changing a decision or platform fact, update the related cross-references and IDs.
- When adding a new document, first clearly define its **scope and canonical location**; do not create a document just to hold a few lines.
- When deleting or merging documents, move any content that remains canonical to the correct location before deleting.

## 7. Application and Domain Documentation

Do not create `applications/<component>/` or `domains/<context>/` if the component/context has no implementation or written specification.

Do not create empty scaffold documents just to preserve the structure.

Do not add `database.md`, `api.md`, `testing.md` or similar documents merely because a subject appears in the component. Split it out only when the subject has its own **scope, lifecycle or ownership** large enough to warrant it.

### No duplication between views

- A fact lives in exactly one canonical location (§4); every other document points at it.
- Architecture never restates a domain model or an Application's internal design.
- A Domain Model never restates an Application's runtime, storage or deployment mechanics.
- An Application document never restates business rules that a Domain Model owns; it points at the domain model instead.
- A Feature document never restates a domain model or an Application design; it links to both.
- Business requirements and business rules belong in `domain-model.md`; application-specific requirements belong in `applications/<component>/02-requirements.md`; user problems and product outcomes belong in `features/`.
- Do not create `applications/<component>/adr/`. ADRs stay under `domains/<context>/adr/` even when the decision has system-wide or application scope (§10).

## 8. Platform Facts

`architecture/04-platform-facts.md` contains only verified facts.

Each fact needs an appropriate source, date/snapshot and confidence.

Do not put recommendations, preferences or architectural decisions in this file.

## 9. Artifact Lifecycle

Each artifact type has its own lifecycle. There is no single lifecycle imposed on all of them, and most artifacts carry **no status field** — writing one would duplicate a state that review already records.

| Artifact             | States                                                                                | Where the state is evidenced                                                                                                                                  | Retired by                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Specification        | draft → accepted → retired                                                            | Merged into the default branch; no status field in file                                                                                                       | §6 (move canonical content first)                                           |
| Change Specification | proposed (PR) → accepted → superseded / withdrawn                                     | Merged PR — acceptance means "accepted as design input", not a baseline change; one terminal marker line plus the index note (the ADR-supersession precedent) | Canonical promotion moves content to the owning views (§6), or supersession |
| ADR                  | proposed → accepted → superseded (in full or in part) / deprecated                    | Status line in the ADR header; index row                                                                                                                      | A new ADR, never deletion (§10)                                             |
| Open decision        | open → decided                                                                        | The owning document's open section; closed by an ADR or a canonical update                                                                                    | Removing the section, leaving a pointer                                     |
| Proposal             | proposed → accepted or dropped                                                        | GitHub Issue or PR; never a status in a docs file                                                                                                             | Closing the Issue/PR                                                        |
| Experiment           | planned → running → concluded (supported / rejected / inconclusive)                   | The Issue that owns the question, or a dedicated evidence document                                                                                            | Closing the Issue; the decision record remains                              |
| Deviation            | temporary limitation → remediated; gap → closed by work; accepted deviation → decided | PR/Issue note; an ADR when material (§12)                                                                                                                     | Remediation, the closing work, or the ADR that accepts it                   |

Rules that apply to every type:

- **Acceptance** of a specification means it is merged into the default branch after review. Nothing else marks it accepted; absence of a status field is not absence of agreement. An ADR has an additional requirement: the decision must be recorded explicitly (§10).
- **Cross-reference by pointer.** A document that depends on a decision links to its canonical record. It may state what the decision is in one clause; it must not copy the alternatives, rationale or consequences.
- **Retirement never loses history.** A superseded ADR stays in place. A retired specification has its still-canonical content moved before the file is removed.
- **Do not invent a status vocabulary per document.** Use the vocabulary of this table; if an artifact needs a state this table does not define, add it here rather than inventing it locally.

## 10. ADR Governance

An ADR is required when a decision:

- changes data ownership, storage engine, database/schema name, or which context owns a responsibility;
- changes a system invariant, an architecture decision (`A<n>`), or a published contract's shape;
- accepts a deviation from the target that would otherwise make canonical documents contradict reality;
- reverses or narrows an existing accepted decision.

An ADR is **not** required for wording, clarification, a non-semantic cross-reference fix, or a decision local to one file that does not constrain another artifact. Those are direct edits to the canonical document.

Structural rules:

- **Location.** ADRs live under `domains/<context>/adr/`, even when the decision has system-wide scope; `architecture/01-architecture.md` §8 then points at the ADR instead of restating it. There is no ADR directory under `applications/`, and no second global ADR directory. Do not move existing ADRs without a demonstrated ownership problem and an explicit migration plan.
- **Numbering.** A new ADR takes the next number above every ADR that already exists in the repository, so numbers are unique across the whole repository and are never reused or renumbered. The current state has one range split between two directories because decisions migrated between contexts — `staff-access/adr/` holds `0001`–`0014`, `0016` and `0020`–`0023`, `remote-cache/adr/` holds `0015` and `0017` — and one pre-existing overlap that must not grow: `llm-financial/adr/` predates the rule and holds its own `0001`–`0010`. Because of that overlap, a cross-context citation names the context as well as the number (`llm-financial` ADR-0002 is not `staff-access` ADR-0002).
- **Index.** Each `adr/README.md` lists its context's ADRs with status. The index is a pointer list; the ADR body is canonical.
- **Header conventions differ between contexts and are preserved.** The `staff-access` and `remote-cache` sets use a status/date/source/issue line; the `llm-financial` set uses `Status:` with `(… OPEN)` qualifiers. Do not normalise existing history. New ADRs follow the convention of the directory they join.

History preservation:

- **Never rewrite an accepted ADR so that a historical decision looks different from what was decided.** Typos and non-semantic cross-reference repairs are allowed; changing the decision, its alternatives or its consequences is not.
- To change an accepted decision, write a new ADR that supersedes it, and update the old ADR's status line to point at the new one.

### Partial supersession

A decision is often narrowed rather than replaced. Represent it explicitly, in three places:

1. **Old ADR status line** — `Accepted (Superseded (in part) by ADR-NNNN — <exact scope superseded>)`, naming the parts that survive. Never leave an ambiguous "superseded" when only part of it changed.
2. **New ADR body** — a section stating which parts of the earlier decision it supersedes and which parts remain in force, by name.
3. **Index rows** — both the old and the new row carry the partial-supersession note.

The unaffected parts of the old ADR keep their original authority. Do not read a partial supersession as a full reversal, and do not restate the surviving parts in the new ADR.

### Reconciliation and cross-context reference

- An ADR records the **decision**, and its scope and consequences. It may cite the Issue or PR that implements it, but it never asserts a capability state — Specified · Implemented · Verified · Released are derived per `engineering/evolution-process.md` §5–§8, never stored in an ADR.
- When implementation shows the decision cannot hold, that is a finding: write a new ADR or record the gap. Do not edit the accepted ADR to match the code.
- When a decision owned by one context constrains another, the owning context holds the ADR and the constrained context links to it. A system-level decision may therefore live in a context's ADR directory, with a pointer from `architecture/01-architecture.md` §8 — the existing A18 → ADR-0015 and A21 → ADR-0013 pointers are this pattern.

## 11. Proposals, Open Decisions, Deferred Decisions, Experiments

These four states are routinely confused. Distinguish them by what evidence exists:

| State                                       | Definition                                                                                  | Where it is recorded                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Unaccepted proposal**                     | An option under discussion. No authority; must never be written as decided.                 | GitHub Issue or PR, written as a proposal                       |
| **Accepted decision**                       | A choice with authority that constrains other artifacts.                                    | ADR, or `architecture/01-architecture.md` §8 for `A<n>`         |
| **Genuinely unresolved boundary**           | No answer exists yet, work depends on it, and no event has been named that would settle it. | The owning document's open section, naming what is missing      |
| **Deferred decision with explicit trigger** | Deliberately not decided now; a named event reopens it.                                     | The canonical document that owns the decision, with the trigger |

Rules:

- **Reuse the existing sections.** Undecided business boundaries go to `domains/open-boundaries.md`; undecided system-wide architecture goes to `architecture/01-architecture.md` §10; undecided items owned by one context go to that context's `domain-model.md` open section. Do not create a parallel registry, a decision database or a status dashboard.
- **A change-scoped proposal may live in a Change Specification.** While a Change Specification in `changes/` (§3) is the active design vehicle for a change, the proposal and its still-open decisions are recorded in that spec — one home, not a second register. System-wide undecided architecture and undecided business boundaries keep their canonical open sections, cross-linked with the spec, never duplicated.
- **A deferred decision is not an open one.** An open item has no trigger; a deferred item names the event that will reopen it and the owner who will decide. An item with neither is an open item, and must be written as such.
- **When a decision is settled**, move its content to the canonical location and remove the open section, leaving at most one `đã chốt → <link>` pointer. Do not leave the old text describing the question as still open.
- **Do not list the same item in two registers as canonical.** A decision register points at `domains/open-boundaries.md` for boundaries; the boundary text itself lives there only.

### Experiments

An experiment is a durable record only when its conclusion outlives the conversation that produced it. A record needs:

1. the **hypothesis** and the question it answers;
2. the **scope and constraints** — what was measured, on what environment, with what versions;
3. **evaluation criteria fixed before running** — so the result cannot be reinterpreted after the fact;
4. **results and evidence** — measured output, not a summary of intent;
5. a **conclusion**: supported, rejected, or inconclusive;
6. a **link to the decision it informs** and any follow-up work.

Where it lives:

- A trivial investigation — a question answered in one session — uses the Issue or PR comment. Do not create a document.
- A durable record lives in the Issue that owns the question, unless a canonical specification must cite the evidence long-term. In that case it becomes a document in the owning context or application directory, indexed in that directory's `README.md`.
- A conclusion that changes the target becomes an accepted decision (ADR or canonical update) and the experiment record is linked from it. The record never replaces the decision.

## 12. Deviation Governance

`engineering/evolution-process.md` §8 owns the reconciliation and deviation vocabulary. This section does not redefine it; it records where the record goes. Impact assessment on dependent Change Specifications after a material change is a different axis again: it uses the impact classes owned by [`changes/README.md`](./changes/README.md).

Not every difference between target and reality is the same thing. Name it using the process vocabulary, and write the record it prescribes:

| Category                 | Meaning                                                                                       | Record required                                              |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Temporary limitation** | Not built yet, or built narrower, for ordering, cost or dependency reasons. Target unchanged. | PR/Issue note; reconciled in the next round                  |
| **Accepted deviation**   | Target deliberately differs, for an architectural or business reason.                         | ADR when material; the target canonical doc updated to match |
| **Gap requiring work**   | A known defect or missing behaviour that must be fixed; not a choice.                         | Issue with evidence and completion condition                 |
| **Superseded decision**  | The earlier target no longer applies because a later decision replaced it.                    | The superseding ADR; old record keeps its status line        |

Rules:

- **Material deviation needs a durable decision record.** "Material" means it changes a boundary, an invariant, a contract shape or what another artifact is allowed to assume. Everything else is a note in the PR or Issue.
- **Canonical documents must not contradict accepted reality.** When a deviation is accepted, update the target document in the same change, or record the contradiction as a remediation gap. Do not leave a canonical doc describing behaviour the system is known not to have, without naming it as a limitation or a gap.
- **Do not create records for minor differences.** A deviation record is for a change to the target or to a system constraint, not for every small divergence.
- **Implementation is not a decision.** Code that behaves differently from the target is evidence of a gap or a limitation until an ADR accepts it.
