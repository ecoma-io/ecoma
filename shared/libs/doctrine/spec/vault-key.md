---
title: "Subsystem: Vault & Key Lifecycle"
status: design-end-state
---

# Subsystem: Vault & Key Lifecycle

## 1. Two responsibilities, one subsystem

| Responsibility                                                       | Serving                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Key lifecycle** — generating, rotating, destroying encryption keys | Crypto-shredding (Event Log §4), tenant erasure (Tenant §2b), PII-shredding mappings                    |
| **Secret store** — credentials used to _call outward_                | Rule fillers calling APIs, agent tool calls, RPA credential injection (Sandbox §2), model provider keys |

They share a subsystem because they share one law: **a value never leaves the
vault**; everything else holds only a **handle**.

## 2. The key tree — exactly three tiers

```
root key (KMS or a file — by deployment shape, §3)
  └── tenant DEK (one data key per tenant)
        └── subject key ((tenant, subject_ref) — Party, actor, PII mapping)
```

**Why exactly three.** With one tier you cannot shred _an individual_ — the law
demands erasing one Party, not a whole tenant. With an arbitrary number you
cannot rebuild the mapping. Three is sufficient and is fixed.

**Envelope encryption**: each tier wraps the one below, so destroying a tier
destroys the whole branch beneath it.

**The `subject_ref → key_id` mapping is a projection of the log** and can be
rebuilt; **key material never is** — it lives only in the vault backend. That
split is the reason §2 keeps them as separate things.

Entries and artifacts carry **the `key_id` used**, never the key. That is the
precondition for §4 to work at all.

## 3. The root key, by deployment shape (consistent with ADR-0002)

| Shape                                   | Root key                                                                                                  | Hard boundary                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Small stack (binary or one container)   | A file **outside the data directory**, mode 0600, with an explicitly declared path                        | **The backup script may not touch it** — checked by litmus #4 |
| Compose production / Kubernetes / cloud | A **KMS adapter** — envelope encryption, where KMS holds the root and the system holds only a wrapped DEK | The root never sits on the application disk                   |

**The cross-shape law has three limbs, and none can be dropped:**

| Limb                                  | The rule                                                                                                                                                                                                                                             | Why it cannot be dropped                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Outside the data backup**       | **The root key and every key sit OUTSIDE the data backup path**; escrow, where it exists, obeys the same shred command                                                                                                                               | Without (a): restoring a backup restores the data _and_ the key, so crypto-shredding is fiction                                                                                                                                                                                                                                                 |
| **(b) A separate DR path — PER TIER** | **The root key and tenant DEKs MUST have a separate backup and restore path**, declared explicitly in the deployment documentation. **A subject key has NO point-in-time copy at all** — it is the thing destroyed when a Party asks to be forgotten | Without (b): the disk dies, the data backup is intact, and nothing decrypts — "restore from backup" is an empty promise. Without the per-tier split, (b) kills (a): backing up _every_ key means a shredded key can be revived                                                                                                                  |
| **(c) Forward-moving replicas only**  | Every copy of key material must be **a replica a `destroy` command can replicate to**. **Point-in-time snapshots of the key store are forbidden** — vault snapshots, rewindable standbys, scheduled file backups of the vault                        | Without (c): (b) reopens (a)'s hole at a different door, because restoring a vault snapshot from before a shred revives the subject key. This is the reverse-direction interaction rule: a _recovery_ mechanism must declare what is sufficient to read, and a _deletion_ mechanism must cover every **kind** of copy, not merely every _place_ |

**Bootstrapping the root key is a mechanism, not an instruction.** Provisioning
(Tenant §2b) emits the root key **exactly once**, and **the engine demands a
confirmation challenge** — re-entering the checksum of the stored key — before the
tenant may become `active`. Passing or failing the challenge is **an entry in the
log**. A checkbox saying "I saved the key" is half a mechanism: it proves nothing.
A checksum proves something, and remains checkable later when an incident is being
investigated.

## 4. Rotate is not shred

|                          | Rotate                                                                                     | Shred                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Meaning                  | Limiting the blast radius over time                                                        | **Permanent data deletion**                                                                                 |
| Mechanism                | A new key for **new writes**; the old key is **kept for reading**                          | **Destroying the key** at the corresponding tier                                                            |
| Re-encrypt the old data? | **No** — re-encrypting an old entry means editing an old entry, which violates append-only | Not needed                                                                                                  |
| Result                   | Old data remains readable                                                                  | Old entries are **permanently undecryptable** — which is the intent, while the log stays structurally whole |

A shred is **an entry** in the log: who ordered it, the scope (subject or
tenant), the `key_id` destroyed, and when. The deletion itself still has
evidence, which is how the audit-versus-erasure paradox resolves: _the event
metadata stays, the content disappears_.

A shred **cannot be undone**, so the engine requires a Gate — the `key_admin`
capability, plus `distinct_filler_from` in a strict configuration.

**Shred against replicas**: the command applies **in the same pass** to every
forward-moving replica (§3, limb (c)). Any replica that does not acknowledge
`destroy` inside the declared window raises **an escalation, and the shred is
never reported complete**. Because point-in-time snapshots are already forbidden,
no copy exists beyond this command's reach — which is what makes litmus #7
passable.

## 5. The secret store — handles, never values

A secret has an **id, scope, version and lineage**. A consumer receives a
**handle** and never a value (Sandbox §2: injection at the driver layer, where
the executor never touches the value).

**What anyone can decrypt is a capability within a scope**, and every retrieval
is an entry (`secret_accessed` — actor, secret id, purpose), so abuse is
traceable and detectable.

Rotating a secret creates a new version; consumers pin the id rather than the
version, so rotation does not break a running process.

