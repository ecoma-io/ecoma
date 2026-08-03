---
title: "Runtime Sandbox"
status: design-end-state
---

# Runtime Sandbox

> **The sibling of RPA: Sandbox & Credential, not a copy of it.** The two share
> one isolation model and differ in what is enclosed: an interactive session
> against an environment there, a process running supplied code here. Every law
> they hold in common — a secret is a handle and never a value, egress by
> allowlist, a permission scope that is declared and blocked at the engine — has
> its canonical home in that document and in Vault & Key Lifecycle §5, and is not
> restated here. What this specification adds is three things: the boundary for
> code, the shape secret delivery takes when the consumer is a **process**, and
> the cut that breaks the verified-review circle.

## 1. Position — what is enclosed, and why the boundary sits outside the process

The Runtime Sandbox is **the execution boundary of a code filler**: the only
place code written by a tenant or distributed by a publisher — the `code` trust
class of Block §3 — runs. The language set is a settled input, not a question
reopened here: at minimum JS/TS, Python and Go, with **Python running as a native
interpreter and the WASM route forbidden** (ADR-0006). This document declares the
boundary a real interpreter has to sit inside.

**The boundary is an operating-system or virtual-machine boundary, never a
language-level one.** That sentence carries the weight of the whole document, and
it is a consequence rather than a preference:

| Kind of boundary                                                               | Safety is a function of         | Consequence                                                                                                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| In-process — a restricted interpreter, a module allowlist at the VM layer      | **the behaviour of the code**   | To run it safely you must already trust it, so the circle in §6 cannot be cut. Worse than nothing: it **looks** safe, so nobody builds the boundary that would have held |
| **OS / VM** — a separate process with its own namespaces, or a virtual machine | **the configuration of a host** | The safety level does not move when the code moves, so running code nobody has vouched for is an **ordinary operation** rather than a granted exception                  |

Choosing the lower row is not merely choosing the stronger of two options. It is
**the existence condition of §6**: a boundary whose strength depends on the code
inside it can never be used to _establish_ how far that code can be trusted.

**The floor rises with what it protects.** The concrete mechanism follows the
deployment shape, consistent with ADR-0002 and stated as a mechanism in ADR-0006:

| Installation                                                    | Floor                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Small stack, serving exactly one tenant (Tenant & Identity §2c) | A separate OS process with its own namespaces: no host network, no host filesystem, no inherited environment       |
| Any installation serving more than one tenant                   | **Kernel-level isolation** — a container runtime class or a microVM — because a process boundary is not sufficient |

The reason for the split is the blast radius, not fashion. On a single-tenant
installation an escape reaches the tenant's own data, which the code already
holds a declared grant over. Where two tenants share an installation the same
escape crosses **the system's only hard boundary** (Tenant & Identity §2), so the
floor rises with it. There is no configuration below either floor: as in RPA
Sandbox & Credential §5, the loosest setting is still an enclosure.

**Where the two sandboxes differ, and why:**

| Axis                | RPA Sandbox & Credential                                             | Runtime Sandbox                                                                     |
| ------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Unit of enclosure   | One **session** (RPA: Session §1)                                    | One **Attempt** (Task §4)                                                           |
| Durable state       | `persistent_profile` — a resource with an id, for a login that lasts | **Does not exist** — the enclosure dies with the Attempt, without exception         |
| Masking chokepoint  | The perception layer, before a Scene leaves it (§3)                  | The boundary, before output or trace leaves the enclosure (§3 below)                |
| Credential delivery | Injection at the driver layer — the runtime types the value in       | **Last-hop binding at a broker outside the enclosure** (§3 below)                   |
| Egress shape        | A domain allowlist enforced by the browser or desktop profile        | A domain allowlist enforced by **the only channel that exists** — there is no other |

The reasoning behind "no durable state" is worth stating, because the convenience
of a warm cache is real. A code filler's identity is `(code, version)` (Role §3),
and its calibration converges quickly **because it is binary** (Role §6). State
surviving between two Attempts is behaviour that identity does not name:
calibration would then measure something its own key cannot distinguish, and the
property that lets code reach `autonomous` fast is killed by the thing added for
speed.

