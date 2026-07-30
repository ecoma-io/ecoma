---
title: "Subsystem: Artifact Store"
status: design-end-state
---

# Subsystem: Artifact Store

> A **tier-1 subsystem of the Core engine** — not a domain, not an opt-in
> module: everything else stands on it. Bound by the four principles (canonical:
> North Star §3). Comparable products offer resource storage as a feature; here
> it is **invisible infrastructure with governance** — retention, residency and
> GC are mechanisms rather than manual operations.

## 1. Architecture — the truth is separate from the bytes

| Layer          | Holds                                                                                          | Character                                          |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Event log**  | Metadata, provenance, Judgments, and the hash of every artifact                                | The source of truth: small, append-only, permanent |
| **Blob store** | The actual bytes of artifacts, chunks, evidence, scenes and definitions, keyed by content hash | Large, with a lifecycle                            |

The consequence that matters: **losing a blob is not losing history**. The hash
in the event log still proves what existed, who created it and where it was
used, even after the bytes were cleared under policy.

## 2. Backends — an open adapter taxonomy

The engine knows only a minimal hash-keyed interface: `put / get / exists /
delete`. Backends plug in through adapters — a filesystem for the simplest
self-host, S3-compatible stores, cloud blob services — following the same
pattern as drivers, models and channels, each adapter carrying an identity and a
version.

Writes are streaming and multipart for large binaries such as video and
datasets, which is what makes Handoff's "reference plus verification depth"
decision affordable, and it is where RPA's "hash the stream immediately, upload
the blob lazily" behaviour belongs.

## 3. Lifecycle — the hash is permanent, the bytes follow policy

**GC is by reference.** A blob is kept while a running instance, provenance
inside the retention window, a lockfile or a pin still references it; once
nothing does, it is collected. That is the same logic as a Block uninstall
(Block §7) — one mechanism for every kind of thing, rather than a collector per
type that each drift apart.

**Retention is per artifact kind**, with the engine forcing the policy to exist
and a template supplying values. A deliverable is not RPA evidence and neither is
an intermediate scene; heavy evidence has a path to cold storage, or to having
its bytes dropped and its hash kept after N days.

Dropping bytes is a traced action — the event log records that a blob was cleared
under policy P — so an audit never meets an unexplained hole.

## 4. Tenant, secrecy and residency

Blobs are namespaced **per tenant**, and encrypted at rest under the tenant's
key. A tenant managing its own key is an enterprise extension point.

**Deduplication happens only within a tenant.** Cross-tenant dedup is explicitly
forbidden: content addressing across tenants is a side channel — it reveals that
another tenant holds the same content — and that violates invariant 4. The
efficiency gain is real and is refused on purpose.

**Storage policy follows classification** (continuing Knowledge §3's lattice).
The secrecy level decides the residency region, which backends are permitted, and
what encryption is required. Nothing classified `secret` sits on a backend
outside the approved list.

## 5. External sources

An artifact may _point_ into an external system — Drive, SharePoint, a URL — but
the reference **must carry a hash snapshot taken at ingest**. External sources
are mutable, so a later read whose hash differs is a **Violation**: the content
changed underfoot, and it is handled by the handoff policy. Wanting stability
means materialising the bytes into the store, which is an explicit action rather
than something that happens quietly.

## 6. Access

Machine path: every consumer — executor, verifier, inbox renderer — reads through
the engine by hash plus contextual right, meaning participation in the task or
process, or a Role grant where knowledge is involved. There is no public URL by
default, and a share link leaving the system is an **external effect**, subject to
egress by classification.

Free browsing outside a task context follows the grant-union and read-event
mechanism in **Tenant & Identity §4**.

## 7. Boundaries

**The Hub is the distribution store** — static, cross-tenant, immutable with
yank. **The Artifact Store is the runtime store** — per tenant, with a lifecycle.
Installing a block pulls from the Hub and materialises into the tenant's store.
The two roles never merge; a store that was also a registry would have to be
immutable and lifecycled at once.

The store does not interpret content — that belongs to perception, verifiers and
renderers. It holds bytes and a hash.

## 8. Non-goals

- Not a file manager or DMS for end users; no public bucket by default.
- No cross-tenant dedup, and no silent deletion — every GC emits an event.
- No automatic materialisation of an external source; that is an explicit action.

## 9. Decisions

| Question         | Settled                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Where it sits    | A tier-1 Core engine subsystem — not a domain, not a module                                             |
| Truth vs bytes   | The event log holds the truth permanently; blobs have a lifecycle — losing a blob is not losing history |
| GC               | By reference plus per-kind retention; every deletion emits an event                                     |
| Dedup            | Within a tenant only — cross-tenant is a side channel, and is forbidden                                 |
| Secrecy          | Storage policy from the classification lattice; per-tenant encryption; residency                        |
| External sources | Reference plus a mandatory hash snapshot; a mismatch is a Violation                                     |
| The Hub          | Distribution store and runtime store are two roles, kept apart                                          |

## Litmus

1. After a blob is cleared under policy, do provenance and hash still prove the
   full history?
2. Is there genuinely no cross-tenant dedup path, even for an identical content
   hash?
3. When an external source changes, is the hash mismatch caught at read time and
   turned into a Violation?

## Failure modes

| Failure                    | Detected by                             | Recovery                                                                                             |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A blob is lost             | `exists(hash)` fails                    | Re-materialise from the source; where the bytes are gone, the hash and event still prove the history |
| The backend is down        | `put`/`get` errors                      | Retry, then the task's `on_fail` or escalation; no truth is lost, since it is in the log             |
| An external source changed | Hash mismatch at read time              | A Violation, handled by the handoff policy                                                           |
| GC misjudged a reference   | Two-phase GC plus an event per deletion | Restore from backup; the truth was never lost                                                        |
