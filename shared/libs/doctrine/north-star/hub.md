---
title: "Ecoma Hub — North Star"
status: design-end-state
---

# Ecoma Hub — North Star

## The end state

**Ecoma Hub is the packaging, distribution and sharing infrastructure for every
entity in the system, in the form of Blocks: one registry protocol
(content-addressed, signed, with a transparency log), one immutable public
instance, any number of private mirrors, and one index and marketplace — where a
community extends the long tail of process knowledge and publishers can afford to
maintain it. With Hub absent, every installed runtime keeps running, forever.**

The mechanism principles it specialises are canonical in the
[Platform North Star](platform.md) and are not restated here.

## The problem

"Template" is the concept the default cascade rests on, and it needs a real
distribution mechanism rather than a name. Application profiles need a catalogue.
The long tail of connectors and processes cannot be written by one company.

More decisive: **process knowledge is a kind of content that ages.**
Applications change their interfaces; regulations change. Sharing without an
economy of maintenance produces a graveyard of templates that were correct once.
Hub therefore couples the distribution mechanism to the economic engine, because
only one of those keeps content alive.

## Mechanism principles

1. **Hub never touches runtime**: no entitlement check while running, no
   phone-home, no licence key in the engine. Commercialisation stops at the
   distribution layer — pull and update.
2. **The digest is the truth; semantic versions are a human interface.** Machines
   pin digests in a lockfile; people say a name and a range. The public instance
   is immutable: what is published is never deleted, only withdrawn from
   resolution, so an existing pin keeps working forever.
3. **Publishers are not trusted.** A tenant re-runs static analysis at install
   time, and a manifest that declares less than the analysis finds is rejected
   rather than warned about. Signatures and a transparency log defend against
   tampering across mirrors.
4. **Content trust reuses the mechanisms that already exist.** A filler inside a
   block starts at a low trust tier because it has no calibration in this tenant;
   a block containing an irreversible effect is floored at a gate. There is no
   separate runtime moderation system, because a second one would need its own
   evidence and its own appeal path.
5. **Hub is blind to tenant data.** It never sees calibration and receives no
   telemetry without opt-in. A publisher sees installs and revenue, nothing else.

## Three layers

| Layer           | What it holds                                                                                                       | Notes                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Registry**    | An artifact store on the standard container conventions: digest, publisher signature, attestation, transparency log | A private one is any existing registry; air-gapped mirroring uses standard commands                                 |
| **Index**       | The catalogue: search, publisher and name namespaces, block pages, a verified badge, version history                | A namespace is owned through publisher identity, so squatting is answered by identity rather than by policing names |
| **Marketplace** | Listings, prices, entitlement, payment, revenue-share payout                                                        | A thin commercial layer over the index, not a separate system                                                       |

The index and marketplace front end is an application belonging to this domain,
mounted by the operator at the public edge. It renders **statically first**, with
revalidation driven by registry events — a direct consequence of content
immutability: a page for one block version can be cached forever, and only the
pointer needs to revalidate.

A parallel development channel exists: blocks are developed in git, where forks
and reviews give lineage and review for free, and packing, signing and pushing is
the act of release. The escape hatch — adding a block straight from a git
revision — is labelled `unverified` and exists for development and internal use.

## One client interface, and only one

Platform and RPA — including standalone RPA — speak to Hub through exactly three
verbs: **`resolve` / `pull` / `verify`**. Hub does not know how a block runs; the
runtime does not know how a block is stored or sold. The interface and the
manifest schema are permissively licensed, so a third party can build a
compatible registry without asking.

## The marketplace mechanism

- **Entitlement is checked at exactly one place: distribution.** Let a
  subscription lapse and everything already installed runs forever, pinned by
  digest; what is lost is the update stream. This is the same rule as principle 1,
  seen from the buyer's side.
- **Pricing shapes**: free, one-time (a permanent entitlement within a major),
  subscription (the right to pull the update stream), and site licence.
