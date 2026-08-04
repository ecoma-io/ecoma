---
title: "Deploy & Operations Charter"
status: design-end-state
---

# Deploy & Operations Charter

## 1. The boundary — three partitions, three homes, never mixed

| Home                | Contents                                                                                                                                                      | Shipped to self-hosters?    | Licence                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------- |
| **`deploy/`**       | What a self-hoster **receives and runs**: compose files, a Helm chart, systemd units, an installer, the migration runner, edge-router configuration templates | ✅                          | SUL                       |
| **`cloud/`**        | The Cloud operator's IaC and control plane: fleet, billing, quota operations, automated provisioning                                                          | ❌                          | Proprietary, never public |
| **`shared/tools/`** | The **developer's** tooling: dev-cli, lint rules, repo-care                                                                                                   | ❌ — not a product artifact | SUL                       |

**The paid modules are not a fourth partition.** Enterprise features for
self-hosting — SSO, audit export, deep retention, advanced RBAC, and **not**
multi-tenancy — still reach a licensed self-hoster, but their source sits in the
unpublished workspace beside the control plane rather than in an
`<area>/enterprise/` directory of this repository. Publishing them under terms
granting nothing would have handed the code to every competitor while leaving the
buyer no rights in it, so what carries that tier is a repository boundary and not
a licence (North Star §8). The partition table above is a map of what this
repository holds, which is why they have no row in it.

**Single tenancy is a property of the SHAPE, not a technical limit of the
engine.** Every self-hosted installation, SUL or Enterprise, runs **exactly one
tenant**, because the workflow that creates a second ships only in `cloud/` —
**not** because the runtime checks a permission, which North Star §7 forbids. The
engine keeps the tenant tier in the key tree even at N=1 (Tenant §2c). This
charter therefore says **nothing** about multi-tenant provisioning; that belongs
to `cloud/`.

**The one-sentence law, which is this boundary's own litmus**: _every file in
`deploy/` must be useful to someone installing it themselves; a file only **we**
need is in the wrong place._

Getting the partition wrong in one direction — internal IaC leaking into
`deploy/` — **hands operational infrastructure to a competitor**. Getting it
wrong in the other — something a self-hoster needs sitting in `cloud/` — makes
**fair-code a claim on paper**, because the person installing it cannot stand the
system up. That is why there are _three_ partitions rather than two: team tooling
used to be where both kinds of mistake hid.

## 2. Deployment shape — a declaration of scale, not a switch

Two shapes (ADR-0002), each shipping a different set:

| Shape                                         | Default storage                                                   | What ships                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Small stack** — one binary or one container | SQLite plus DuckDB, a file-based vault                            | Binary or image, unit file, configuration templates, migration runner       |
| **Production** — compose or Helm              | Postgres (with pgvector and Timescale), an external vault backend | Chart or compose, secret templates, migration runner, edge-router templates |

**The shape is the installer's declaration of scale**, not a flag flipped at
runtime. Changing shape means the **grow path: replaying the log into a new
port** — a deliberate action, **never automatic**. A runtime switch would turn an
architectural decision into a configuration accident.

This charter does **not** declare the storage port's contract; that is ADR-0002
and Working Data.

## 3. The shipped artifacts, and how they travel together

The set is: the **server**, the **headless node runtime**, the **attended UI
layer** (ADR-0005), and **edge-router configuration templates** mounting `/`,
`/hub`, `/app` and `/design`, with the three security conditions that apply when
a domain is shared.

**All of them carry the same `train_version`** (Release & Compatibility §1). The
installer **refuses** a set that is out of step.

On an attended machine there are two artifacts on one train: the UI layer checks
at the in-machine handshake and **refuses to run** on a mismatch (Release &
Compatibility §8).

An artifact missing `train_version`, `source_digest`, provenance or a signature is
**refused at install**. There is no "install anyway" mode.

## 4. Keys and recovery — four obligations

This is the heaviest part of the charter. The underlying law is Vault §3 — three
limbs: outside the backup, a mandatory DR path for root and tenant DEK, and
forward-moving replicas only. The charter declares **the procedure**.

