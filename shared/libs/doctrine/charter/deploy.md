---
title: "Ecoma — Deploy & Operations Charter"
status: design-end-state
---

# Ecoma — Deploy & Operations Charter

A charter, not a specification: it does not define a mechanism the product
promises a tenant. It defines how an operator installs, runs, backs up,
upgrades, rolls back and shuts down an installation — and where the boundary
falls between what a self-hoster receives and what stays with whoever runs the
hosted service.

## The boundary: three partitions, and no mixing

| Partition                  | What lives there                                                                                                                                 | Shipped to a self-hoster?   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| **Deployment**             | What a self-hoster **receives and runs**: compose files, charts, service units, installer, migration runner, edge-router configuration templates | Yes                         |
| **Operator control plane** | The hosted operator's infrastructure and control plane: fleet, billing, quota operations, automated provisioning                                 | No — proprietary            |
| **Developer tooling**      | The tooling of whoever develops the system: lint rules, workspace commands, repository automation                                                | No — not a product artifact |
| **Enterprise modules**     | Enterprise features for **self-hosting**: single sign-on, audit export, deep retention, advanced authorisation — and **not** multi-tenancy       | Yes, with a licence         |

**Single tenancy is a property of the deployment form, not a technical limit of
the engine.** Every self-hosted installation runs exactly one tenant, because the
workflow that creates a second one ships only in the operator's control plane —
**not** because the runtime checks an entitlement, which the
[Platform North Star](../north-star/platform.md) forbids outright. The engine
keeps the tenant layer in its key tree even at cardinality one. This charter
therefore says nothing about multi-tenant provisioning; that belongs to the
control plane.

**The litmus for the boundary is one sentence**: _every file in the deployment
partition must be useful to someone installing this themselves; a file only **we**
need is in the wrong place._

Getting it wrong in one direction — internal infrastructure leaking into what
ships — hands the operating playbook to a competitor. Getting it wrong in the
other — something a self-hoster needs living in the control plane — makes
fair-code true only on paper, because someone installing it themselves cannot
stand the system up. That is why the boundary has **three** partitions and not
two: developer tooling was where both mistakes used to hide.

## Deployment form is a declaration of scale, not a switch

Two forms, each shipping a different set:

| Form            | Storage default                                                                         | What ships                                                                        |
| --------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Small stack** | The embedded stack, with a file-based vault                                             | Binary or image, service unit, configuration templates, migration runner          |
| **Production**  | A single database carrying log, projections and vectors, with an external vault backend | Chart or compose files, secret templates, migration runner, edge-router templates |

The form is **the installer's declaration of scale**, not a flag flipped at
runtime. Changing form is a deliberate grow path — replay the log into the new
port — and is **never** automatic. A runtime switch would turn an architectural
decision into a configuration accident.

This charter does not define the storage port contract. That belongs to
[ADR-0002](../method/adr-ledger.md) and [Working Data](../spec/working-data.md).

## What ships, and how the pieces travel together

The server, the headless node runtime, the attended UI layer, and the
edge-router configuration templates that mount the public surfaces.

**All of them carry the same train version.** The installer **refuses** a set
that straddles two trains. On an attended machine there are two artifacts on one
host: the UI layer checks the train at its on-machine handshake and **refuses to
run** on a mismatch — that skew is invisible to every other handshake in the
system, so it needs its own check.

An artifact missing its train version, source digest, provenance or signature is
**refused at install**. There is no "install it anyway" mode, because that mode
is where an unsigned artifact enters a production system.

## Keys and recovery

This is the heaviest section of the charter. The underlying rules belong to
[Vault & Key](../spec/vault-key.md) — key material never enters a backup,
disaster recovery is mandatory for the root and tenant keys, and only
forward-only replicas may hold key material. What follows is the **procedure**.

### Generating and confirming the root key

Provisioning emits the root key **once**, then **demands a checksum challenge**
before letting the installation enter service. The result is a log entry. The
written procedure must name **exactly where it is kept**, per form, rather than
advising in general:

| Form        | The root key's recovery path, separate from the data backup path                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small stack | An off-machine copy — a password manager, a sealed envelope, a USB device stored separately. The procedure names at least one concrete option rather than leaving the operator to invent one |
| Production  | A key-management service or hardware module with a **forward-only replica**, no point-in-time snapshot. Eligibility is checked below                                                         |

"Keep the key somewhere safe" is advice. A named location is a procedure.

### Recovery onto a blank machine

The procedure must run in exactly this order: build a new machine → **load the
root key from the recovery path** → restore the data → replay → verify by
running a query that reads data which has **not** been shredded.

**With no root key, the engine states plainly that recovery is impossible.** It
does not start half way, because an installation that boots without the ability
to decrypt anything is an installation that looks recovered and is not.

### A gate: the backup must not touch the key

A workspace command, `check-backup-key-isolation`, runs in continuous
integration and before every commit: it scans every script, manifest and chart in
the deployment partition and **fails** if any path covers the root key's location
under any deployment form.