**Pooling is permitted; a channel is not.** An implementation may keep warm
enclosures to avoid interpreter start-up. An enclosure is reusable only when it
has been reset to the image's state, which is observationally identical to a
fresh one. Pooling is an optimisation of the host, never a path from one Attempt
to the next.

**A code block is an ordinary filler.** It has identity, availability and cost
(Role §3), it carries trust tiers and graduation (Role §5), and it passes a Gate
like every other filler (Checkpoint). This specification creates **no** tier of
its own, **no** parallel moderation system, and **no** route around a Checkpoint.
That is principle 1 — the engine is symmetric — applied where it is easiest to
break, because code is the filler most tempting to treat as already trustworthy.

## 2. The boundary — what crosses, in which direction

| Direction | Crosses                                                                                                                                                                                                                                                         | Never crosses                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **In**    | The code artifact, pinned by digest · the runtime image, pinned by digest (§7) · input artifacts named by the Task's `inputs` · **credential handles**, never values · the resolved resource grant (§4) · the deadline · the `run_kind` label and `test_run_id` | Host environment variables · the host filesystem · ambient network · any engine API token · anything belonging to another tenant |
| **Out**   | Exactly one artifact against `output_contract` · **Effect requests** · measured consumption · log entries carrying the sub-actor · stdout, stderr and traces **after the masking chokepoint** (§3)                                                              | Any undeclared side effect · a secret value · a reference to a blob outside the grant                                            |

Four laws hold this shape:

1. **Deny-all in both directions; everything that crosses is a declared grant.**
   The loosest configuration is still an enclosure with no network and no host
   filesystem. Simpler always means more conservative here, never looser — the
   same rule Handoff §8 applies to an unclassified effect.
2. **Code holds no token that calls the engine.** An Effect is a **request**
   emitted on the boundary channel; the engine reconciles it against the Task's
   declared `effects` and **refuses what was not declared**. That is Task §5's
   first hard boundary, honoured rather than given a second door. An effect
   declared with no reversibility class is still `irreversible` (Handoff §8).
3. **Inside the enclosure is a sub-actor, not a Task.** The code's internal steps
   are recorded as sub-actors in the filler's provenance (Task §5). Labour that
   needs its own Role, Gate or calibration must be a Task; it may not be hidden
   inside code to dodge a Gate.
4. **The enclosure lives and dies with the Attempt** (§1). A retry is a new
   Attempt in a new enclosure, carrying the previous Attempt's structured
   feedback (Task §4).

**Statically checkable**, and therefore checked while the process is being drawn
rather than when it runs: a domain inside a code filler's egress grant that
**no declared Effect of the Task covers** is a design error, and it belongs in
Composition §4's table beside the other static checks. The opposite direction —
a manifest declaring less capability than analysis finds — is already Block §6's
install law and is not restated.

## 3. Secrets — bound at the last hop, outside the enclosure

The underlying law is not restated: a value lives only in the vault and a
consumer holds only a **handle** (canonical: Vault & Key Lifecycle §5; RPA
Sandbox & Credential §2). This specification answers exactly one question that
document never had to: **what is the equivalent of "injection at the driver
layer" when the consumer is a process?**

It is **not** "inject the value into a variable inside the enclosure". A variable
sits in an address space, and everything in an address space has an exit: a stack
trace, a core dump, an exception's `repr()`, the debug log of the HTTP library
the code happens to call. The structurally equivalent answer is that **the value
is bound at the last hop, outside the boundary.**

- **The egress broker.** Every outward call leaves the enclosure through a broker
  running on the host. The code sends a request carrying a **handle**; the broker
  checks the scope, resolves the handle, binds the value into the request **after
  the request has already left the enclosure**, and only then emits it. The
  enclosure receives the **result** and never the value.
- The consequence is a **property**, not a promise: _a stack trace cannot contain
  something that was never in the address space that produced it._ There is no
  "redact afterwards" step, because afterwards means it has already leaked
  (canonical: RPA Sandbox & Credential §3).