### 4.1 Generating and confirming the root key

Provisioning emits the root key **once**, then **demands a checksum challenge**
before the installation may enter service. The result is an entry. The written
procedure must name **exactly where to keep it** per shape, never in general
terms:

| Shape       | The root key's DR path, separate from the data backup                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small stack | An **off-machine copy** — a password manager, a sealed envelope, a USB kept elsewhere. The procedure names at least one concrete option rather than leaving the user to invent one |
| Production  | A KMS or HSM with **forward-moving replicas** that `destroy` can reach, and **no point-in-time snapshots** — backend eligibility is checked in §4.4                                |

### 4.2 Recovery onto a blank machine

The procedure has to work in this exact order: build the new machine → **load the
root key from the DR path** → restore the data → replay → verify by running a
query that reads data which was **not** shredded.

**With no root key the engine says plainly "this cannot be recovered"** rather
than pretending to start.

### 4.3 The gate: a backup may not touch a key

A new dev-cli command — **`check-backup-key-isolation`** — runs in the `checks`
job and in pre-commit, scanning every script, manifest and chart in `deploy/` and
**failing** if any path covers the root key's location under any shape.

The command **does not exist yet**. It lands together with the `deploy/`
directory, and it is tracked as an issue under the `doctrine-debt` label
rather than left as an instruction nobody is nurturing. It is the enactment of Vault's litmus #4. _"Do
not back up the key" is not a mechanism; a red gate is._

### 4.4 Key-store backend eligibility

The deployment documentation **states explicitly** which backends are eligible to
carry crypto-shredding: `destroy` must be **unrecoverable** **and** the backend
must not provide — or must allow disabling — **point-in-time snapshot and
rewind**. A backend with a mandatory recovery window is acceptable only if that
window is declarable and **a shred reports completion only after the window
closes**. A backend that does not qualify means the engine **refuses the
crypto-shredding role** rather than promising something it cannot do.

## 5. Backup and restore

**What goes into a backup**: the event log, artifact blobs, and optionally
projections — projections are rebuildable, so backing them up buys speed rather
than correctness.

**What NEVER goes into a backup**: key material, at every tier (Vault §3, limb
a).

**Retention against the support window**: retention **may not exceed** the
support window of Release & Compatibility §6, **unless** the charter declares an
explicit **restore path** — lifting an old backup through the sequential
migration chain — and that path has been rehearsed. Keeping five years of backups
while supporting two majors is holding a promise that cannot be kept. **Gate**: a
retention configuration exceeding the support window with no declared restore
path warns at startup rather than passing in silence.

**A restore rehearsal is mandatory and is an entry.** An installation that has
never attempted a restore holds a **hypothesis**, not insurance. The procedure
states a minimum cadence and **records each rehearsal's result in the log**.

## 6. Upgrade and rollback — the procedure

This follows the four phases of Release & Compatibility §4 — install beside,
migrate, cutover, retain. The charter adds the part a person performs.

**A mandatory preflight, before touching anything**: check that every artifact is
on the same train version; check that **every major migration in this step
declares a `down` path or the `irreversible_migration` flag**; where the flag is
present, **demand a Gate and a copy** before continuing; check that the most
recent backup has been rehearsed.

**Two different ways back, named correctly:**

| Inside the rollback window                                                       | Outside it                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rollback**: run the reverse path; the old artifact is still in place (phase 4) | **NOT a rollback** — it is **restore plus replay**: rebuild from backup, accept the data loss since that backup, with entirely different risk and duration |

The procedure **forbids** the word "rollback" for the right-hand column. An
operator presses a button according to the expectation the name carries; calling
two different things by one name is designing an incident.

## 7. Operating

**Health and readiness**: readiness turns green only once the vault opens, the
storage port answers, and the protocol registry has loaded. Turning green early
is lying to whatever is above.

**Logs and metrics**: to the installer's own **stdout or local endpoint**. **No
phone-home by default** — a ceiling constraint (North Star §7, Hub), not a
configuration option. Where an installer sends them is their business.

