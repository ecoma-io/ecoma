---
title: "Module: Memory"
status: design-end-state
---

# Module: Memory

## 0. Activation, and where the concept ends

The tenant policy `memory: enabled | disabled` is **disabled by default in the
engine**; a vertical template enables it where it belongs, such as
memory-per-customer in support. Disabled means zero overhead and nothing
collected quietly — simpler must also mean not silently accumulating PII.

**Memory is not Knowledge and not Calibration.** Memory is accumulated
observation about _the party being served_, uncurated, with decay. Knowledge is
what has graduated, with a Curator. Calibration is data about _the worker_.

**The forbidden case, stated plainly**: a subject is **never** a Filler in their
capacity as a worker — "model X gets it wrong a lot", "A misses deadlines".
Assessment of labour already has a home in calibration, sourced from Judgments
and outcomes. Letting memory write it too would create a second source of truth
and, worse, an impressionistic black book routing around the system that has
checks.

## 1. Subject

An open taxonomy with three standard kinds: `external_user` (a customer arriving
through a Channel), `external_org` (a B2B account), and `tenant_self` (an
internal observation buffer, the natural source for distillation up into
Knowledge).

A subject is identified as a **Party** (Tenant & Identity §5), unifying channel
identities through a gated merge. Cross-subject isolation rests on the party id.

An instance learns its subject through the **subject binding** created by
correlation (Trigger & Channel §3).

## 2. A memory entry

`(subject, content, provenance → the evidence in the log, confidence,
classification, decay_policy, lineage)`

| Rule                | Mechanism                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Against fabrication | **Provenance is mandatory**: an entry must point back to the originating event or artifact — why it is remembered. No source means it structurally cannot enter                          |
| Against poisoning   | A subject's own assertion ("I always get 50% off") is a claim with low basis weight. It **never promotes itself into a fact**; promotion goes through a Gate with a verifier or a person |
| Immutability        | An entry is a content-addressed artifact with an event recording it. Editing means **superseding with lineage**; a contradiction raises a **Conflict** event                             |
| Secrecy             | `confidential` by default; egress and leakage gates apply unchanged; erasing a subject is **crypto-shredding** (Event Log §4)                                                            |

## 3. Remembering is labour

A candidate is proposed by an agent **or a person** — someone noting "this
customer hates Monday-morning calls" travels the identical path, symmetrically —
and then passes a **Gate**: trivia auto-passes according to the extractor's
calibration, anything weighty is reviewed, under a cascading triage policy.

Extraction, where an LLM filters "was anything here worth remembering" after an
interaction, is **policy and sampling through the cascade** rather than
mandatory. An extraction rubric is shareable content, through a template or a
block; **memory data never is** — it is per-tenant, by invariant 4.

## 4. Retrieval

A Contract declares `memory_requirements` alongside `knowledge_requirements` and
the context envelope (Handoff §3): **one door, three sources of context**. A
person receives the rendered form and an AI the structured form, at the same
scope.

**Cross-subject isolation**: the retrieval scope is the instance's subject plus
`tenant_self`. Customer A never sees anything about customer B — structurally,
not because a prompt asked nicely.

Semantic search reuses **Knowledge's vector adapter**; nothing is invented here.
A "memory bank per subject" is a projection that can be rebuilt.

## 5. Lifecycle — born, aging, dying, graduating

```
interaction → candidate (Gate) → memory entry (decay, confidence)
    ├─ used, good outcome → confidence rises
    ├─ bad outcome propagates back → memory calibration falls → proposed for retirement (a Curator task)
    ├─ decay exhausted → leaves the active projection (the log is not punctured)
    ├─ contradiction → Conflict → supersede with lineage
    └─ used often and durable → DISTILLED into Knowledge: a Curator task with a Gate;
       generalising across SEVERAL subjects must pass the leakage gate (k-anonymity by floor propagation)
```

**Distillation has a workspace dimension** (the soft wall of Tenant & Identity
§3). A distillation task declares its `scope`, and the **default is the narrowest
workspace containing every source subject** — undeclared means narrowest, never
widest.

Generalising across workspaces is an **explicit declaration**, plus the leakage
gate, plus a Curator holding the matching capability. The consequence for an
agency serving many clients: an observation about client A never _accidentally_
graduates into knowledge that serves client B. Cross-subject isolation (§4)
blocks that horizontally; this rule blocks it vertically, at the moment of
generalisation. The destination collection inherits the scope (Knowledge §1).

It mirrors the agent-to-script distillation exactly: Memory is observation,
Knowledge is what has graduated.

## 6. Mapping the five things the market calls "memory"

| What the market calls it | What ecoma answers with                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Working memory           | Attempt plus intermediate artifacts — already present                                 |
| Conversation history     | The durable chain of alternating Tasks plus a transcript projection — already present |
| Episodic                 | **The Event Log is episodic memory** — query the log and provenance                   |
| Structured per-subject   | DataTable (Working Data)                                                              |
| Semantic long-term       | **This module**                                                                       |

## 7. Non-goals

- No store of its own and no schema-per-user. An App Profile — memory about an
  application — stays in the RPA domain.
- No memory about a Filler in their capacity as a worker (§0).
- Memory data is not a block type, and it is never learned or shared across
  tenants.
- No auto-memorisation in any default engine configuration.

## 8. Litmus

1. Swap the filler on a Role — person to AI, old model to new — does the memory
   about the customer survive intact?
2. Point at any entry: can the _original evidence_ be found in the log?
3. A customer tries to plant a false fact through chat — is there any path by
   which it becomes a fact without a Gate?
4. What scenario lets customer A see a memory about customer B?
   4b. Is there any path by which distillation across client A's subjects becomes
   knowledge used for client B, in a different workspace, without an explicit
   declaration?
5. A customer demands to be forgotten — does destroying one key remove all
   ability to read it, without puncturing the log?

## 9. Decisions

| Question                  | Settled                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default                   | Off in the engine; a vertical template turns it on                                                                                                       |
| Subject                   | An open taxonomy: external_user / external_org / tenant_self. **A filler as subject is forbidden**, to avoid a second source of truth beside calibration |
| Ownership                 | The organisation's, keyed by subject — never the filler's, which is what litmus #1 tests                                                                 |
| Fabrication and poisoning | Mandatory provenance, low-weight claims, and a Gate                                                                                                      |
| Aging and death           | Decay, memory calibration from outcomes, supersede and Conflict                                                                                          |
| Graduation                | Distilled into Knowledge through a Curator task; multi-subject generalisation through the leakage gate; **scope defaults to the narrowest workspace**    |
| Infrastructure            | No new store — Event Log, content-addressed storage, the vector adapter, and projections                                                                 |