- **No digital restrictions.** A definition is text and can be copied. What is
  sold is the update stream, the maintenance behind it — an application profile
  that keeps up as interfaces change — and the trust of a verified publisher. A
  subscription to an application profile is the economic answer to "who maintains
  this automation when the interface changes", which is the question that kills
  most automation programmes.
- Two content licence tiers: a free catalogue under permissive terms, and paid
  blocks under the publisher's own terms, declared explicitly at publish time.

## Trust and the supply chain

- **Publishing** is: pack (including full static analysis at pack time), sign,
  push, index. A knowledge collection inside a block may enter the public instance
  only at the public classification, so the declassification gate stands in front
  of every publish.
- **The verified badge** is awarded by a review that is itself an Ecoma workflow —
  Hub runs as a tenant of Platform for its own curation. The result is a signed
  attestation attached to the artifact.
- **Self-approval is structurally impossible**, which matters because this is the
  only door for `code` artifacts. The reviewer Role declares that its filler must
  be distinct from the publisher, and the operator fills it: a publisher never
  fills the Role reviewing their own block. Each outcome is a signed Judgment, and
  the reviewer's own calibration absorbs the downstream outcome like any other
  Role.
- **Withdrawal is an event.** A signed digest never changes — it is immutable —
  but the badge falls away, that publisher's `code` artifacts return to being
  rejected by default, and the index treats it as withdrawn: existing pins live,
  new resolutions do not see it.
- **A publisher-supplied conformance suite has hard limits.** A block may ship its
  own suite to demonstrate that it works. Three limits are not negotiable: the
  suite is **supporting evidence and never sufficient** — the badge comes from a
  reviewer's Judgment; the suite runs inside the operator's test run scope with
  contracts fully forbidden, zero credential handles, and ceilings on time,
  resources and model cost; and for the `code` trust class the review path depends
  on a runtime sandbox existing. Without one there is a circle: to become verified
  you must run code, and running code requires being verified. The verified door
  is the only door for `code`, so it must not itself become a path for executing
  unreviewed code.
- **`code` artifacts** — drivers, custom rule fillers — are a distinct trust
  class: rejected by default unless the publisher is verified, and installable
  only on an explicit administrator opt-in, because code cannot be analysed
  statically as completely as a definition can.
- **Installing, on the tenant side**: verify the signature and the log, re-analyse,
  **disclose the scope** (does it touch irreversible effects? credentials? which
  domains? does it spawn?) before installing, materialise with provenance,
  quarantine through the trust tiers, and record in the lockfile.

## Litmus

1. Unplug Hub — does every installed tenant keep working, in full, forever?
2. Does the same block install identically from the public instance, a private
   mirror and an air-gapped copy — same digest, same verifiable signature?
3. Does a block whose manifest under-declares its capabilities get **rejected** at
   install, rather than warned about?
4. If a publisher disappears, does a buyer keep everything already installed?
5. Can two blocks carrying two different contract versions be installed side by
   side without conflict?
6. Is there any path by which a publisher approves their own block for the
   verified badge? Can the badge be withdrawn, and do that publisher's `code`
   artifacts lose default installability immediately afterwards?

## Non-goals

- **No touching runtime**; no licence key or phone-home in the engine.
- **No telemetry by default**, no cross-tenant learning, and the index's own
  ranking and search never touch tenant calibration.
- **Not a CI system and not a git host.** Development happens in git; Hub receives
  artifacts that are already packed.
- **No commercial policy in a mechanism specification** — refunds and similar are
  operations, and putting them here would make a mechanism document change on a
  business decision.

## Distribution

- The domain lives in its own area. Licensing follows the canonical classification
  rule in the [Platform North Star](platform.md) — the `resolve` / `pull` /
  `verify` protocol, the manifest schema and the client library are things a third
  party plugs into; the Hub service is a thing you run. This document does not
  restate the rule, so no second source for it exists.
- Hub carries the system's fourth revenue line: **marketplace revenue share.**
