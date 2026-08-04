---
title: "Subsystem: Event Log"
status: design-end-state
---

# Subsystem: Event Log

## 1. What it is

**Append-only, immutable, per tenant.** An entry is (id, **the stream it belongs
to and its position in that stream**, timestamp, kind, **the entry's schema
version**, full actor identity, `entity@version` references, **`run_kind:
production | test` plus `test_run_id` when it is a test**, **`prev_hash` — the
hash of the immediately preceding entry in the same stream**, payload). An engine
upgrade never rewrites old entries: readers are tolerant by schema version and
projections rebuild across versions.

Stream and position are fields of the entry rather than a property of how it is
stored, because everything else here already reads them: §2's total order _is_
the position within a stream, and the failure-modes table detects a lost segment
by "a gap in positions". A key two other sections depend on has to be in the
schema they depend on it through.

**`prev_hash` is in the tuple, not bolted on later, and the reason is the freeze
timing.** It chains each single-writer stream (§2) into a tamper-evident sequence
(§4b); §2's single-writer rule gives every entry a unique predecessor, so the
chain has no concurrency ambiguity. The hash is taken over the entry's **stored
form** — ciphertext plus metadata, never plaintext — so crypto-shredding (§4)
leaves the chain intact. It must exist before ◆G0 freezes this tuple: a chain
retrofitted after the freeze cannot backfill hashes without rewriting the log
(the upgrade law forbids exactly that, North Star §8), so every migrated
installation would begin its chain **mid-stream** — a genesis seam
byte-indistinguishable from the truncation attack the chain exists to expose
(§4b). Born with the stream, the genesis coincides with the stream's first entry
everywhere, forever.

A small payload sits inline; a large one is a hash into the Artifact Store — the
log holds the _truth_, the store holds the _bytes_ (Artifact Store §1).

The entry-kind taxonomy is **open**: task state, attempt, judgment, violation,
conflict, escalation, effect, handoff, trigger-in, GC, config change. The
self-tightening of T_high emitting an audit event (Checkpoint §4) has its formal
home here — **every runtime behaviour change of the engine is an entry**.

## 2. Ordering

**Total order per stream**, where each task, session or instance is a
single-writer stream — a node is the single writer of its session, the engine of
its task. No global clock is required.

Causality across streams travels through provenance and handoff references:
logical ordering plus timestamps, not a global clock. **A cross-stream reference
carries the referenced entry's hash, not only its id**, so rewriting a referenced
entry breaks the referring entry's validity too — tamper-evidence (§4b) travels
across streams the same way causality does.

The `prev_hash` chain (§1) is the **cryptographic form of this total order**: the
order is not merely recorded, it is committed to, so a reordering or a deletion
within a stream is detectable rather than merely disallowed.

## 3. Projections — the one-source-of-truth law

Every view is a projection, **rebuildable from the log**, and none may become a
second source of truth.

**The `run_kind` law**: entries carry `run_kind` (§1), and **every projection must
declare its position on that label explicitly**. The engine forces the
declaration to exist; there is no silent default.

The reasoning is specific. Test Harness §1 states the consequences for four
consumers — calibration, metering, DataTable, effects — but if the label has no
home, two engineers filter it in two different places and a projection written
later **forgets to filter at all**. The known projections' positions:

| Projection                   | Position on `run_kind: test`                                                                                                                                                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metering / cost              | **Excluded** from billable figures; the real cost incurred — tokens, sandbox CPU — is still measured separately, because it _did_ happen                                                                                                                    |
| Quota / consumption          | **Two positions, not one**: the plan counter is **excluded**, the resource counter **counts it in full** — "does not count against the plan" and "costs nothing" are different statements, and only the first is true of a test run (Quota & Scheduling §4) |
| Calibration input            | **Absolutely excluded** (Calibration §2 — the flywheel's hard boundary)                                                                                                                                                                                     |
| DataTable & Labor Analytics  | Split by label; production tables **do not see** a test run's writes                                                                                                                                                                                        |
| Audit export · Search        | **Included, labelled** — a test run is historical truth, not something to hide                                                                                                                                                                              |
| Notification feed            | **Excluded** by default, so it does not crowd the attention queue (invariant 3)                                                                                                                                                                             |
| Runtime-image inventory      | **Included, labelled** — the question is "who breaks if this image stops resolving", and a test run pinning it does (Runtime Sandbox §7)                                                                                                                    |
| Clickstream funnel & traffic | **Split by label** — production funnel figures do not see a test run's events; a synthetic visit is not a visitor, and these figures are sampled estimates besides (Clickstream Ingest §8)                                                                  |

**Checked by machine, not by care**: **every projection carries a negative test**
— run a fixture containing a `run_kind: test` entry and assert the production
numbers are unchanged. A new projection arriving without its negative test
**fails the suite that arbitrates it and is structurally blocked from merging**.

**The obligation travels with the projection, not with ◆G0.** That gate freezes
the entry schema and the storage-port contracts, and its suite's scope is closed
against everything else (ADR-0008 §4.2) — a projection is in neither, so a check
placed there is one nobody could ever add. It lands instead on whatever already
arbitrates the projection itself: the **◆G4** read-API suite for a projection
that gate exposes, and otherwise the projection's own arbiter, the pattern
ADR-0008 §4.3 names for behaviour no gate freezes. The obligation is unchanged —
only its carrier is, and it is now a carrier that can hold it.

An explicit position is only _advice_ if nobody checks it, and this is precisely
a **silent** class of error — forgetting to filter is invisible — so it has to be
caught in CI rather than in production.

| Projection                      | What it is                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Metering / cost**             | The cost function aggregated by (role, filler, task) — this is North Star §8's "metering is a mechanism"; pricing is policy laid on top |
| **Audit export**                | The log packaged to a compliance standard — the enterprise part is the _packaging_, the data is core                                    |
| **Search / query index**        | Finding instances, artifacts and judgments; the index is built from the log and rebuilt when broken                                     |
| **Notification feed**           | Rendered from escalation entries; a notification is a surface rendering, never a parallel system (Escalation §8)                        |
| **Calibration input**           | Layer C reading judgments, outcomes and conflicts from the log — one learning core fed from one source                                  |
| **DataTable & Labor Analytics** | Writable tables, where each write is an event, plus labour metrics (Working Data); time travel by log position                          |

## 4. Retention and the right to be forgotten

**Entry metadata is permanent** — it is the history. Large payloads follow the
Artifact Store's retention: the hash is permanent, the bytes follow policy.

A legal erasure obligation is reconciled with append-only through
**crypto-shredding**: sensitive payloads are encrypted under a per-data-subject
key, and erasing means destroying that key. The log is not punctured, the data
becomes unreadable, and the act of destroying the key is itself an entry.
(Data-subject identity: Tenant & Identity §6.)

**The key lives OUTSIDE the data backup path.** This closes the interaction
between backup/restore and erasure: the key store is a separate subsystem (the
tier-1 Vault), and **a backup of the log, the blobs or a projection never
contains a data-subject key**. Restoring a backup older than the shred does
**not** revive readability, because the key died elsewhere.

Key escrow, where a tenant enables it, is **an explicit opt-in with a stated
reason**, and a shred command **must apply to every escrow copy in the same
pass** — no copy of a key exists beyond the reach of a shred.

**The rule about kinds of copy**: forbidding every _place_ is not enough; a _kind_
of copy has to be forbidden too. Any copy of key material may only be a
**forward-moving replica**, one a `destroy` command can replicate to.
**Snapshots and point-in-time rewind of the key store are forbidden**, because
restoring a snapshot from before a shred revives exactly the key that was
destroyed — reopening the hole at a different door.

The opposite direction is also a mechanism rather than an operational habit: **the
root key and the tenant DEKs must have a separate DR path**, otherwise "restore
from backup" is an empty promise (canonical: Vault §3).

Every key creation, rotation, escrow and destruction is an entry.

The consequence, stated plainly: _the right to be forgotten is a property of the
**key lifecycle**, not of a data copy._ A system that keeps the key beside the
data has made every deletion promise it cannot keep.

## 4b. Tamper-evidence — the append-only guarantee against a database back door

"Append-only" is a promise about the engine's write path. It is not, by itself, a
promise about someone who **goes around** the engine — a tenant administrator with
a database back door, editing or deleting an entry directly, including the entry
recording their own override. Checksums and the gap-in-positions detector
(failure modes) catch _loss_ and _corruption_; they do not catch a deliberate,
internally-consistent _rewrite_. Invariant 2 promises that no action is
untraceable — including an override, which is a **signed** Judgment — and against
this persona that promise needs a mechanism, not only attribution. This section is
that mechanism, and it is deliberately built in three tiers whose limits are
stated rather than hidden, because the last tier is relational: it binds only when
a second party exists to hold the evidence.

| Tier                                                                                                                                                 | What it closes                                                                                                                                                                           | What it does **not** close                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) The per-stream hash chain** (`prev_hash`, §1; unique predecessor by §2)                                                                        | Accidental corruption and casual editing: any single rewrite leaves a break that chain verification finds                                                                                | A motivated admin who rewrites entry _N_ and recomputes the chain from _N_ forward — the chain alone is internally consistent again           |
| **(b) A signed head, on a cadence** (the engine signs the stream head with a key the database back door does not hold; batched, a cost valve — J6)   | A **SQL-only** back door (write access, no key access): it raises the bar from "UPDATE a row" to "UPDATE plus compromise the signing key", and makes the _scope_ of a compromise legible | A full-root administrator who holds every key — on a single-tenant self-host, they can re-sign the head after a rewrite                       |
| **(c) An external anchor** (the signed head is published outside the tenant's reach — a transparency log, a notary, or the operator's control-plane) | A full-root administrator: once head _H_ at time _t_ is anchored externally, no entry at position ≤ head(_t_) can be rewritten without diverging from the anchor                         | Anything before the first anchor; and it requires a **second party to anchor to**, which a lone self-host operator does not structurally have |