- **Code that must compute over a secret** — signing a payload, building a token
  — gets **the operation exported, never the key imported**: the broker offers a
  primitive ("sign this string with handle X"). Where the broker has no primitive
  for the operation, it **refuses**; it never returns the value. This is the exact
  place a "just this once" exception gets opened, and refusing to open it _is_ the
  mechanism.
- **stdout, stderr and traces are artifacts.** They pass **one** masking
  chokepoint at the boundary before becoming an entry or evidence, with a
  versioned detector whose misses are measured by sampled review — the same
  single-chokepoint design, and the same stated residual risk, as RPA Sandbox &
  Credential §3.
- Each use of a handle by the broker is a `secret_accessed` entry — handle,
  purpose, actor, never the value (Vault & Key Lifecycle §5).
- **The test boundary is unchanged**: a test run scope cannot resolve a
  production handle, and the engine refuses at the vault (Vault & Key Lifecycle
  §5). The sandbox is not a second door at which to ask.

## 4. Resource ceilings — the sandbox enforces a ceiling, it does not set one

- A resource grant — CPU time, wall clock, memory, process count, scratch disk,
  egress bytes, concurrent enclosures — resolves through **the cascade that
  already exists**, `tenant → template → process → role → task` (Composition §3),
  along the same path as a Task's `budget` and `sla` (Task §2). No second
  configuration surface is created; principle 4's cascade already covers every
  parameter the engine forces to exist.
- **Ceilings for a whole tenant, and the fairness rule when several tenants
  queue at once, are not this document's.** They belong to the **quota and
  scheduling fairness** specification (roadmap A.12). The boundary in one
  sentence: _that specification decides how much; this one enforces a grant
  already resolved and reports how much was consumed._ Code is the cheapest way
  for one tenant to burn an installation's capacity, which is exactly why the two
  meet here — and meeting is not merging.
- **The dependency is stated rather than assumed.** Until that mechanism exists,
  the only ceilings in the system are per-Attempt ones resolved through the
  cascade — **a ceiling per unit of work and none per tenant**. That is
  sufficient for the single-tenant self-host, which is the shape that exists
  first (Tenant & Identity §2c), and it is **not** sufficient for a shared
  installation. Saying so is the point: a ceiling that exists invites the reading
  that consumption is bounded, and per-Attempt ceilings bound no tenant at all.
  Which build order resolves it is the roadmap's question, not this document's.
- **Exceeding a ceiling terminates the Attempt and writes an entry naming which
  resource was exceeded**, after which it follows Checkpoint §5's `on_fail` like
  any failed Attempt. There is no silent truncation: **a partial output is never
  a valid artifact**, because a half-written result that passes a schema check is
  the one failure mode a Gate cannot catch.
- Measured consumption feeds the metering projection, and it is measured **even
  under `run_kind: test`**: the label decides whether something is _billable_,
  never whether it _cost_ anything — a test run's sandbox CPU was really spent
  (canonical: Event Log §3, which already states this).

## 5. `supports_dry_run` — a capability of the geometry, not a promise

The law lives elsewhere and is not restated: `dry_run` is a capability of the
**adapter**, and a contract declaring `dry_run` against an adapter that does not
support it resolves to `forbidden` (canonical: Handoff §3, Test Harness §5). This
document answers only how a sandbox executor **satisfies** that capability.

- Because the enclosure has no ambient network (§2), the broker is the **only**
  way out. One chokepoint is what makes `test_behavior` enforceable at a single
  place: `mock` returns a fixture, `dry_run` runs up to the broker and **stops
  before emitting**, `forbidden` blocks. The capability is therefore **a
  consequence of the geometry rather than a promise by the executor** — which is
  the whole difference between a declaration that can be checked and one that has
  to be believed.
- **The condition that makes it false is declared rather than hidden.** The grant
  taxonomy is open, and a grant the broker **cannot classify** — a raw socket, a
  binary channel an image defines for itself — destroys the single chokepoint.
  In that case the pair declares **`supports_dry_run: false`**, and every
  contract declaring `dry_run` against it resolves to `forbidden`.