**The test boundary**: a **test run scope** (Test Harness §1) **cannot resolve a
production secret handle**. The engine refuses at the vault and emits an entry
saying why. The reasoning matters, because it is easy to assume this is already
covered: `test_behavior: forbidden` only blocks effects that **write** outward. A
test that reads real customer data with a real key is still a leak, and it is a
_read_ effect, so the contract door does not stop it. Running a test with real
secrets requires an explicit declaration and its own capability.

**Masking**: a secret value never reaches a log, an artifact or a notification.
Masking happens at the perception layer for RPA and at the adapter layer for the
platform, never as a redaction afterwards.

## 6. The adapter port

Possible backends: file-based for the small stack, a cloud KMS, HashiCorp Vault,
an HSM. The port's contract is `generate` / `wrap` / `unwrap` / `rotate` /
`destroy` / `get_secret`.

**Two conditions apply to all of them**, and a backend missing either is not
eligible to carry crypto-shredding, which must be declared explicitly in the
deployment documentation:

1. `destroy` **cannot be undone**.
2. It **does not provide — or allows disabling — every point-in-time snapshot or
   rewind mechanism over key material** (§3, limb (c)). A backend with a mandatory
   soft-delete recovery window is acceptable only if that window is declarable and
   **the shred reports completion only after the window closes**.

## 7. Non-goals

- No encryption algorithms are written here — standard primitives through audited
  libraries.
- No secret is stored outside the vault, and there is no unencrypted mode.
- No scheduled automatic shredding — a shred is always deliberate and passes a
  Gate.
- Bring-your-own-key is not managed today; the door is open through the adapter.

## 8. Decisions

| Question              | Settled                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The key tree          | Three fixed tiers: root → tenant DEK → subject key; the mapping is a projection, the key material is not                                                                                                                                                               |
| Root key              | By deployment shape — a file outside the data directory, or KMS; **always outside the backup path**; escrow obeys the same shred                                                                                                                                       |
| **Key recovery (DR)** | §3's three limbs: outside-backup, **mandatory DR for root and tenant DEK**, and **no point-in-time copy of a subject key**. The first two are inseparable — without the second, "restore from backup" is empty; without the per-tier split, the second kills the first |
| **Kinds of copy**     | **Forward-moving replicas only**; **point-in-time key-store snapshots forbidden**. Forbidding every _place_ is not enough — a _kind_ of copy has to go too, or the backup-versus-shred hole reappears at the vault door                                                |
| **Bootstrap**         | The root key is emitted once, with a **checksum challenge** before the tenant becomes `active`; the result is an entry. A "saved it" checkbox is half a mechanism                                                                                                      |
| **The test boundary** | A test run scope cannot resolve production secrets — `forbidden` blocks write effects, not reads                                                                                                                                                                       |
| Rotate                | No re-encryption, because append-only is inviolable; entries carry the `key_id`                                                                                                                                                                                        |
| Shred                 | Destroy the key; the shred is an entry; irreversible; through a Gate                                                                                                                                                                                                   |
| Secrets               | Handle-only, scope plus capability, every access an entry, masked at the source                                                                                                                                                                                        |
| Adapter               | Minimum condition: `destroy` is unrecoverable                                                                                                                                                                                                                          |

## Litmus

1. Shred a Party: is every entry and artifact holding their PII **no longer
   decryptable**, while the log still replays and every other entry is intact?
2. Rotate a key: does old data remain readable, with **no old entry rewritten**?
3. Restore the latest backup onto a blank machine: is previously shredded data
   **still unreadable**, because the key was never in the backup?
4. On the small stack: does the backup script touching the root key file make
   **the litmus fail**, checked automatically in CI?
5. Does any consumer — rule filler, agent, RPA driver — have a path to a secret's
   **value** rather than its handle?
6. **A blank machine plus the root key from the DR path**: does restoring the data
   backup make all **un-shredded** data readable and let the system reach
   `active`? And **without** a DR path, does the engine say plainly "this cannot
   be recovered" rather than pretending to work?
7. Shred a Party, then restore **every** surviving copy of a key — replica,
   escrow, standby: is that Party's data **still unreadable**, with no
   point-in-time key-store snapshot anywhere to try?

## Failure modes

| Failure                                            | Detected by                                                  | Recovery                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Total machine or disk loss**                     | No DEK can be unwrapped                                      | **Restore the root key from the §3(b) DR path** → restore the data → replay. **No DR means permanent loss, and that is declared design** rather than a hidden accident           |
| **A key-store snapshot exists against §3(c)**      | Backend configuration is checked at startup (condition §6.2) | The engine **refuses the crypto-shredding role** on that backend — it never promises to delete what it cannot delete                                                             |
| The vault backend is down                          | `unwrap` or `get_secret` fails                               | The task takes `on_fail` or escalates; **there is no run-unencrypted mode** (§7) — stopping is safer than running open                                                           |
| A replica does not acknowledge `destroy` in window | Per-replica acknowledgement reconciliation                   | **Escalation, and the shred is NOT reported complete** — the deletion promise is only made once every copy is dead                                                               |
| The root key is suspected compromised              | Anomalous `secret_accessed` audits, or an external report    | **Rotate the whole tree** — new key for new writes, old key kept for reading (§4). Rotation is **not** a shred; old data stays readable, and the exposure is assessed separately |
| The `subject_ref → key_id` mapping drifts          | A checksum by log position (Working Data §2)                 | Rebuild the projection from the log — **key material cannot be rebuilt**, which is why §2 keeps the two apart                                                                    |
| The bootstrap checksum challenge fails             | A `key_bootstrap_failed` entry                               | The tenant **stays in `provision`** and never reaches `active` (Tenant §2b) — no tenant runs whose owner cannot hold its key                                                     |
