---
title: "Clickstream Ingest — the Second Write Path"
status: design-end-state
---

# Clickstream Ingest — the Second Write Path

> Platform — **a separate stream, standing beside the Event Log and never inside
> it**. It accepts web-traffic events (page views, clicks, form interactions):
> high volume, individually near-worthless, and **not labour**. Bound by the four
> principles (canonical: North Star §3). Position, stated once: make the
> storefront measurable without making the one book everything else is rebuilt
> from unusable.
>
> **It is not a tier-1 subsystem.** ◆G0 freezes the Event Log entry schema and
> the core subsystem interfaces; this tier is gated at ◆G3 and converges with
> Track C. It consumes the frozen core — the entry schema, the key tree, the
> classification lattice — and the core consumes nothing from it (§2).

## 1. The central decision — a separate log, not a label on the labour log

**Settled: a separate write path.** Not a labelled partition of the Event Log,
not a new entry kind inside it.

The opposite pull is real and it has a precedent in this very house: the
`run_kind` label (Event Log §1) separates two classes of entry **without** two
streams. But `run_kind` separates two things of **the same nature** — both
labour, both complete, both permanent — so a label suffices and one stream is
correct. Clickstream differs on **all three** properties at once, and each
divergence is a structural reason rather than a preference:

| Property          | The labour log                                                                      | Clickstream                                                              | Why they cannot share a stream                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lifetime**      | Entry metadata is **permanent** — it is the history (canonical: Event Log §4)       | A **mandatory TTL** (§6)                                                 | One stream cannot be permanent and expiring at once. Applying a TTL to the labour log means **puncturing** it — precisely what crypto-shredding exists so that nobody ever has to do                                                     |
| **Kind of truth** | A **complete** record: every projection rebuilds to an equivalent result (§3 there) | A **sampled estimate** (§3, §4 here)                                     | Mixing two kinds of claim into one stream drags the strong claim down to the weak one: a reader holding an entry no longer knows whether they hold _what happened_ or _a sample of it_, if the only thing distinguishing them is a label |
| **Who sizes it**  | The tenant's own labour — finite, measurable, and theirs                            | **Strangers**: one advertising campaign multiplies traffic a hundredfold | This is the only volume in the system set by people outside it. Joining it to the source of truth hands a stranger the valve controlling log size, replay time and the retention obligation of **everything** derived from that log      |

**Why "filter it out in projections" is not the answer.** The filter genuinely
works: the labour figures come out right. But the three costs this problem is
actually about — **log size, replay time, retention obligation** — are paid **at
write**, not at read. No read-side filter gives back a byte that was already
written. The acceptance test (§9) measures exactly those three, which is what
lets a machine decide between the two options instead of an argument.

**Why not a third-party analytics product.** A visitor record is a data
subject's data; moving it outward is an **external effect subject to egress by
classification** (§7). A system outside the lattice has no floor to carry, so
the question _"where is this data allowed to go"_ loses the only mechanism this
project uses to answer it anywhere else.

**The consequence that must not be misread**: a separate stream is **not a
second source of truth** (Event Log §7 stands unchanged). A second source of
truth is two places asserting **the same kind of fact**; here the subjects
differ — one is _labour_, the other is _traffic_ — and §2 nails the direction
shut so this one can never become the first.

**Why "second".** The Event Log has until now been the only place a fact is
_originally recorded_: the Artifact Store holds bytes belonging to entries, and
a DataTable write is itself an entry (Working Data §1). This tier is the second
such place, and the count is meant to stay at two.

## 2. The boundary — one direction, one crossing

- **No read path into labour.** No Task, Checkpoint, Judgment, calibration
  input, or engine routing decision may read this tier. Static analysis catches
  it at design time, through the same door as _"a process referencing a
  collection outside its Role's grant is an error at design time"_ (Knowledge
  §2), and it belongs in the same table (Composition §4). The reasoning: a
  sampled estimate flowing into a Judgment is a verdict resting on something
  that cannot be reproduced **in content**, and calibration that swallows one
  learns from noise — Calibration §2 already forbids every path into a cell that
  is not a valid Judgment, and this rule is what keeps that boundary from being
  crossed one layer lower down.
