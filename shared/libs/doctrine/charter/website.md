---
title: "Website Charter"
status: design-end-state
---

# Website Charter

> **Document class: System Charter** — for a system the operator runs, not a
> product domain. The classifying litmus: _does this system define a mechanism
> the product commits to a tenant?_ No — so it gets a charter here, not a
> North Star. Monorepo position: root area `website/` (area-first convention:
> `apps/ libs/ packages/`), deployed independently through `deploy/`.
>
> This is the architectural half of the charter. The other half — the funnel
> playbook: campaign strategy, survey wiring, tone decisions against
> competitors — is operator doctrine and stays withheld, marked as such in the
> corpus map's inventory. Nothing below depends on it.

## 1. Position

The commercial storefront of ecoma.io: it turns a stranger into a signed-up
tenant and hands them to the product. It holds no working session and no
tenant data; it is a door, not a room.

## 2. Strong classification — Website vs Hub vs Platform

**The one-sentence law**: _Website is everything **before identity**
(persuading a stranger); Hub is everything **about blocks and publishers**
(content with a digest); Platform tier 3 is everything **after signing in to
work**._ URL boundary: **one domain `ecoma.io`, partitioned by path** — `/`
(website) · `/blogs` (content) · `/hub` (Hub index) · `/app` (product
console). **A URL does not decide where code lives** — §3.