- The declaration attaches to the **`(executor, image)` pair**, not to the system:
  one image opening a raw socket must not lower the capability of every other
  image. Static analysis checks the `contract × adapter` pair before anything runs,
  exactly as it does for every other adapter (Composition §4).

## 6. The verified-review run — the circle is cut by a mechanism

The circle, written in its own shape: **running code safely requires it to be
verified; verifying it requires running its suite, and for a `code` block that
suite _is_ unverified code.**

**The circle dissolves because its first premise is false** — it holds only for
an in-process boundary (§1). With an OS/VM boundary, safety is a function of the
host's configuration and not of the code, so "run code nobody has vouched for" is
an ordinary operation. No new mechanism is invented here; what §1 supplies is the
**reason** the existing one already suffices. This is also why the alternative of
having publishers run their own suites and submit the results is rejected: it does
not cut the circle, it moves the circle onto the publisher, and it turns the badge
into an attestation to a **claim** rather than to an **observation**.

A different question remains, and it is answerable: **the review run must be
isolated from the operator's own data**, because Hub North Star §7 runs it inside
the operator's test run scope — and the operator's tenant is a real tenant with
real data.

| Axis      | The review run's grant                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Label     | `run_kind: test` inside the operator's own tenant — **no separate tenant** (the reasoning is Test Harness §1's, and is not re-argued here)           |
| Input     | **The suite's fixtures only**; zero Knowledge, Memory or DataTable grant                                                                             |
| Secrets   | **Zero credential handles** — not "no production handle", but none at all, test handles included                                                     |
| Egress    | **Deny-all, with no allowlist.** A suite that needs the network is **not eligible as evidence**: the outcome is _"unverifiable"_, never _"verified"_ |
| Effects   | `test_behavior: forbidden` throughout (Hub North Star §7)                                                                                            |
| Resources | Hard ceilings; exceeding one yields _"unverifiable"_ and never converts itself into a pass                                                           |
| **Host**  | **Never the same sandbox host as any tenant's production work**                                                                                      |

The last line is the only thing this document **adds** to Hub North Star §7, and
it needs its reason attached. An OS/VM boundary is real but **finite**: the
residual risk is a kernel or hypervisor defect, and no mechanism in this system
repairs that class of defect. What remains designable is therefore not whether an
escape can happen but **what an escape would land in**. Separating the host turns
the residual risk into an empty blast radius, and it is a measurable
configuration rather than an act of care.

Two of Hub North Star §7's conditions stand unchanged and are not reopened: the
suite is **supporting evidence** and the badge comes from **a reviewer's
Judgment**; and the reviewer Role declares `distinct_filler_from` the publisher
and is filled by the operator.

**There is no "the publisher is verified, so it runs unsandboxed" path.** The
review door is the **only** door for a `code` artifact, and a fast path like that
would rebuild the exact circle at the very door built to cut it.

## 7. The runtime image — version, distribution, withdrawal

An image is **an artifact**, travelling the same distribution channel as
everything else — not inside the engine and not shipped with the installer.
`resolve` / `pull` / `verify` like any block (Hub North Star §5); once pulled it
is materialised into the tenant's Artifact Store, which is exactly the
"Hub distributes, Artifact Store runs" boundary (Artifact Store §7); air-gapped
mirroring uses the standard commands (Block §8).

**Two version axes, both of which already exist — a third is forbidden**
(Release & Compatibility §1):

| What is versioned                                             | Axis                                      | Mechanism                                                                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Image contents** — the interpreter, system libraries        | Digest for machines, semver for people    | The digest is pinned in the tenant's lockfile; an upgrade follows Block §4, §6 and §7's migration and way-back law                                                    |
| **The image ↔ engine interface** — the boundary channel of §2 | **Protocol version**, a monotonic integer | Negotiated at enclosure start-up; an empty intersection is a **refusal** plus a `protocol_incompatible` entry, with no "try anyway" mode (Release & Compatibility §2) |

The reasoning: image contents change for a publisher's reasons — patching a
library, moving an interpreter — and the boundary interface changes for the
engine's. Two different reasons must be counted separately, or a library patch
forces every engine to upgrade, or a wire-format change hides inside one.

**Withdrawal has three levels, and collapsing them is the error:**

| Act                                              | For an existing pin                                                                                   | For a new enclosure start                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **`yank` the image** (Block §8)                  | **Keeps running** — an existing pin lives forever; an image is not an exception to Hub's first litmus | `resolve` warns, and every start emits a `yanked_image_used` entry                                       |
| **`unverify` the publisher** (Hub North Star §7) | An Attempt **already running** runs on to its own deadline                                            | **Refused** — that publisher's `code` artifacts return to being rejected by default — with an escalation |
| **The bytes**                                    | **Never deleted**: a pin has to resolve, or "keeps running" is a sentence rather than a mechanism     | —                                                                                                        |

The `unverify` row needs its reasoning attached, because stopping immediately is
the intuitive choice. Killing an Attempt part-way **after an Effect has already
been emitted** leaves half an effect with no compensation path — strictly worse
than letting it finish under precisely the boundary that held it a second
earlier. Withdrawing a badge is a verdict about **trust in a publisher**; it does
not retroactively weaken a boundary. "Stop it right now" is a different
mechanism's job — revoking a grant, suspending a tenant — and merging the two
makes every badge withdrawal a generator of half-finished work.

**Daring to withdraw requires evidence**, which is the same law as
`deprecated_used` (Release & Compatibility §3). The entries above feed a
**runtime-image inventory** projection: which tenant or block pins which image,
which images are yanked, which publishers are unverified. Without it, every
withdrawal decision is a guess.

It is a projection of its own rather than a use of Release & Compatibility §3's
"who still uses what", and the boundary is that document's own: §10 excludes
block and template versioning from the train axis, because that is the digest and
lockfile system. An image is withdrawn on the digest axis, so folding it into the
deprecation projection would cross exactly the line Release & Compatibility
draws. Being a new projection, it **declares its position on the `run_kind` label
at the label's canonical home** (Event Log §3) — **included and labelled**, since
the question it answers is "who breaks if this image stops resolving", and a test
run pinning that image breaks too — and it carries the mandatory negative test in
the conformance suite that arbitrates it, like every other projection.

## 8. Non-goals

- **Not a general container platform or PaaS.** An enclosure runs one Attempt of
  one filler; it is not a service with a lifecycle of its own.
- **No "bare, no sandbox" mode** in any configuration — not for a verified
  publisher, not for code the tenant wrote itself (symmetric with RPA Sandbox &
  Credential §5).
- No ambient network, no host filesystem, no inherited environment variables.
- **The language set is not decided here** (ADR-0006), and **neither tenant-wide
  ceilings nor queue fairness are decided here** (the quota and scheduling
  fairness specification, roadmap A.12).
- No trust tier of its own, no moderation system of its own, no Task kind of its
  own: a code filler travels Role §5 and Checkpoint like every other filler.

## 9. Decisions

| Question                         | Settled                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind of boundary                 | **OS / VM, never a language-level sandbox.** Safety has to be a function of the host, or §6's circle cannot be cut                                                                                            |
| The floor                        | A namespaced process where one tenant is served; **kernel-level isolation wherever two tenants share an installation** — the floor rises with the boundary it protects                                        |
| Unit of enclosure                | One **Attempt**, dying with it; **no `persistent_profile` equivalent** — hidden state kills the very property that makes a code filler's calibration converge fast. Pooling is allowed, a channel is not      |
| The way out                      | Deny-all; **the broker is the only chokepoint**; an Effect is a request the engine reconciles against the Task's declaration, never a right the code holds                                                    |
| Secrets                          | Bound **at the last hop, outside the enclosure**; where computation is needed, **the operation is exported and the key never imported**; no primitive means refusal                                           |
| Resource ceilings                | The sandbox **enforces** a grant resolved through the existing cascade; **tenant-wide ceilings and queue fairness belong to the quota specification**, and the dependency on it is stated rather than assumed |
| `run_kind: test` and cost        | Not billable is not the same as free — a test run's sandbox CPU is still measured (Event Log §3)                                                                                                              |
| `supports_dry_run`               | Satisfied **by geometry**, thanks to the single chokepoint; a grant the broker cannot classify means declaring `false` **per `(executor, image)` pair**, never system-wide                                    |
| **The verified circle**          | It dissolves because "safe execution requires prior verification" is true only of an in-process boundary. What remains — isolation from the operator's data — is a grant plus **host separation**             |
| Host separation for a review run | An OS/VM boundary is real but finite; what stays designable is **where an escape lands**, not whether kernels have defects                                                                                    |
| Image versioning                 | The two existing axes: **digest and lockfile** for contents, **protocol version** for the boundary interface. A third axis is forbidden                                                                       |
| **`yank` versus `unverify`**     | `yank` never breaks an existing pin; `unverify` refuses **new starts** and lets a running Attempt finish. Killing part-way produces half an effect with no compensation path                                  |
| Evidence for withdrawal          | A **runtime-image inventory** projection plus an entry on every use of a withdrawn image — the same law as `deprecated_used`, and a separate projection because the digest axis is not the train axis         |

## Litmus

1. A code filler opens a connection to a domain outside its grant: is it blocked
   **at the broker** and turned into an entry — or does it merely happen to fail
   because the image ships no library for it?
2. Trace a credential from the vault to an external system: is there any point at
   which the value sits in the enclosure's address space, in stdout, in a trace,
   or in an entry?
3. An unverified `code` block's suite is running in the review loop: does it have
   any path to the operator tenant's real data, or to a host running any tenant's
   production work?
4. An image is yanked after a tenant pinned it: does that tenant keep running
   intact, **and** can the system answer _who is still pinning it_ from a
   projection rather than from memory?
5. A contract declaring `dry_run` against an image whose egress the broker cannot
   classify: does it resolve to `forbidden` — or does it really run?
6. A code filler exceeds its CPU ceiling part-way: is there any path by which the
   partial output becomes a valid artifact?
7. A verified publisher: is there any configuration in which their code runs
   outside an enclosure?

## Failure modes

| Failure                                                        | Detected by                                     | Recovery                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code overruns, or loops forever                                | The grant's wall clock or CPU-time ceiling      | Terminate the Attempt with an entry naming the resource; follow `on_fail` or escalate (Checkpoint §5). The partial output is discarded and never becomes an artifact                                                                        |
| **Escape from the enclosure** (a kernel or hypervisor defect)  | Host anomaly reconciled against the grant       | Review run: the host holds no data (§6), so the blast radius is empty. Production host: treat **every grant on that host as exposed** — rotate every handle within reach (Vault & Key Lifecycle §4) and rebuild the host from a clean image |
| A pulled image fails signature verification                    | `verify` at pull time (Hub North Star §5)       | Refuse to start; there is no "run it for now" mode                                                                                                                                                                                          |
| Image and engine disagree on the protocol                      | Negotiation at enclosure start-up               | `protocol_incompatible`; a person decides to upgrade — the engine **never downgrades** to a protocol it has dropped (Release & Compatibility §2)                                                                                            |
| The broker is down                                             | Every outward call fails                        | The Attempt takes `on_fail`; **there is no direct path that bypasses the broker** — stopping is safer than running open                                                                                                                     |
| A publisher is unverified while an Attempt is running          | The `unverify` entry from Hub                   | The running Attempt finishes; new starts are refused, with an escalation so a person can change the pin (§7)                                                                                                                                |
| A review suite hangs or eats resources                         | The review run's hard ceilings                  | The outcome is **"unverifiable"**; it never converts itself into a pass                                                                                                                                                                     |
| The masking detector misses a secret in a trace                | Sampled review (RPA Sandbox & Credential §3)    | Raise the detector version and **rotate the exposed handle** (Vault & Key Lifecycle §4). A value that left is exposed; there is no recall                                                                                                   |
| An image is yanked for a vulnerability, a tenant still pins it | The **runtime-image inventory** projection (§7) | A warning through `resolve` plus an entry on every use; changing the pin is an ordinary block upgrade and is **never** automatic (Block §7)                                                                                                 |
