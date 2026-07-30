---
title: "Tenant & Identity"
status: design-end-state
---

# Tenant & Identity

## 1. Principal — one identity schema for every actor

Every entry in the Event Log carries a **principal identity**. The taxonomy is
open; the standard kinds:

| Kind                                    | Identity                                                                                                                                                                          | Defined in     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `user` — a person inside the tenant     | A **pseudonymous stable id**, permanently immutable, with the PII mapping held separately (§6); authentication through an auth adapter, with SSO as an enterprise extension point | Here           |
| `agent`                                 | (model, version, config_hash) plus lineage                                                                                                                                        | Role §3        |
| `rule`                                  | (code, version)                                                                                                                                                                   | Role §3        |
| `node`                                  | A device keypair plus enrollment                                                                                                                                                  | RPA North Star |
| `external` — outside, through a Channel | A channel identity, unified into a **Party** (§5)                                                                                                                                 | Trigger §3     |

Changing SSO provider means changing an auth adapter — **the actor id in the log
never changes**. That separation is what lets an audit trail outlive an identity
vendor.

## 2. Tenant — the only hard boundary

**Cardinality ≥ 1**: every concept is namespaced by tenant — entity libraries,
calibration, cascade, lockfile, blob namespace, event log. Self-hosting is a
single tenant; Cloud is N tenants, with **no code branch differing between
them**.

A tenant is the boundary of data ownership, learning (invariant 4), encryption,
deduplication, and default egress.

## 2b. Tenant lifecycle — provision → active → suspended → export → purge

A tenant is an entity, so it has a lifecycle like every other entity rather than
being an operational concept belonging only to SaaS:

| Stage       | Mechanism                                                                                                                                                                                                               | Notes                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provision` | **An ecoma process** (North Star §8): create the log and blob namespaces, the root key, a default workspace, and a first user filling an administrative Role                                                            | Self-hosting runs exactly that process at cardinality 1                                                                                                                                                                                                |
| `active`    | The ordinary state                                                                                                                                                                                                      |                                                                                                                                                                                                                                                        |
| `suspended` | The engine forces **the state to exist**; the reasons — overdue, abuse, the tenant's own request — are **policy**                                                                                                       | Suspended means **writes frozen, nothing deleted**: triggers refuse at the boundary, nodes refuse to claim, running tasks take `escalate` or `halt` — **never auto-pass and never self-destruct** (invariant 5). Reading and export continue by policy |
| `export`    | **A Task of a Role with a Gate**: audit export, BYO-export projections, and blobs by classification (Working Data §4, Artifact Store §6), egressing by classification like any effect                                   | The right to take your data with you is a mechanism, not the operator's goodwill                                                                                                                                                                       |
| `purge`     | Destroy the **tenant root key** (crypto-shredding, Event Log §4, including every escrow copy) → GC the blob namespace by reference → write the final entry into the **operator's** log, not into the log that just died | Irreversible; the engine requires `export` to have completed, or an explicit waiver, before purge is permitted                                                                                                                                         |

Every transition is **an event with an actor**. There is no path to changing a
tenant's state outside the log.

## 2c. Cardinality by shape — a multi-tenant engine, a single-tenant self-host

| Limb                                     | The rule                                                                                                                                                                    | Reasoning                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The engine is always tenant-aware**    | The key tree root → tenant DEK → subject, a per-tenant log, RBAC scopes, dedup only within a tenant, per-tenant metering. **The tenant tier exists PHYSICALLY even at N=1** | Removing the tenant tier "to keep it tidy while there is only one" turns any later move to multi-tenancy into **migrating every key** — the kind of migration with no way back                                                                                                      |
| **Self-host is exactly one tenant**      | There is no workflow for creating a second tenant, because **the provisioning workflow ships only in `cloud/`**                                                             | **The cap is a PRODUCT boundary, not a licence check.** North Star §7 forbids it outright: the runtime never checks entitlement, holds no licence key, and phones home to nobody. Technically the engine holds N tenants; there is simply nothing shipped that creates a second one |
| **Multi-tenancy grants no capability**   | Two tenants on one installation are equivalent to two installations **in every product respect**                                                                            | **Invariant 4** forbids cross-tenant learning, so there is no shared calibration, memory or knowledge. The only difference is **one infrastructure cluster instead of two** — an operational economy, which is exactly what a SaaS vendor sells                                     |
| **Invariant 4 binds the Cloud operator** | The operator **may** aggregate metering across tenants. The operator **NEVER** routes knowledge, memory or calibration across them                                          | The code enforcing this lives in a private repository that outsiders **cannot audit**, so the boundary has to be declared publicly and carry a litmus — otherwise it is only a promise                                                                                              |

**A consequence worth recording**: because multi-tenancy adds no capability, **a
conformance suite run on a self-host is sufficient to prove the engine correct**;
`cloud/` only wraps provisioning, billing and fleet management around it. The
private part is therefore **small and boring** — which is what we want: the
questionable parts are public and the private parts are dull. Had multi-tenancy
been an enterprise feature, the opposite would hold, and the riskiest code would
be the most expensive and least observed.

## 3. Workspace — a soft partition inside a tenant

A workspace is an **organisational divider** — an agency gives each client one.
It scopes visibility and grants, and it is **a dimension of the calibration key**,
which is what lets an agency separate quality per client.

**It is NOT a security boundary — stated plainly, here and on every sales page.**
A workspace is an **administrative and visibility** boundary. Within one tenant,
artifacts **may be deduplicated** (only cross-tenant dedup is forbidden — Artifact
Store §4), there is **one** tenant DEK, and one log namespace. An agency serving
two competing brands that says _"the two are isolated"_ **is saying something
false**. The true sentence is: _"your data does not leave the agency's
installation"_ — the agency is the data controller, exactly as in any ordinary
agency-client relationship. The upgrade path is real and natural: **wanting a
security boundary means wanting a tenant, which means a second installation or
Cloud.**

The tenant remains the encryption and learning boundary; sharing across
workspaces is an explicit grant. Whether learning pools or splits across
workspaces is **a template value** — the engine forces the dimension to exist and
the agency chooses.

At n=1 there is one default workspace, invisible.

## 4. One permission system — administration is labour too

**There is no "admin user type."** An administrator is a person — or,
mechanically, an agent, though the template default requires a human — **filling a
Role with administrative capabilities**: `enroll_node`, `approve_code`,
`manage_membership`, `grant_capability`, `manage_workspace`. The existing open
capability taxonomy (Role §2) now covers administration too.

**Process owner** is a Role declared in a Process definition, and the default
Arbiter and terminal handler; the template default is whoever created the
definition.

Administrative actions are **Tasks with Gates, like all labour** — approving an
enrollment, granting a capability. Traced, approved, dogfooded completely.

**Browsing outside a task**: a user's read access is **the union of the grants
belonging to the Roles whose pool they are in** — never a second ACL list. Reading
content at a secrecy level emits a **read event**; the engine forces the
per-level parameter to exist and a template supplies it, with `secret` recording
every read by default.

Membership — a user joining a tenant, a workspace, a Role pool — is an event, so
permission changes have a complete history.

**The Cloud operations console is a SURFACE over this same system, not a second
user system.** `cloud/` holds internal administration — creating tenants,
managing users, configuring SaaS — but operations staff **fill a Role with
administrative capabilities** exactly like anyone else, and every action they take
is **a Task with a Gate and a trace**. Building a separate user table for
operators would build **a second source of truth about identity** and break the
"no admin user type" rule directly above. This is a ceiling constraint placed on
`cloud/`, not a choice `cloud/` gets to make.

## 5. Party — unifying external identities

A **Party** is one external person or organisation, unifying several channel
identities — a messenger id, an email, a phone number. A Party is the **subject of
Memory** and the **data subject** of erasure.

**Merging is a Task with a Gate and never automatic.** Merging two channel
identities wrongly leaks one person's memory to another, violating cross-subject
isolation (Memory §4). The system may only _propose_ a merge; deciding is traced
labour. Merges and splits carry **lineage**, so a mistake can be undone.

**One reasoned exception — self-assertion**: when the subject proves they own the
other identity through _authentication_ — verifying an email or an OTP when
signing up from a channel they already used — unification happens without a Gate.
The evidence is authentication rather than inference. It is still an event with
provenance, and still reversible through lineage.

Calibration over an external party exists mechanically and is off by default
(Trigger §3), repeated here because this is that decision's home.

## 6. Data subjects and the right to be forgotten

**The actor id in the log is pseudonymous and permanent** and is never shredded —
the audit trail is part of the product. The **PII mapping** — name, email, avatar
against id — lives in a separate table encrypted under the data-subject key.

Erasure, whether an employee leaving under GDPR or a chat customer asking to be
forgotten, is **crypto-shredding that party or user's key** (Event Log §4): the
mapping dies, the personal payload dies, and the labour structure — who approved
what, under a pseudonym — survives intact. Destroying the key is an event.

The boundary, stated explicitly: **work product belongs to the tenant** —
artifacts, judgments — while _personal identity_ belongs to the data subject. The
two separate because of the pseudonym, not because of a promise.

**A backup is not an erasure blind spot**: the key lives outside the data backup
path and escrow obeys the same shred, canonically at **Event Log §4**.

## 7. External collaboration — no second-class guest user

An agency's client approving a deliverable, a candidate confirming a schedule, a
partner initialling a document — **all of them are external fillers filling a Role
through a Channel**, where a portal or magic link is just another channel. The
reply is task output, passes a Gate, and carries provenance.

No tenant account, no separate guest system. The external-participant grammar
(Trigger §3) already covers it; this document only nails it down: **inviting an
outsider means assigning them to a Role, not issuing them an account.**

## 8. Enterprise extension points

The engine declares them and enterprise supplies implementations:
`authn_provider` (SSO, SAML, OIDC), `scim_provisioning` (membership sync, where
each change is still an event), `audit_packaging`, `pii_vault_backend` (the tenant
holding its own data-subject keys), and `calibration_visibility_policy` — who can
see calibration about a person, which is sensitive assessment data, defaulting to
Roles holding `view_calibration` within the scope.

## 9. Zero configuration

At n=1 nothing in this document is visible: one tenant, one invisible workspace,
the first user filling every administrative Role by template, and parties arising
naturally from channels. The concepts only _appear_ as the organisation grows —
with no rewrite.

## 10. Non-goals

- No second ACL or RBAC system beside Role + capability + grant, and no guest
  accounts.
- No automatic party merging in any default configuration.
- Actor ids and the labour structure are never shredded — only the PII payload
  and mapping.
- No home-grown identity provider; authentication is an adapter.

## 11. Litmus

1. At n=1 with zero configuration: is every concept in this document invisible?
2. An employee leaves and asks to be forgotten: does the audit trail stay intact
   under a pseudonym while the PII dies from one key destruction?
3. Is there any path that merges two channel identities without a Gate?
4. Can an agency's client approve a deliverable without a tenant account?
5. **Falsifiable**: name one permission that cannot be expressed as Role +
   capability + grant.
6. Change SSO provider — is the actor id in the log unchanged?
7. A tenant is suspended with fifty tasks running: does no task auto-pass, is no
   data deleted, and does export still work?
8. On a self-host installation: is there **any path** to creating a second
   tenant — and if not, does the engine refuse because **the workflow is absent**
   or because it **checked an entitlement**? It must be the former; an
   entitlement check violates the ceiling's §7.
9. On Cloud: does the operator have any path by which tenant A's knowledge,
   memory or calibration influences tenant B — including indirectly through a
   commonly tuned model? And does the operations console have **its own user
   table**, or are operations staff also just people filling a Role?
10. On an N=1 installation: **does the tenant tier still physically exist in the
    key tree**, or has it been collapsed away "for tidiness"?

## 12. Decisions

| Question                  | Settled                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| The permission system     | One and only one: Role + capability + grant; admin and process-owner are filled Roles; administration is gated labour                        |
| Workspace                 | A soft wall: grant scope plus a calibration dimension; the tenant is the hard boundary; cross-workspace learning pools are a template value  |
| Party                     | Merged through a Gate with lineage — a wrong merge leaks memory between people                                                               |
| The right to be forgotten | A permanent pseudonymous actor id plus a shreddable PII mapping — the audit lives, the person is forgotten                                   |
| Outsiders                 | External fillers filling a Role through a Channel — no guest accounts                                                                        |
| Browsing outside a task   | The union of grants across the Roles in whose pool the user sits, plus a read event by secrecy level                                         |
| SSO / SCIM                | An adapter and an enterprise extension point; membership changes are still events; the actor id is independent of the IdP                    |
| Tenant lifecycle          | provision (a process) → suspended (writes frozen, nothing auto-destroyed) → export (a gated Task) → purge (root key destroyed plus GC) — §2b |