**The anchor default follows the deployment shape, and this is a mechanism, not a
convenience.** Where no operator exists — a self-host, the beachhead agency
holding all its own keys — the anchor is **opt-in**: a default-on anchor pointed
at a vendor would be read as the phone-home the ceiling forbids (North Star §7),
and it adds little against an admin who controls the config anyway. Where an
operator control-plane exists — a cloud install — the anchor is **on by default**
with the control-plane as witness, because there the connection already exists (it
provisioned the tenant, Tenant & Identity §2b) and the tenant-side persona who
could rewrite the tenant database provably cannot reach the operator's log. This
is **not** a phone-home under §7: the payload is exactly
`(tenant, stream-head hash, position, timestamp, engine signature)` and never
entry content; it grants nothing and gates nothing; and the runtime never blocks
on it — an anchor failure is an escalation entry, never a stall (Invariant 5).
Enabling, disabling or re-pointing the anchor is itself a chained entry, and the
witness exposes anchoring continuity, so a **gap** in the anchor stream is itself
evidence. By the same logic that binds the operator under Invariant 4, the
operator must publicly countersign its own witness log, because a tenant cannot
audit the control-plane.

**The honest limit, stated because the corpus states its limits.** On a pure
single-tenant self-host whose operator holds every key and enables no anchor, S70
is **not fully closable** — there is no cryptographic second party to be
accountable _to_. This is the shape of every legitimacy question here: closure is
relational, and the mechanism's value rises exactly as the accountability need
does (an agency answering to clients, a regulated tenant, an operator-run SaaS
whose control-plane is the witness). What tiers (a) and (b) still buy that
installation is real — a rewrite is no longer free, and the scope of a compromise
becomes legible — but the strongest tier is one the operator chooses to invoke.

**A legitimate restore must not look like the attack.** A disaster restore
followed by replay (Release & Compatibility) loses entries written after the
backup and re-signs a shorter chain; at the anchor, that is byte-indistinguishable
from a malicious rewind-and-rewrite. So a restore is an accountable act, not a
silence: it emits a **`restore` entry** — actor, reason, the position restored
to — that crosses the anchor like any head. The presence of an anchored `restore`
attestation is what distinguishes a legitimate restore from a truncation attack;
without it, an auditor's alarm would either fire on every honest DR drill or be
tuned to ignore exactly the attack.

**Crossings that hold** (each walked as a desk simulation): the chain binds
_ciphertext_, so crypto-shredding (§4) destroys a key while the ciphertext, its
hash and therefore the chain stay intact — and the shred is itself a chained
entry; projections (§3) are derived and untouched, so rebuild and time-travel are
unaffected; the clickstream tier (§7) has a TTL and no permanence promise, so the
chain covers the **labour** streams only; cross-stream tamper-evidence rides the
hash-carrying reference (§2).

## 5. Durable execution and timers

Durable execution follows from the log: state is reconstructed by replaying the
stream.

**Timers, SLAs and lease TTLs are registered as entries**, so an engine restart
replays them from the log. There is no timer living in someone's RAM waiting to
be forgotten.

## 6. Access

Reads require a contextual right — participation in the process, or a capability.
There is no public endpoint. Exporting the log is an external effect and egresses
by classification.

## 7. Non-goals

- Not a general message bus for external applications, and not a replacement
  analytics warehouse — analytics is a projection.
- No second source of truth. A state table that writes itself outside the log is
  a design violation.
- **Not the only write path, and not the one clickstream takes.** Web traffic is
  written to the clickstream ingest tier — a separate stream, with a TTL and no
  promise of completeness or permanence (Clickstream Ingest §1). That is not a
  second source of truth: its subject is traffic rather than labour, no labour
  decision may read it, and the single crossing is a conversion, which arrives
  here as an ordinary unsampled trigger entry (Clickstream Ingest §2).

## 8. Decisions

