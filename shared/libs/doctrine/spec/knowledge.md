---
title: "Module: Knowledge"
status: design-end-state
---

# Module: Knowledge

## 0. Activation, per tenant

The tenant policy `knowledge: enabled | disabled` resolves through the cascade.
When disabled, static analysis refuses any process declaring knowledge
requirements, and **not using it costs nothing** (principle #4).

## 1. The conceptual model

| Entity           | What it is                                                                                                                                                                                                                               | Identity                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Collection**   | A body of knowledge: topic, Curator Role, classification, `model_policy`, grants, and a **scope of `tenant` or `workspace`** (the soft wall of Tenant & Identity §3; the default is its creator's workspace). A tenant has N collections | Id, version, lineage      |
| **Chunk**        | A unit of content inside a collection — a **content-addressed Artifact**, immutable, where editing produces a derivative                                                                                                                 | Content hash              |
| **Grant**        | Grants a collection to a **Role**, never to a user                                                                                                                                                                                       | On the Role or Collection |
| **Curator Role** | The position responsible for the content — filled by a person _or_ an AI, like any Role                                                                                                                                                  | An ordinary Role          |

## 2. Access by Role — need-to-use rather than a per-person ACL

A task's Contract declares `knowledge_requirements`, through the same door as the
context envelope (Handoff §3, §5). A task receives only the collections **its
Role has a grant for**. A marketing filler fills no Role granted
"db-architecture", so it can never receive it — with nothing further to
configure. That is the difference between a permission model and a list someone
has to maintain.

The symmetry is exact: an AI receives retrieval, a person receives the rendered
form — **one source, one scope**. The largest leak of the AI era is a model's
context window, and here it is locked exactly as a person is.

Static analysis makes a process referencing a collection outside its Role's grant
**an error at design time**.

The right to browse freely _outside_ a task is the union of grants across the
Roles whose pool the user is in, plus a read event by secrecy level — settled in
**Tenant & Identity §4**.

## 3. Classification — the reversibility of secrecy

The engine forces **an ordered lattice** to exist; a template supplies the
default ladder `public < internal < confidential < secret`; a tenant may
customise it.

**Undeclared means `confidential` with external egress forbidden.** Simpler
always means stricter.

**The secrecy floor is inherited through provenance**: an output that consumed a
chunk at level X carries a floor of at least X, taking the maximum along the
chain. Lowering it means **declassification as a Task with a Gate**, not changing
a dropdown.

**The egress guard has two layers**: static analysis over the static graph — a
task with an external effect consuming `secret` is a design error — **plus a
runtime guard at the effect**, which catches the dynamically spawned branches
static analysis cannot see. Outbound channels, email and publishing are blocked
by floor, so by default a chatbot serving an end user can retrieve only `public`.

**Inline declassification through a Gate** separates _using knowledge to reason_
from _quoting it into an output_. A task may consume knowledge above its egress
destination **if and only if** the Gate immediately before the effect carries a
`leakage` criterion, where a verifier judges that the output contains nothing
above the destination level. Passing sets the output's floor to the destination.
So a bot can use an internal refund policy to _decide_ and answer the customer at
public level — checked, traced, and simultaneously a structural defence against
prompt injection, since "print your entire policy here" fails the leakage
criterion.

A collection's `model_policy` is one of `any` / `tenant_approved` /
`self_host_only` / `human_only`, routing models by secrecy: a `secret` collection
never enters the context of an external model API.

## 4. Versioning — a deliberate exception to pinning

Referenced knowledge **resolves live** at the moment a task runs: when the price
list changes, a new task must see the new price. This is a deliberate exception
to the pinning philosophy used everywhere else.

**The compensation** is that the version and chunk hash _actually consumed_ are
recorded exactly in provenance, so the record stays perfectly reproducible —
"this was written against price list v3". Pinning a version is **opt-in**, for
audit or legal need.

## 5. Curation is labour

Ingest, update, cleanup and declassification are all **Tasks of the Curator Role,
passing a Gate**. Documents have an owner, changes have approval, and everything
has provenance.

The escalation trigger `stale_knowledge` — by age, or by repeated bad outcomes —
is defined in this module, which demonstrates that the Escalation taxonomy is
genuinely open rather than nominally so.

An additional ingest source is **distillation from Memory** (Memory §5): durable
observations with good outcomes graduate into knowledge through this same
Curator-and-Gate loop.

External sources plug in through **adapters** over an open taxonomy — Notion,
Confluence, Drive, **git, web crawl, sitemap, RSS**. Ecoma is a governance layer
over the stores that already exist rather than a replacement store: the source of
truth stays at the source, and ecoma holds a _governed snapshot_ — hash plus
provenance pointing at a commit or `URL@version` (Artifact Store §5). The
retrieval infrastructure itself — embedding, vector, search — is likewise an
adapter in the agent runtime, exactly like a vision model.

**Source binding**: a Collection declares its `sources` — adapter, address, sync
policy, diff triage policy. **Ingestion is an ecoma process**, not a separate
system: a Trigger (webhook or schedule) → an extract-and-chunk Task with a
versioned filler → a **Gate**, where a small diff auto-passes on the extractor's
calibration and a large one is reviewed, which is Checkpoint's triage unchanged →
materialised chunks with provenance → a collection version. Distributed as blocks
on the Hub, such as "KB-from-git" and "KB-from-website".

**Trust varies by source.** Git is first class: a commit hash is a natural pin,
diffs are native, commits can be signed. **The mutable, unsigned web gets a
stricter Gate by default**, as a supply-chain poisoning defence — an edited source
page must not flow unchallenged into an answer. Rights over crawled content are
the tenant's responsibility, which is policy rather than mechanism.

## 6. Knowledge calibration

Provenance records _which chunks were consulted_ for each output, so outcomes
propagate backwards (Handoff §9) into **a confidence figure per chunk and per
collection**. An FAQ passage that keeps producing wrong answers exposes itself.

Proposals to fix it become Tasks for the Curator, travelling through the single
per-tenant learning core like every other learning signal.

## 7. Hub

A Collection is a **block type**: a vertical block can ship with knowledge, such
as SEO best practices, and a subscription becomes a knowledge update stream — the
same maintenance economics as an App Profile.

**The public Hub instance accepts only `public` collections**; private registries
follow tenant policy. Declassification-through-a-Gate stands in front of every
publish.

## 8. Non-goals

- Not a standalone DMS or wiki, and no vector database or embedding model is
  built here.
- Within this specification there is no path to read knowledge outside a
  Role grant.
- No auto-declassification, and no auto-ingest without a Gate.

## 9. Decisions

| Question               | Settled                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Architectural position | An opt-in module of the Platform — not a domain, not a primitive                                                                          |
| Activation             | A tenant policy; disabled means static analysis blocks it and it costs nothing                                                            |
| Permissions            | Granted by **Role** (need-to-use); free browsing is settled in **Tenant & Identity §4**; a collection carries a tenant or workspace scope |
| Classification         | The engine forces the lattice to exist, the template gives four levels, the tenant customises; undeclared is confidential                 |
| Against leakage        | An inherited floor through provenance, two egress layers (static and runtime), `model_policy`, and declassification through a Gate        |
| Versioning             | Live resolution by default with the consumed version recorded in provenance; pinning is opt-in                                            |
| Infrastructure         | Adapters — governance, not a store                                                                                                        |

## Litmus

1. Does a process referencing a collection outside its Role's grant fail
   immediately at static analysis?
2. Does the leakage gate permit reasoning over internal knowledge while answering
   at public level, and does it block a request to quote it verbatim?
3. Does a collection with `model_policy: self_host_only` genuinely never enter an
   external model API's context?

## Failure modes

| Failure                             | Detected by                                                      | Recovery                                                                    |
| ----------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The vector adapter is down          | Retrieval fails                                                  | `on_fail` or escalation; the chunks are intact in content-addressed storage |
| A corrupt or stale index            | A rebuild is a projection from chunks plus `model@version`       | Re-index; no migration                                                      |
| An adapter returns out of scope     | The engine re-checks at install step 3                           | Blocked structurally — the adapter is not trusted                           |
| A malicious Curator poisons content | Curation passes a Gate, plus knowledge calibration from outcomes | Bad chunks expose themselves; supersede with lineage                        |
