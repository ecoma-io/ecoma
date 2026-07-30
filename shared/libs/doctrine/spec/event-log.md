---
title: "Subsystem: Event Log"
status: design-end-state
---

# Subsystem: Event Log

## 1. What it is

**Append-only, immutable, per tenant.** An entry is (id, timestamp, kind, **the
entry's schema version**, full actor identity, `entity@version` references,
**`run_kind: production | test` plus `test_run_id` when it is a test**, payload).
An engine upgrade never rewrites old entries: readers are tolerant by schema
version and projections rebuild across versions.

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
logical ordering plus timestamps, not a global clock.

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

| Projection                  | Position on `run_kind: test`                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Metering / cost             | **Excluded** from billable figures; the real cost incurred — tokens, sandbox CPU — is still measured separately, because it _did_ happen |
| Calibration input           | **Absolutely excluded** (Calibration §2 — the flywheel's hard boundary)                                                                  |
| DataTable & Labor Analytics | Split by label; production tables **do not see** a test run's writes                                                                     |
| Audit export · Search       | **Included, labelled** — a test run is historical truth, not something to hide                                                           |
| Notification feed           | **Excluded** by default, so it does not crowd the attention queue (invariant 3)                                                          |

**Checked by machine, not by care**: the **◆G0** conformance suite carries **a
negative test for EVERY projection** — run a fixture containing a `run_kind: test`
entry and assert the production numbers are unchanged. A new projection arriving
without its negative test **fails the suite and is structurally blocked from
merging**.

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

## 8. Decisions

| Question                              | Settled                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role                                  | The single source of truth; every view is a rebuildable projection                                                                                                                                                                                                                                                                                 |
| Ordering                              | Total order per single-writer stream, with causality through references; no global clock                                                                                                                                                                                                                                                           |
| Metering, audit, search, notification | All projections — four floating concepts given a home in one decision                                                                                                                                                                                                                                                                              |
| Backup × the right to be forgotten    | The key lives outside the data backup path; escrow is opt-in but obeys the same shred, so restore is not a blind spot                                                                                                                                                                                                                              |
| **Kinds of key copy**                 | Forward-moving replicas only; **point-in-time snapshots of the key store are forbidden**; root and tenant DEKs must have DR. Forbidding every place is not enough if one _kind_ of copy can rewind                                                                                                                                                 |
| Append-only vs erasure                | Crypto-shredding: destroy the key rather than puncture the log; the destruction is itself an entry                                                                                                                                                                                                                                                 |
| Timers                                | Entries, replayable — no timer outside the log                                                                                                                                                                                                                                                                                                     |
| **The `run_kind` label**              | Its canonical home is here (the entry in §1, the projection law in §3). Every projection **declares its position**, with no silent default, **and is subject to a mandatory negative test in the ◆G0 suite**. A label with no home means a later projection forgets to filter; a declaration with no check means it still forgets, only in writing |

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
   the ◆G0 conformance suite **block the merge** — or does it only surface once
   the production numbers are already wrong on a real tenant?

## Failure modes

| Failure                               | Detected by                                            | Recovery                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| A log segment lost or corrupt         | Checksum plus a gap in positions                       | Restore the backup **plus the root key from the DR path** (Vault §3) → replay; rebuild projections                                              |
| **Total machine loss**                | No DEK can be unwrapped after restore                  | Recoverable only if **the root key has a DR path**. Without one it is permanently lost — and that is **declared design**, not a hidden accident |
| Projection drift                      | A checksum against log position                        | Rebuild from the log, with a warning event                                                                                                      |
| A timer missed after restart          | Replay scans for due entries                           | Refire — a timer is an entry, never RAM                                                                                                         |
| Duplicate writes (at-least-once)      | Event-id dedup                                         | Idempotent; the duplicate is dropped                                                                                                            |
| Restoring a backup older than a shred | The key store is separate: the key is permanently gone | The data stays unreadable; the key-destruction entry is intact in the log                                                                       |