**Lease and heartbeat**: a procedure for a node that stops heartbeating — the
lease TTL expires and its task returns to the queue — and how to distinguish _a
dead node_ from _a node refusing to claim because of version skew_ (Release &
Compatibility §2). The two look identical on a dashboard and are handled in
opposite ways.

**Fleet view**: which node is on which train. That table is what makes Release &
Compatibility §2 operable at all.

## 8. Sunsetting an installation

Distinct from the **tenant lifecycle** (Tenant §2b): this is shutting down **an
entire installation**.

The order is **mandatory and may not be reversed**: (1) announce and close new
triggers → (2) let running tasks finish or escalate → (3) **export first**, into a
readable and complete format → (4) confirm the export is readable on another
machine → (5) **shred afterwards** — the keys, per Vault §4 → (6) tear down the
infrastructure.

Reversing (3) and (5) destroys the data permanently with a single command. Step
(4) exists because an export nobody has read is an export that does not exist —
the same reasoning as the restore rehearsal in §5.

## 9. Non-goals

- **No** Cloud operator IaC — that is `cloud/`.
- **No** storage port contract — that is ADR-0002 and Working Data.
- **No** build, branch or CI process.
- **No** tenant administration (Tenant §2b) — this charter governs an
  **installation**.
- **No** default telemetry, under any name.

## 10. Decisions

| Topic                      | Settled                                                                                                        | Reasoning                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The boundary               | **Three** partitions: `deploy/` ships, `cloud/` operates, `shared/tools/` develops                             | Two partitions let tooling slip through; one direction hands infrastructure to a competitor, the other makes fair-code a claim on paper |
| Shape                      | A declaration of scale, not a switch; the grow path is a deliberate replay                                     | A runtime switch turns an architectural decision into a configuration accident                                                          |
| The artifact set           | One train; the installer **refuses** a mismatched set                                                          | In-machine skew is invisible to every handshake channel the system has                                                                  |
| Root key DR                | The procedure names **a concrete location per shape**, never in general terms                                  | "Keep the key somewhere safe" is advice; a named location is a procedure                                                                |
| The backup-versus-key gate | `check-backup-key-isolation` in CI and pre-commit                                                              | Vault's litmus #4 is worth something only when something runs it                                                                        |
| Retention                  | Within the support window, or a declared and rehearsed restore path; exceeding it without one warns at startup | A backup nothing can read is an empty promise                                                                                           |
| Rehearsal                  | A mandatory restore drill, recorded as an entry                                                                | An untested backup is a hypothesis                                                                                                      |
| Two ways back              | Named correctly; calling a restore a "rollback" is **forbidden**                                               | An operator acts on the expectation the name carries                                                                                    |
| Readiness                  | Green only once vault, storage and the protocol registry are ready                                             | Turning green early is lying to whatever is above                                                                                       |
| Sunset                     | Export → **confirm it is readable** → shred, never reversed                                                    | Reversing loses everything with one command; an unread export does not exist                                                            |

## 11. Litmus

1. Hand `deploy/` to a stranger installing it themselves: can they stand the
   system up **without a single line from `cloud/`**?
2. The other direction: is there any file in `deploy/` that **only we** use —
   operational IaC hiding there?
3. Add a line to the backup script that covers the root key's path: does **CI go
   red**, or is there only a note in the documentation?
4. A blank machine plus the root key from the DR path: does running §4.2's
   procedure end with **reading** an un-shredded record? And **without** the root
   key, does the system **say plainly that it cannot be recovered** rather than
   half-starting?
5. Configure five-year retention against a two-major support window with no
   declared restore path: does the system **warn at startup**, or stay silent?
6. Read the rollback procedure: does it ever call _restore from backup_ a
   "rollback"? It must not.
7. A node that stopped heartbeating and a node refusing to claim because of skew:
   can the person on duty **tell them apart from the fleet view**, or must they
   guess?
8. Run the sunset procedure: is there any path to the shred step **that skips
   confirming the export is readable on another machine**?
9. Install a set where the attended UI layer is on a different train from the
   node runtime: does the installer **refuse**, or install and fail later?
