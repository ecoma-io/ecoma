---
title: "Scenario catalog"
status: design-end-state
---

# Scenario catalog

A design is only as good as the situations it has been held against. This is the
battery: each scenario is a situation the system must answer, paired with the
mechanism that answers it.

It is a **regression asset**, not a record of a review. Its use is forward: when
a mechanism changes, the scenarios naming it are the ones to re-argue. A scenario
whose named mechanism no longer exists is either a scenario that lost its answer
or a mechanism that was renamed without anyone checking here — both are worth
finding.

Scenario identifiers are stable. They are cited from other documents, so
renumbering them would break every citation; a retired scenario keeps its
identifier and says what replaced it.

## The battery

| ID  | Situation                                                                                            | Answered by                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| S01 | A webhook arrives, is transformed, and calls an API                                                  | Trigger and channel; a handoff under contract                                                                      |
| S02 | A schedule pulls a report and emails it                                                              | A timer as a log entry                                                                                             |
| S03 | A form is validated and written to a customer system                                                 | Contract validation before the effect                                                                              |
| S04 | A single operator has an AI write, and approves it themselves                                        | Checkpoint carrying the weight at cardinality one                                                                  |
| S05 | Standalone automation fills a web form for a system with no API                                      | RPA standalone with its local consumer                                                                             |
| S06 | A brief becomes an AI draft, a person edits, and it publishes                                        | The full primitive chain, end to end                                                                               |
| S07 | A chatbot reaches the limit of what it knows and hands to a person                                   | An end user as an `external` filler; escalation                                                                    |
| S08 | An invoice arrives as an emailed PDF, is extracted, approved, and booked                             | Extraction as labour, with a gate before the ledger effect                                                         |
| S09 | Applications are screened; the applicant is an external filler                                       | One role model covering people outside the organisation                                                            |
| S10 | Onboarding runs automation, a person and a manager in parallel                                       | Parallel tasks under one process                                                                                   |
| S11 | An AI writer shadows a person, then graduates                                                        | Shadow mode and the trust tiers                                                                                    |
| S12 | A new hire shadows an AI process to learn the job                                                    | Shadow mode, in the other direction                                                                                |
| S13 | A refund conversation uses internal policy but answers publicly                                      | The classification lattice and the egress gate                                                                     |
| S14 | A multi-round business negotiation involving legal and provisioning                                  | Durable state across weeks                                                                                         |
| S15 | An agent decomposes a page into subtasks, two of them for people                                     | Dynamic spawning: an agent assigning work to a person                                                              |
| S16 | A model provider fails during fifty concurrent tasks                                                 | Correlated escalation rather than fifty separate ones                                                              |
| S17 | A process that has been running for three weeks is migrated                                          | Pinning plus explicit migration                                                                                    |
| S18 | A block is installed, its criteria forked, and an upstream change taken                              | Block distribution with lineage                                                                                    |
| S19 | An audit asks who approved, on what knowledge, with which model                                      | Provenance across judgment, knowledge and filler identity                                                          |
| S20 | Someone leaves suddenly with twelve tasks in flight                                                  | State that is durable and independent of anyone's memory                                                           |
| S21 | Two processes race to write the same record                                                          | Serialization key and Lease                                                                                        |
| S22 | A prompt injection asks the system to output all its policy                                          | The egress gate, which does not consult the model                                                                  |
| S23 | A machine is switched off mid-session, past a commit point                                           | Interruption with a state that evidence substantiates — never a silent re-run                                      |
| S24 | A chatbot is flooded with a thousand messages a minute                                               | Attention storm control                                                                                            |
| S25 | A block hides an irreversible action it did not declare                                              | Re-analysis at install: rejected, not warned                                                                       |
| S26 | The publisher of a paid block goes out of business                                                   | Entitlement checked only at distribution; installed content keeps running                                          |
| S27 | A customer in a chat demands erasure                                                                 | Crypto-shredding, reconciled with an append-only log                                                               |
| S28 | "AI must never email a key account by itself"                                                        | A criterion plus policy, without a special case in the engine                                                      |
| S29 | Two departments edit the same shared contract                                                        | Contract versioning with per-entity pinning                                                                        |
| S30 | A self-hosted installation loses power with two hundred tasks in flight                              | Replay from the log                                                                                                |
| S31 | An agency separates quality by client across forty of them                                           | The workspace dimension of calibration                                                                             |
| S32 | The system is used to build itself                                                                   | Paired design running on the engine                                                                                |
| S33 | Two tenants merge after an acquisition                                                               | Operational, and deliberately outside the ceiling                                                                  |
| S34 | A regulator audits in real time                                                                      | A projection over the event log                                                                                    |
| S35 | A role is filled by a sub-process                                                                    | `process` as a filler kind                                                                                         |
| S36 | Two competing processes are compared by outcome                                                      | Shadow mode with a process filler                                                                                  |
| S37 | An air-gapped installation                                                                           | Mirroring with standard commands; no phone-home                                                                    |
| S38 | Escalation ping-pongs indefinitely                                                                   | A linear chain with a mandatory terminal handler                                                                   |
| S39 | One person approves their own work across two roles                                                  | A reviewer role declaring a filler distinct from the author                                                        |
| S40 | Model cost spikes mid-month                                                                          | Metering as a projection; cost visible per role                                                                    |
| S41 | A long-standing customer with deep memory requests a large refund                                    | Memory scoped by party, a gate floor, and the egress gate together                                                 |
| S42 | A nested process filler stalls two levels down                                                       | The parent task's own service level escalates; no cross-level mechanism needed                                     |
| S43 | One client's private block inside a multi-workspace agency tenant                                    | Install scope carrying the workspace dimension                                                                     |
| S44 | A synchronous response must pass the egress gate under load                                          | A machine verifier inside the time budget; exceeding it fails rather than degrades silently                        |
| S45 | A knowledge base is pulled from a repository and a website, and the website is edited without notice | Drift as a hash mismatch; a stricter gate for web sources than for repositories                                    |
| S46 | An attended node is taken over remotely while a secret is on screen                                  | Live view is a projection of the masked scene, not a frame stream                                                  |
| S47 | Memory distilled from one client's customers reaches a second client's workspace                     | Distillation declares its workspace dimension, defaulting to the narrowest                                         |
| S48 | A bootstrap administrator grants themselves a capability                                             | Accepted: tenant sovereignty, audited                                                                              |
| S49 | A publisher pushes their own block through review to earn a badge, then ships code                   | A reviewer filler distinct from the publisher, and withdrawal as an event                                          |
| S50 | A customer is forgotten, then a backup from before that is restored                                  | Keys stay outside the backup path; escrow obeys the same shred command                                             |
| S51 | A singleton lease holder dies after emitting an external effect, and its lease expires               | The lease becomes orphaned and a terminal escalation decides — never a silent re-run                               |
| S52 | An agent filler calls an external tool with a side effect it never declared                          | Behaviour inside a filler versus a Task, with two hard boundaries                                                  |
| S53 | A tenant stops paying, is suspended, then asks to export and be purged                               | The tenant lifecycle: provision, suspend, export, purge                                                            |
| S54 | A major release migrated a schema, and the migration turns out to be wrong                           | A declared down-migration, or an explicit irreversible flag                                                        |
| S55 | A disk dies; the data backup is intact and the root key was correctly kept out of it                 | Mandatory disaster recovery for the root and tenant keys, with a checksum challenge at bootstrap                   |
| S56 | After a shred, the key store's own snapshot is restored                                              | Only forward-only replicas may hold key material; point-in-time snapshots are forbidden                            |
| S57 | Someone approves on an attended desktop while the machine is offline                                 | The on-machine channel carries session control only; labour goes straight to the engine API                        |
| S58 | Testing a tenant's process needs definitions and fixtures somewhere                                  | A labelled test run scope inside the real tenant, not a second tenant                                              |
| S59 | A test run performs a real read against a customer system with production credentials                | A test run scope does not resolve production secrets — `forbidden` must cover reads, not only writes               |
| S60 | A contract declares a dry run but the adapter has no dry-run mode                                    | The adapter declares `supports_dry_run`; absent it, the contract resolves to `forbidden`                           |
| S61 | An outside developer opens a change against the published repository                                 | A declared contribution path, not only a declared gate                                                             |
| S62 | A publisher ships a `code` block with its own suite to earn a badge                                  | Supporting evidence only, in a test run scope, with no secrets — and the review path depends on a sandbox existing |
| S63 | A test run writes a projection, and a production query time-travels across it                        | `run_kind` on the entry, and every projection declaring its position on it                                         |
| S64 | Backups are kept far longer than the support window                                                  | Retention bounded by the support window, or a rehearsed restore path                                               |
| S65 | An upgrade must be undone after the rollback window has closed                                       | That is restore and replay, and the procedure forbids calling it a rollback                                        |
| S66 | An attended machine runs a new runtime against an old UI layer                                       | An on-machine train check that refuses to run, plus an installer that refuses the set                              |
| S67 | During a rolling fleet upgrade, one node reaches two servers on different trains                     | The fleet's protocol set is the intersection; dropping one is a fleet-wide action                                  |
| S68 | Work is declared done with no exit condition satisfied                                               | A board owns state; it never owns the definition of done                                                           |
| S69 | A priority column is added to a planning board                                                       | Order of work already has one source; a hand-typed column becomes a competing one and, being nearest to hand, wins |

## How to use it

- **When changing a mechanism**, read the scenarios that name it. If one of them
  no longer has an answer, the change is incomplete rather than done.
- **When adding a scenario**, add it because a real situation has no answer here,
  not because a category looks thin. A scenario that no mechanism answers is the
  most valuable entry in this table, and it should say so plainly rather than be
  softened until it passes.
- **When a scenario is answered by "operational, outside the ceiling"**, that is a
  real answer and not an evasion — but it must name why the situation is not a
  mechanism the product promises.