| Question                                   | Settled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role                                       | The single source of truth; every view is a rebuildable projection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **The second write path**                  | Clickstream is a separate stream rather than a `run_kind`-style label here: it diverges in lifetime, in kind of truth, and in who sizes it. Canonical home: Clickstream Ingest §1                                                                                                                                                                                                                                                                                                                                                                     |
| Ordering                                   | Total order per single-writer stream, with causality through references; no global clock                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Metering, audit, search, notification      | All projections — four floating concepts given a home in one decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Backup × the right to be forgotten         | The key lives outside the data backup path; escrow is opt-in but obeys the same shred, so restore is not a blind spot                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Kinds of key copy**                      | Forward-moving replicas only; **point-in-time snapshots of the key store are forbidden**; root and tenant DEKs must have DR. Forbidding every place is not enough if one _kind_ of copy can rewind                                                                                                                                                                                                                                                                                                                                                    |
| Append-only vs erasure                     | Crypto-shredding: destroy the key rather than puncture the log; the destruction is itself an entry                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Timers                                     | Entries, replayable — no timer outside the log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **The `run_kind` label**                   | Its canonical home is here (the entry in §1, the projection law in §3). Every projection **declares its position**, with no silent default, **and is subject to a mandatory negative test in the suite that arbitrates that projection** — ◆G4's read-API suite, or the projection's own arbiter (§3). A label with no home means a later projection forgets to filter; a declaration with no check means it still forgets, only in writing                                                                                                           |
| **Tamper-evidence** (§4b)                  | Three tiers — per-stream hash chain (`prev_hash` in the §1 tuple, over stored form), a signed head on a cadence, and an external anchor whose default follows the deployment shape (opt-in self-host, on-by-default cloud with the control-plane as witness). The anchor is not a phone-home: head hash only, blocks nothing. A legitimate restore emits an anchored `restore` entry so it is not mistaken for a truncation attack. The honest limit is stated: a lone self-host with no anchor cannot fully close S70, because closure is relational |
| **Why `prev_hash` is in the frozen tuple** | Landing the chain field before ◆G0 freezes §1 is a mechanism decision, not a schedule one: the upgrade law forbids rewriting the log (North Star §8), so a chain added after the freeze begins mid-stream on every migrated install — a genesis seam indistinguishable from the very truncation the chain exposes. Born with the stream, it never has that seam                                                                                                                                                                                       |

## Litmus

1. Do all projections — metering, search, notification, tables, calibration input
   — rebuild from the log to an equivalent result?
2. After a restart mid-flight, does every timer, SLA and lease fire correctly
   through replay?
3. Does crypto-shredding disable reading the PII without puncturing a single
   entry?
4. Restore a backup **older** than the shred command — is that data subject's
   data still unreadable, including from an escrow copy?
5. Write a **new** projection and deliberately omit its `run_kind` position: does
   the conformance suite arbitrating that projection **block the merge** — or does
   it only surface once the production numbers are already wrong on a real tenant?
6. A tenant administrator rewrites one already-written entry directly in the
   database and recomputes the chain forward: is the rewrite detectable **offline**
   against the signed head, and against the external anchor where one is enabled —
   or does verification pass because the chain is internally consistent again?
7. Take a legitimate disaster restore and a malicious rewind-and-rewrite to the
   same position: does the anchored `restore` entry distinguish them, or are they
   byte-indistinguishable at the anchor?

## Failure modes

| Failure                                                               | Detected by                                                                                                                                                                | Recovery                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A log segment lost or corrupt                                         | Checksum plus a gap in positions                                                                                                                                           | Restore the backup **plus the root key from the DR path** (Vault §3) → replay; rebuild projections                                                                                                                                                        |
| **Total machine loss**                                                | No DEK can be unwrapped after restore                                                                                                                                      | Recoverable only if **the root key has a DR path**. Without one it is permanently lost — and that is **declared design**, not a hidden accident                                                                                                           |
| Projection drift                                                      | A checksum against log position                                                                                                                                            | Rebuild from the log, with a warning event                                                                                                                                                                                                                |
| A timer missed after restart                                          | Replay scans for due entries                                                                                                                                               | Refire — a timer is an entry, never RAM                                                                                                                                                                                                                   |
| Duplicate writes (at-least-once)                                      | Event-id dedup                                                                                                                                                             | Idempotent; the duplicate is dropped                                                                                                                                                                                                                      |
| Restoring a backup older than a shred                                 | The key store is separate: the key is permanently gone                                                                                                                     | The data stays unreadable; the key-destruction entry is intact in the log                                                                                                                                                                                 |
| **An entry rewritten or the stream truncated** (a database back door) | Chain verification against the **signed head**, and against the **external anchor** where enabled — the rewrite either breaks the chain or diverges from the anchored head | Re-derive from a good replica or the anchored position; the divergence is itself the evidence. On a lone self-host with no anchor, tiers (a)/(b) make it non-free and legible but cannot fully prove it — **declared limit** (§4b), not a hidden accident |