_"Do not back up the key" is advice; a red gate is a mechanism._

### Which key stores are eligible

The deployment documentation **states explicitly** which backends are eligible to
perform crypto-shredding: `destroy` must be **unrecoverable** and the backend must
not provide — or must permit disabling — point-in-time snapshot or rewind. A
backend with a mandatory recovery window qualifies only if that window is
declarable **and the shred command reports completion only after it closes**.

A backend that does not qualify means the engine **refuses the crypto-shredding
role** rather than promising an erasure it cannot perform.

## Backup and restore

**What goes into a backup**: the event log, artifact blobs, and optionally
projections — projections are rebuildable, so backing them up buys speed, never
correctness.

**What never goes into a backup**: key material, at every tier.

**Retention may not exceed the support window** defined by
[Release & Compatibility](../spec/release-compat.md), unless this charter
declares an explicit restore path — lifting an old backup through the sequence of
migrations — and that path has been rehearsed. Keeping five years of backups
while supporting two majors is keeping a promise that cannot be performed. A
retention setting that exceeds the support window with no declared restore path
**warns at startup** rather than passing silently.

**A restore rehearsal is mandatory and is a log entry.** An installation that has
never performed a test restore holds a **hypothesis**, not insurance. The
procedure names a minimum interval and records each rehearsal's outcome in the
log.

## Upgrade and rollback

The four phases — install alongside, migrate, cut over, retain — belong to
[Release & Compatibility](../spec/release-compat.md). This charter adds the part
a person performs.

**A preflight is mandatory before anything is touched**: confirm the train
version matches across every artifact; confirm **every major migration in this
step declares either a down-migration or an irreversible flag**; where the flag is
present, **demand a gate and a copy** before continuing; and confirm the most
recent backup has been rehearsed.

**Two different ways back, called by their correct names**:

| Inside the rollback window                                                         | Outside it                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Rollback**: run the inverse migration; the previous artifacts are still in place | **Not a rollback** — this is **restore and replay**: rebuild from a backup, accept the data lost since that backup. Different risk, different duration |

The procedure **forbids** using the word "rollback" for the right-hand column. An
operator presses a button according to the expectation attached to its name, so
calling two different operations by one name is designing an incident in advance.

## Operating

- **Health and readiness**: readiness turns green only once the vault opens, the
  storage port answers, and the protocol registry has loaded. Turning green early
  is lying to whatever is upstream.
- **Logs and metrics** go to the installer's own output or local endpoint. **No
  phone-home by default** — a constraint inherited from the ceiling, not a
  configuration option. Where an installer forwards them is their business.
- **Leases and heartbeats**: the procedure covers a node that loses its
  heartbeat, and — separately — how to tell that apart from a node **refusing to
  claim because it is outside the version skew window**. The two look alike on a
  dashboard and call for opposite responses.
- **Fleet view**: which node runs which train. This table is what makes the skew
  rule operable rather than theoretical.

## Shutting an installation down

This is distinct from a tenant's lifecycle: here the whole installation is being
switched off.

The order is **mandatory and may not be permuted**: (1) announce, and close new
triggers; (2) let running tasks finish or escalate; (3) **export first**, into a
readable and complete format; (4) confirm the export is readable **on a different
machine**; (5) **shred afterwards**; (6) destroy the infrastructure.

Swapping steps 3 and 5 loses the data permanently with one command. Step 4 exists
because an export nobody has read is an export that does not yet exist — the same
argument as the restore rehearsal above.

## Non-goals

- **Not** the hosted operator's infrastructure, which is not published.
- **Not** the storage port contract.
- **Not** build, branching or continuous integration.
- **Not** tenant administration — this charter governs an **installation**.
- **No** telemetry by default, under any name.

## Litmus

1. Hand the deployment partition to a stranger: can they stand the system up
   **without a single line from the operator control plane**?
2. The converse: is there a file in the deployment partition that only **we** use
   — operating infrastructure hiding in the shipped set?
3. Add a line to a backup script that covers the root key path: does continuous
   integration **turn red**, or is there only a note in a document?
4. A blank machine plus the root key from its recovery path: does the full
   procedure end with a **readable** unshredded record? And with **no** root key,
   does the system state plainly that it cannot recover, rather than starting half
   way?
5. Configure five years of retention against a two-major support window with no
   declared restore path: does the system **warn at startup**, or stay silent?
6. Read the rollback procedure: does it ever call restore-from-backup a
   "rollback"? (Required answer: no.)
7. A node that lost its heartbeat and a node refusing to claim because of version
   skew: can the person on duty **tell them apart from the fleet view**, or must
   they guess?
8. Run the shutdown procedure: is there any path to the shred step that has not
   passed through confirming the export is readable on another machine?
9. Install a set whose attended UI layer is on a different train from the node
   runtime: does the installer **refuse**, or install and break later?