- **No reverse write path.** Nothing in the labour log writes into this tier.
  Two streams, disjoint on the write side.
- **Exactly one crossing — conversion.** When a visit **produces labour**
  (a form submitted, a conversation opened, a signup), the crossing is a **full
  trigger entry in the labour log** (Trigger & Channel §2), **unsampled and
  unbatched**. The outside identity enters through the grammar that already
  exists: an `external` Filler of a Role, unified into a Party (Trigger & Channel
  §3, Tenant & Identity §5). Before that moment a visitor holds an `external`
  principal identity with **no Role binding** — a page view is not labour and
  fills no position.
- **A consequence that is a mechanism rather than a coincidence**: a conversion
  is measured on **both sides** — sampled on the clickstream side, complete on
  the labour side. The ratio between those two figures **measures the error of
  the sampling itself**. So "is the sample biased" is a question with data behind
  it, not an assumption parked at the top of the chapter.

## 3. Sampling and batching — the cost shape and its valves

**Cost shape**: linear in traffic, with the upper bound set from outside. Three
valves; all three are parameters the engine forces to exist, with values supplied
by the cascade (principle #3; the cascade is Composition §3):

| Valve                   | Mechanism                                                                                                                                                              | Why this shape is the right one                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sampling by visitor** | Keep-or-drop is decided **once for a whole session**, by a deterministic function of `visitor_ref` plus the period's salt — never a coin flip per event                | Sampling per _event_ produces a click with no page view in front of it: **every funnel ratio is wrong**, and wrong in a way nobody can detect from the data itself. Sampling per _visitor_ preserves the funnel's shape and only shrinks the sample |
| **Batching**            | N events become **one entry pointing at a blob in the Artifact Store**, in exactly the batch-event shape bulk import already uses (Working Data §1) — no new mechanism | The real cost is in the _number of entries_, not the payload bytes; batching cuts along the expensive axis and still leaves one trace for the whole batch                                                                                           |
| **TTL**                 | §6                                                                                                                                                                     | The only valve acting on **inventory**; the two above act only on **flow**                                                                                                                                                                          |

- **The sampling rate is data belonging to the batch, never configuration read at
  question time**: each batch entry carries the `sampling_rate` and the period
  salt actually used. This is §4's precondition — without it, "rebuild" has no
  definite meaning.
- **Ordering** follows Event Log §2's shape without borrowing its stream: total
  order per visitor session, with the **batch entry** as the unit of position. A
  projection declares gaps by position; half a batch never applies.
- **Three parameters the engine forces to exist before a single byte is
  written**: the sampling rate, the TTL, and the visitor's key (§5). A template
  supplies conservative values so a zero-configuration installation still runs;
  but **no write path exists while any one of the three fails to resolve** — the
  engine refuses and emits an entry saying why. There is no "write it in the
  clear and classify later" mode: undeclared means stricter, never looser.
- Entries in this tier reuse **the Event Log §1 entry schema** — id, timestamp,
  kind, schema version, actor identity, `entity@version` references, `run_kind`,
  payload — so reader tolerance, provenance and dedup are not written a second
  time. What they do not carry are its two promises: **completeness** and
  **permanence**.

## 4. What rebuild means on a sampled stream

The law that every view is a rebuildable projection stands (canonical: Event Log
§3). What has to be said plainly is **which stream is rebuilt, and what that
rebuild promises**.

- **Definition**: rebuild here means reconstructing **the same estimate from the
  same retained sample** — not reconstructing what happened. This stream was
  never a complete record, so it is not permitted to promise like one.
- **What makes it determinate — sampling happens exactly once, at the write
  boundary.** The keep-or-drop decision is already in the stream; **a reader
  never re-samples**. Two rebuilds produce the same number, and a machine can
  check that. The reasoning: a system that samples at read time produces two
  different numbers from two rebuilds and **nobody can prove which is right** — a
  projection stops being a projection and becomes a fresh measurement on every
  run.
- **What makes it honest — a number always travels with its rate.** Every
  projection over this tier carries the `sampling_rate` of the data it read and
  **may never be rendered as an exact count**. The engine forces the field to
  exist; how it is displayed is a template's value.
- **The retention window bounds the rebuild, and that has to be said rather than
  discovered.** TTL destroys segments (§6), so a rebuild reaches only as far back
  as the live window. Figures older than the window are **frozen materialised
  snapshots**, not recomputable — and a snapshot may hold **only aggregates that
  already passed the leakage gate's group floor** (§7). Retaining a per-visitor
  row past the TTL under the name "snapshot" is the TTL defeated by a rename, and
  is forbidden.
- **Falsifiable rather than asserted**: the sample's error is measured by the
  two-sided conversion reconciliation of §2. A sampled tier with no complete
  anchor to check against turns "this sample is representative" into a sentence
  nobody can test.

## 5. The visitor key — where it hangs on the key tree

- **A visitor is an unmerged Party** (Tenant & Identity §5): an external human,
  therefore **a data subject with erasure rights**. Not a new kind of subject.
- **The key is a subject key — tier 3 of the existing tree, and no fourth tier is
  created** (canonical: Vault §2, `root → tenant DEK → subject key`, "three is
  sufficient and is fixed"). The `subject_ref` is a `visitor_ref` minted at the
  write boundary: pseudonymous, stable, carrying no PII.
- **What that key encrypts**: every identifying or near-identifying field of the
  visit — network address, user agent, referrer with its parameters, and every
  attribute the subject supplied. What stays in the clear is only what identifies
  nobody.
- **The key must exist BEFORE the first entry.** "Shreddable" is a mechanism only
  when the key is present at write time; minting a key retroactively for data
  already written in the clear is **tidying up, not erasure** — and it never
  reaches the copy already sitting in a backup.
- **Merging on self-assertion** (Tenant & Identity §5): a visitor signs up or
  authenticates, and the identity merges into the Party that already exists.
  **No second key is minted and nothing is re-encrypted**: the
  `subject_ref → key_id` mapping is a projection of the log (Vault §2), so
  merging changes the
  **mapping** and never touches an old entry — exactly the rotate-is-not-shred
  law (Vault §4). The consequence has to be stated flatly: **shredding a Party
  means destroying every `key_id` that Party's lineage points at**, not only the
  most recent one. Missing one link of the lineage is an erasure promise that
  falls short.
- **The kinds-of-copy law applies verbatim, with not one word relaxed**
  (canonical: Event Log §4, Vault §3 limb (c)): a visitor key has no
  point-in-time copy of any sort, only forward-moving replicas. This is exactly
  where Vault §3 limb (b) already split by tier — root and tenant DEK have a DR
  path, **a subject key has none** — so this tier asks for no exception; it is
  one more consumer of a law that is already written.
- **The erasure command lives in the labour log, not in this tier**: destroying a
  key is a deliberate act through a Gate under the `key_admin` capability (Vault
  §4), which makes it **labour**, so its entry belongs where entries live
  forever. The consequence is deliberate and necessary: **the evidence of
  erasure outlives the erased data** — clickstream expires under §6 while the
  key-destruction entry remains, so _"prove that you erased me"_ is still
  answerable long after there is nothing left to erase.

## 6. TTL — mandatory, who sets it and who may change it

- **It must exist.** Undeclared resolves to the **shortest** value in the
  cascade, and never to unlimited — simpler means more conservative. Clickstream
  that outlives the analysis it was collected for is pure liability with no
  remaining upside.
- **Who may change it**, and who may not:

| Actor                                       | May change the TTL                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Role holding the matching capability      | **Yes** — as a Task through a Gate, and the change is an entry in the **labour** log, in the same shape as declassification (Knowledge §3) and migration (Working Data §1). The capability taxonomy is already open (Tenant & Identity §4, Role §2), so no second authorisation system appears |
| A lower cascade level (workspace, one site) | **Only downward** — it may narrow the value inherited from above, never widen it. The engine enforces the monotone direction; the number itself is a template's value (principle #3)                                                                                                           |
| The ingest path itself                      | **No.** There is no self-tuning loop that quietly extends retention because volume looked low                                                                                                                                                                                                  |
| An operator, outside the log                | **No path exists.** A TTL that can be changed without an entry is not a retention policy, it is a habit                                                                                                                                                                                        |

- **Raising the TTL revives nothing**: expired data is already destroyed, and the
  new value applies only to data written afterwards. The reasoning: if raising it
  could revive, the TTL was never deletion — it was concealment, and every
  retention promise resting on it was empty.
- **Expiry is a traced action**: each sweep emits an entry, on the same principle
  as _"dropping bytes is a traced action"_ (Artifact Store §3) — an audit never
  meets an unexplained hole.

**TTL and erasure are two mechanisms, for two purposes, and neither substitutes
for the other** — this is the easiest confusion in the whole document:

| Mechanism              | What it governs                            | How it acts                                                                                           | Where it does not reach                                                   |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **TTL**                | **Volume** held, and the liability with it | **Destroys segments** — legitimate here because this tier declares itself finite, unlike Event Log §4 | Not a copy that has already left the system in a backup                   |
| **Erasure on request** | A data subject's **right**                 | **Destroys the key** (§5) — effective on every copy, including one already inside a backup            | It frees not one byte: the data stays where it is, permanently unreadable |

## 7. Classification and egress — no new mechanism here

- A visitor record carries a **classification**; undeclared means `confidential`
  with external egress forbidden (canonical: Knowledge §3).
- Publishing an aggregate — an in-product dashboard, a public page, a report to a
  client — passes **floor propagation plus the leakage gate**, the same mechanism
  already used for aggregates drawn from a secret table (canonical: Working Data
  §1, Knowledge §3). Sending it outward is an external effect and takes the
  two-layer egress guard, static and runtime.
- **This tier's own risk — re-identification from a small sample**: an aggregate
  over a group small enough points at exactly one person. That mechanism already
  has a home: the same group floor multi-subject distillation carries (Memory §5,
  k-anonymity by floor propagation). The leakage gate is where it applies; this
  is not a second checkpoint.
- **The workspace dimension must be declared** (an agency with many clients): an
  aggregate projection declares its `scope`, and undeclared means the
  **narrowest** workspace containing every source — the same law as distillation
  (Memory §5). Client A's traffic figures never land _accidentally_ in client B's
  report.

## 8. Projections — the funnel is a view, not a second warehouse

- Funnel and traffic figures are **projections**, in the shape a view already
  has: readable by SQL over a snapshot, provenance `(log position, query text,
result hash)` — DataTable and Labor Analytics (Working Data §1, §4). No second
  analytics store appears, and Event Log §7's non-goal stands.
- **It is subject to the `run_kind` law like any other projection** (canonical:
  Event Log §3), and the reason is specific rather than ceremonial: a funnel
  projection **reads both streams** — the sampled visits here, and the complete
  conversion entries in the labour log (§2) — so it is a projection of the Event
  Log too, and it must declare its position explicitly with no silent default,
  **carrying its mandatory negative test in the suite that arbitrates it**. Its position has its
  own row in Event Log §3's table.
- An in-product dashboard is a tier-3 surface reading a projection, never engine
  (Working Data §4).

## 9. The acceptance test, made measurable

The requirement is stated flatly: **traffic can go up a hundredfold without the
labour Event Log growing.** Turning that into something a machine decides needs
one honest correction, which strengthens it rather than weakening it.

**The labour log grows with labour, not with visits.** A conversion _is_ labour —
a real signup creates a real process instance — so its entry must be in the
labour log, and a campaign that produces more signups legitimately produces more
entries. A test written as "the log does not grow under any campaign" would
therefore be false as stated, and a false test gets relaxed the first time it
fails.

**The measurable form**, which is what the ◆G3 conformance suite runs:

| Fixture | Visits          | Conversions           | Asserted                                                                                                                                 |
| ------- | --------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A       | baseline volume | a fixed set           | —                                                                                                                                        |
| B       | **100× A**      | **the same set as A** | The labour Event Log's **entry count, byte size, replay time and retention window are unchanged from A** — bit-for-bit on count and size |

So the property being pinned is exact: **labour-log growth is a function of the
conversion set and of nothing else.** The clickstream tier absorbs the whole
hundredfold in its own stream, under its own valves and its own TTL. A single
labour entry whose existence depends on the visit volume fails fixture B, and it
is a design defect rather than a tuning question.

The reason this must land **before the first event is written** is the same
reason the issue names: a log written the wrong way is not repaired by adding a
cap afterwards. The entries are already in it, and every projection has already
been rebuilt across them.

## 10. Non-goals

- Not a web-analytics product: no session recording, no heatmaps, no cross-site
  tracking, and **no fingerprinting** — no mechanism here mints an identity the
  subject did not supply.
- Not a source of truth for any labour decision (§2), and not a general message
  bus or shared application-log store.
- No sampling at read time, no unlimited TTL, and no write while the key, the
  TTL or the sampling rate fails to resolve.
- No silent self-tuning of the sampling rate — changing the rate is a change with
  an entry, not a quiet control loop.
- Not a third write path's precedent: the count of streams that originally record
  a fact stays at two, and a third would need this document's §1 argument made
  again from the beginning.

## 11. Decisions

| Question                        | Settled                                                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A separate log, or a label?** | **A separate log.** Three properties diverge at once — lifetime · kind of truth · who sizes it; `run_kind` suffices for two things of the same nature and cannot carry one of a different nature                                                     |
| Filtering in projections        | Rejected: the filter is correct on the read path, while log size, replay time and retention are paid on the **write** path and are not refundable                                                                                                    |
| Third-party analytics           | Rejected: putting a visitor record outside the classification lattice discards the only mechanism that answers "where may this data go"                                                                                                              |
| A second source of truth?       | No: different subjects (labour ≠ traffic), and §2 locks the read direction with static analysis                                                                                                                                                      |
| **What is sampled**             | **The visitor**, never the event — per-event sampling corrupts every funnel ratio in a way undetectable from the data itself                                                                                                                         |
| **Rebuild on a sampled stream** | Reconstruct **the same estimate from the same sample**; sampling happens once at the write boundary, the rate lives in the batch, a reader never re-samples ⇒ two rebuilds agree, machine-checkably. The rebuild reaches only across the live window |
| Figures older than the window   | Frozen materialised snapshots, holding **only** aggregates that already passed the group floor — never a per-visitor row surviving the TTL under another name                                                                                        |
| Sampling error                  | Measured, not assumed: a conversion appears on both sides, sampled and complete                                                                                                                                                                      |
| **The visitor key**             | **A tier-3 subject key on the existing tree** — no fourth tier and no second tree; it must exist before the first entry; merging changes the mapping and re-encrypts nothing; a shred covers **every `key_id` along the lineage**                    |
| Evidence of erasure             | The key-destruction entry lives in the **labour** log ⇒ it outlives the erased data, so "prove you erased me" is answerable after the TTL has swept everything away                                                                                  |
| **TTL versus erasure**          | Two mechanisms, two purposes: TTL destroys segments and governs **volume** (legitimate because this tier declares itself finite); erasure destroys the key and governs a **right** (it reaches backups). Neither substitutes for the other           |
| Who changes the TTL             | A Role with the capability, through a Gate, as an entry; a lower cascade level may only **narrow**; raising it **revives nothing**; no self-tuning path and no path outside the log                                                                  |
| Secrecy and publication         | No new mechanism: classification, floor propagation, the leakage gate, two-layer egress; the group floor against re-identification reuses multi-subject distillation's door                                                                          |
| The workspace dimension         | An aggregate projection declares its `scope`; undeclared means narrowest — client A's traffic never falls into client B's report                                                                                                                     |
| Zero configuration              | It runs at the most conservative setting, but **no clear-text write path exists**: a missing key, TTL or rate makes the engine refuse and emit an entry saying why                                                                                   |
| **The acceptance test**         | Fixed as a two-fixture assertion: 100× the visits with the conversion set held constant leaves the labour log's entry count, size, replay time and retention window unchanged — labour-log growth is a function of conversions and of nothing else   |

## Litmus

1. A campaign multiplies traffic a hundredfold for a week with the conversion set
   unchanged: are the labour Event Log's **entry count, byte size, replay time and
   retention window identical** to the baseline — measured as numbers rather than
   impressions?
2. Rebuild a funnel projection twice from the same stream: does it produce **the
   same number** — and does that number carry its sampling rate when displayed,
   instead of posing as an exact count?
3. A visitor asks to be forgotten: does **one key-destruction command** make every
   record of theirs unreadable, including one inside a backup older than the
   command — and is the evidence of erasure still retrievable after the TTL has
   swept the data away?
4. Raise the TTL: does already-expired data become readable again? (Required
   answer: no.)
5. Name **one path** by which a figure from this tier reaches a Judgment, a
   calibration input, or an engine routing decision. If one exists, §2's boundary
   is broken.
6. Configure nothing: does the tier run at its most conservative setting, write in
   the clear, or refuse silently? (Required: run conservatively; a refusal must
   carry an entry stating why; writing in the clear is a violation.)
7. Ask a funnel figure older than the retention window: does the system answer
   from a frozen aggregate snapshot and say so, or does it silently return a
   recomputed number over data that is no longer there?

## Failure modes

| Failure                                                | Detected by                                                 | Recovery                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The clickstream sink is overloaded or down             | Backpressure at the write boundary                          | **Lower the sampling rate or drop events — never spill into the labour log**; the reduction is an entry, so the projection can see the narrowed window |
| A batch blob is lost                                   | `exists(hash)` fails (Artifact Store failure modes)         | That batch drops out of the estimate; the projection declares the gap by position — never a half-applied batch                                         |
| The visitor key does not resolve                       | The engine refuses at the write door                        | An entry stating why; **no clear-text write path exists** — stopping is safer than running open, as at Vault §7                                        |
| The TTL sweep does not run                             | The oldest segment's age exceeds the declared value         | Escalation; **the limit is never widened automatically** — a missed TTL is an incident with a person on it, not a new value                            |
| A biased sample (bots, an abnormal campaign)           | The two-sided conversion reconciliation (§2) diverges       | Escalation for a person to decide; changing the rate is a change with an entry, not a control loop                                                     |
| Duplicate batch writes (at-least-once)                 | Dedup by batch id                                           | Idempotent, the duplicate is dropped — the same dedup mechanism as the Event Log's                                                                     |
| A shred misses one lineage link after a Party merge    | Reconciling the `key_id` set along the lineage at execution | **The shred is not reported complete** until every `key_id` is destroyed — the same law as a replica that has not acknowledged `destroy` (Vault §4)    |
| A snapshot outside the window holds per-visitor detail | The group floor is re-checked when a snapshot is written    | The snapshot is refused; only aggregates that passed the leakage gate may be frozen (§4, §7)                                                           |