| Easily-confused item                                                       | Belongs to                                           | Why                                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| "Templates" showcase pages, SEO landing pages                              | Website                                              | Persuasion; no digest                                                                                       |
| Block catalog browse/search, block detail, version history, verified badge | **Hub**                                              | Digest-addressed content — the registry/index is the source of truth                                        |
| Website showing trending blocks                                            | Website **embedding/querying the Hub index**         | **No copies**: a block edits its description on Hub → nothing on the website needs a manual fix (litmus #6) |
| Publish flow, publisher dashboard, payout                                  | **Hub**                                              | Publisher business                                                                                          |
| Buying a block / entitlement / block subscription                          | **Hub**                                              | Entitlement is checked at distribution                                                                      |
| Buying an ecoma SaaS plan (pricing → checkout)                             | Website → control plane                              | Commerce of the _product_, not of a _block_                                                                 |
| Product docs                                                               | Website                                              | General documentation                                                                                       |
| A block's docs/README                                                      | **Hub**                                              | Travels with the artifact, per block version                                                                |
| Product changelog                                                          | Website                                              | The operator releases it                                                                                    |
| A block's changelog                                                        | **Hub**                                              | Follows the block's semver                                                                                  |
| Blog, case studies                                                         | Website                                              | Persuasive content                                                                                          |
| Inbox, canvas, dashboards                                                  | **Platform tier 3**                                  | After sign-in; it is the product                                                                            |
| Signup and enterprise surveys                                              | Website (surface) running on an **ecoma process**    | Dogfooding, principle #1                                                                                    |
| Status page                                                                | Website / Trust                                      | Operator-run                                                                                                |
| Storybook, UI/UX/motion philosophy, brand guideline, press kit             | **`shared/apps/design-system`** mounted at `/design` | The design system is an asset shared by every area — the website only links to it                           |

## 3. One domain, many independent apps — a URL is not an address for code

- An **edge router** (its config lives in `deploy/`) mounts independent apps
  onto paths: `/` → `website/apps/site` · `/hub` → the Hub index frontend ·
  `/app` → the Platform console · `/design` → the shared design system (SSG
  per release — unlike `/hub`'s event-driven revalidation, because a render
  model follows its system's _data source_). The website is the domain's
  _host_; the other apps are _mounted guests_ — each stays in the area of the
  domain that owns it, each deploys independently.
- **The Hub frontend lives under `hub/`, never under `website/`**: it renders
  Hub's source of truth (blocks, digests, publishers, entitlements) and
  releases on Hub's cadence; this charter forbids the website to hold copies
  of block content (§5); SEO is achieved by the mount, not by moving code.
- `/hub` renders **static-first: SSG plus revalidate-on-event** — a
  consequence of the mechanism, not a framework preference. Hub content is
  content-addressed and **immutable**, so the page of one block-version never
  changes (cache it forever); only _pointers_ (latest, badges, listings) are
  live, and a registry event (publish, yank, attestation) revalidates exactly
  the affected pages, on demand — no full-site rebuild, no per-request render
  of content that cannot change. Search and other live fragments are
  client/edge concerns.
- **Security conditions for sharing the domain** (mandatory; failing any one
  forces `/app` onto its own subdomain): cookies scoped by path · CSP split
  per route · **third-party scripts (ads, analytics) load only on marketing
  routes, never on `/app`**.

## 4. Principles

1. **Absolute dogfooding**: the website runs on ecoma itself, under an
   operator-owned growth tenant — a landing page is a Channel, signup is a
   form Trigger, a survey is a process with an external filler, provisioning
   calls the control plane. The funnel is a living demo of the product and its
   own first case study.
2. **Zero tenant data**: it never reads any tenant's data beyond its own
   growth tenant, and it talks to the product **only through public APIs** —
   call, never patch.
3. **Independent deployment**: static/edge plus a thin BFF, its own release
   cadence through `deploy/`; the website going down leaves every tenant's
   product untouched.
4. **Consent-first**: a visitor is an **anonymous party** (cookie/device),
   classified `confidential` by default; signup is a **self-assertion** that
   unifies the identity (claiming to be oneself needs no approval gate,
   unlike merging two strangers); the right to be forgotten is
   crypto-shredding, as for every party.
5. **Clickstream goes through the ingest tier**: high-volume low-value events
   take the sampling/batch path and never bloat the labour Event Log. **The
   right to be forgotten covers this tier too**: its data is keyed to a
   shreddable party key, or irreversibly anonymised with a short default TTL.

## 5. Non-goals

- Not an analytics platform sold to tenants (that is a Hub block; the website
  is merely its first user).
- No auth system of its own — it uses the product's Principal/Party.
- **No stored copies of block content** — embed or link from the Hub index.
- Never touches a tenant runtime; no A/B testing by patching the product.
- No hosting of per-block docs.

## 6. Litmus

1. Remove `website/` — every tenant's product runs untouched, only the
   storefront is gone?
2. Every survey response has task-output provenance (which contract, when)?
3. An anonymous visitor asks to be forgotten — one key destruction and the
   data is unreadable?
4. Can the website read any tenant's data beyond its own growth tenant?
   (Required answer: no.)
5. Ads multiply traffic a hundredfold — the labour Event Log does not grow
   with it?
6. A block changes its description or version on Hub — no copy on the website
   needs a manual edit?
7. The page of a published block-version **never needs re-rendering**
   (immutable); moving "latest" revalidates exactly the affected pages?

## 7. Decision log

| Question                     | Settled as                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Architectural position       | Root area `website/` (`apps/ libs/ packages/`), independent deploy — a System Charter, not a vertical domain                                                                                                                                                                                   |
| Boundary with Hub            | The one-sentence law of §2, plus the ban on copied block content                                                                                                                                                                                                                               |
| What it runs on              | Ecoma itself, under a growth tenant — dogfooding is principle #1                                                                                                                                                                                                                               |
| Visitor identity             | Anonymous party, self-assertion at signup                                                                                                                                                                                                                                                      |
| Clickstream                  | Ingest tier (sampling/batch) in front of the Event Log, forget-coverage included                                                                                                                                                                                                               |
| URL topology                 | One domain `ecoma.io`, path-based (`/blogs`, `/hub`, `/app`) — subfolders pool SEO authority; `/app` is noindex; the shared domain stands only on the three security conditions of §3, else `/app` falls back to a subdomain                                                                   |
| Where the Hub frontend lives | Under `hub/` — code follows the domain that owns it, not the URL; mounted at the edge (config in `deploy/`)                                                                                                                                                                                    |
| `/hub` rendering             | SSG plus revalidate-on-registry-event — a consequence of Hub content being immutable                                                                                                                                                                                                           |
| `/design`                    | The shared design system mounted at the edge; SSG per release; carries the design philosophy, brand guideline and press kit                                                                                                                                                                    |
| Brand voice & tone           | Canonical at `/design` (brand guideline); blog and website follow it — one source for the voice                                                                                                                                                                                                |
| Support chatbot              | A chat-widget Channel of the growth tenant; its knowledge base ingests from the product's own git and website with source binding, classified `public`; every answer cites its chunk at a commit hash — a living demo of the RAG scenario and the first customer of a knowledge-from-git block |
