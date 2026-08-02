---
title: "Quota & Scheduling Fairness"
status: design-end-state
---

# Quota & Scheduling Fairness

## 0. Position — two questions, one specification

This document answers two questions that read one projection and must never
collapse into one concept:

- **The ceiling** — how much one tenant may consume.
- **The order** — when several tenants have work waiting, whose runs next.

Merge them and "out of allowance" and "not your turn yet" become the same word,
which costs the system the one sentence the whole mechanism exists to say:
_tenant A is slow because of tenant A, not because of tenant B._

**No new store, no new configuration surface, no new unit of measure.**
Consumption is a projection of the Event Log (§2); a limit is a parameter of the
existing default cascade (Composition §3); the unit is the cost function each
Filler already declares (Role §3). This is "metering is a mechanism, pricing is
policy" (North Star §8) applied one layer up.

**No number lives in this document.** The engine forces the parameter to exist
and a template supplies its value (principle #3). A limit written into the
mechanism is a commercial decision frozen into the engine, while a plan changes
without an engine release — and every price change would become an engine
change.

Four mechanisms are routinely mistaken for quota. None of them is:

| Mechanism                              | What it bounds                                            | Why it cannot stand in for quota                                                                                                                               |
| -------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger `guard` (Trigger & Channel §2) | The traffic through **one door**                          | Ten triggers each inside their own guard still add up to one tenant flooding the installation                                                                  |
| Task `budget` (Task §2)                | The cost of **one unit of work**                          | A ceiling on one task says nothing about a tenant's total — and the ordinary cascade lets a lower level _widen_ a value, which is what a ceiling may not allow |
| Filler capacity / rate limit (Role §3) | The throughput of **one occupant**                        | A property of the _resource_, not of the _consumer_: two tenants sharing one filler still compete inside that capacity                                         |
| The `suspended` state (Tenant §2b)     | **Everything**, for a tenant that is not in good standing | A lifecycle state rather than a rate: it freezes writes outright, is entered by policy rather than by measurement, and says nothing about an active tenant     |

The first three bound by **source**; quota bounds by **consumer**. Admission
takes the **minimum of every ceiling in force** — none replaces another, and
none may relax another.

## 1. Four resources, two shapes of scarcity

| Resource                       | Measured as                                                          | Derived from entries of kind | Known when                          |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------- | ----------------------------------- |
| **Model tokens**               | Input and output tokens through the filler's cost function (Role §3) | attempt                      | **After they are spent**            |
| **Sandbox CPU / machine time** | Executor occupancy — an RPA sandbox, a code filler's runtime         | attempt · session effect     | **After it is spent**               |
| **Concurrent runs**            | The number of Leases the tenant holds (Working Data §3)              | lease acquire / release      | **Before anything is spent**        |
| **Storage**                    | Content-addressed bytes, inline log payloads, DataTable rows         | artifact · write · GC        | A standing total, readable any time |

The taxonomy is **open**, like every taxonomy here: a new resource is a new cost
function plus a new ceiling in the cascade, never an engine change.

**Two shapes, two enforcement points.** This distinction decides the rest of the
document:

| Shape                        | Example                   | Enforced where                                                                                                                                                                   |
| ---------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Countable in advance**     | concurrent runs, storage  | **Admission**: the next Lease is not granted, the write is not accepted. The ceiling is absolute — no overshoot exists                                                           |
| **Knowable only afterwards** | model tokens, sandbox CPU | **At the next boundary**: every admission re-reads what has been spent. The unit _already running_ is bounded by its own `budget` (Task §2) and by its lease TTL, never by quota |

Treating the two shapes alike produces one of two failures. Block in advance on
an estimate and the mechanism kills work that would have fitted. Promise never to
exceed by a single token and the mechanism has made a promise no after-the-fact
measurement can keep. The honest consequence belongs here rather than in a later
incident: **a token or CPU ceiling is a ceiling with overshoot, and that
overshoot has a declared ceiling of its own** (§7). A concurrency ceiling has
none.

## 2. Consumption is a projection — and it declares its position

- Quota reads a projection **rebuildable from the log** (Event Log §3), never a
  self-maintained counter table. Editing a consumed figure by hand is drift,
  detected and rebuilt with a record like any projection (Working Data §2). There
  is no second source of truth about what a tenant has consumed.
- It is **its own projection rather than a column of metering**, for two
  mechanical reasons rather than for convenience: its position on `run_kind`
  differs from metering's (§4); and its shape differs — metering is a cumulative
  total per billing period, while quota is a **total over a sliding window**, read
  hot at every admission.
- The `run_kind` label's canonical home is Event Log §1/§3. This document
  **declares a position**; it does not restate the label.
- **Subject to the mandatory negative test like every projection** (Event Log §3,
  in the ◆G0 suite): a fixture containing a `run_kind: test` entry leaves the plan
  counter **unchanged**. For this projection the negative test must also check
  **the opposite direction** — that the resource counter **did** change. Without
  that second assertion, an implementation that simply filters the label
  everywhere passes the suite while standing wide open in exactly the place §4
  exists to close.

## 3. Where a limit is declared — the existing cascade, plus exactly one law

- `quota` is a parameter the engine forces to exist, resolving along the same
  chain as every other: `tenant → template → process → role → task`
  (Composition §3). There is no second configuration surface. What a plan allows
  is **a value at the tenant level**, written by the control plane's provisioning
  workflow — the control plane _calls_ the engine, it does not _patch_ it
  (North Star §8, Tenant §2b).
- **The one added law, and it runs against the ordinary cascade: a lower level
  may only TIGHTEN, never widen.** The ordinary cascade answers _which value
  applies_, so a lower level overrides a higher one. A ceiling answers _what may
  not be exceeded_, and a ceiling a lower level can widen means any process grants
  itself an unlimited allowance in one line of declaration. Resolution is
  therefore **the minimum per resource**, not "the nearest level wins". The
  conservative reading is the simple one here: simpler must mean stricter, never
  looser.
- **Not snapshotted into the instance** — unlike `budget` and `sla`, which are
  snapshotted at launch (Composition §3). Snapshotting is right for a parameter
  governing _how an instance runs_. A ceiling governs _whether a new unit is
  admitted at all_, and every unit has exactly one admission; that moment **is**
  the resolution, so there is nothing to snapshot. The consequence has to be said
  plainly, because this is where the two mechanisms meet: **lowering a tenant's
  ceiling does not kill work already running** (§6), it blocks the next unit.
- **`∅` — no ceiling — is a value that must be declared, not a blank field.** A
  single-tenant self-host ships with `∅` at the tenant level: the operator _is_
  the tenant, and the only ceiling meaningful to them is their own hardware, so
  zero configuration still runs. But "nobody has declared one" and "unlimited on
  purpose" must be distinguishable by reading, which is why the engine forces the
  field to exist and the declaration is a `config-change` entry (Event Log §1). An
  escape hatch is permitted — labelled and traced, never silent.

## 4. `run_kind: test` — two axes, never merged

**This projection's position on the label is TWO positions, opposite in
direction, on two axes:**

| Axis                                                          | Position            | Why                                                                                                                                  |
| ------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Plan allowance** — what the subscribed plan permits         | **Excluded**        | Trying a process out is the work of designing it; charging a plan for it penalises the exact behaviour the system wants to encourage |
| **Real resource ceiling** — tokens, CPU, concurrency, storage | **Counted in full** | That cost _happened_: the tokens burned, the executor was occupied, the neighbours were slowed. A label refunds none of it           |

**The mechanical consequence**: the quota projection keeps **two counters over
the same entries** — a plan counter that reads the label and a resource counter
that does not — rather than one counter with a filter. A test run therefore
**requests admission exactly as a production run does**: the same concurrency
ceiling, the same token ceiling, the same fair queue (§6). The only thing it does
not touch is the plan counter.

**The argument — two sentences that sound alike, of which only one is true**:
_does not count against the plan_ is not _costs nothing_. Merge them and
`run_kind` becomes **a quota switch**: everyone runs everything under the test
label, the installation degrades exactly as it would with no quota at all, and
the books come out spotless. That is **worse** than having no mechanism, because
it ships with a number saying everything is fine.

**The condition that keeps the rule from being advice**: the label is applied by
the engine at **a launch point that requires a capability** (Test Harness §1 — the
test run scope), never as a payload field the caller sets. A self-declared label
reduces this whole section to an honour system.

**Inside one tenant, ordering is that tenant's own business**: a test run
competes with the same tenant's production runs on `priority` (Task §2), and no
second priority axis is needed. Fairness _between_ tenants (§6) never looks at
the label; it looks only at resources consumed.

## 5. At the boundary — three outcomes, none of them silent

| Outcome   | Meaning                                                           | Through which existing mechanism                                                                                                                                                                                                                      |
| --------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reject`  | The unit **does not start**                                       | At a door: rejected at the boundary exactly as invalid `auth` or a `payload_contract` breach is (Trigger & Channel §2). For a task already waiting: **a Violation, then `on_fail`** (Checkpoint §5) — retry, reroute or escalate along existing paths |
| `queue`   | Admitted but **deferred**; the unit waits in the fair queue of §6 | Waiting carries **a time ceiling the engine forces to exist**; past it the outcome becomes `reject` plus an escalation — invariant 5 forbids a silent stall                                                                                           |
| `degrade` | Admitted and run, **at a lower value**                            | Routing to a cheaper filler in the Role's pool (Role §3) · lowering the sampling rate · narrowing the breadth of `spawn_policy` (Task §5)                                                                                                             |

**`degrade` has a hard boundary: it narrows values and policy, and never touches
a mechanism.** No Gate skipped, no Judgment omitted, no classification lowered,
no reversibility class downgraded, nothing auto-passed for want of allowance. On
the storage axis specifically, `degrade` may never mean **collecting a tenant's
own artifacts early to make room**: retention is the Artifact Store's policy
(Artifact Store §3), and a ceiling that deletes data in order to stay under
itself has destroyed the thing it was protecting. The reasoning is the same one
§4 uses on the label side: if `degrade` can reach a mechanism, "out of quota"
becomes a way around Checkpoint — the same hole, entered through a different
door.

Which outcome applies to which resource is **a cascade parameter** the engine
forces to exist. The conservative default is `reject`: stop and say so, rather
than quietly continue at a quality nobody chose.

**The visibility law — a boundary decision is an entry, and that entry must be
enough to answer "why was I blocked".** It carries `(resource, the resolved
ceiling, which cascade level supplied that ceiling, the amount consumed at the
moment of decision, the outcome)`. Recording _which level won_ follows the shape
the semantic locator's resolution cascade already uses (Driver & Perception §4).
A ceiling that cannot explain itself is a ceiling the user can only guess at —
and they will guess that the system is broken and retry, at precisely the moment
the system needs them to stop.

**Storm control**: hitting a ceiling repeatedly does not produce one escalation
per attempt. Dedup and correlation apply unchanged (Escalation §5), so a
misfiring process produces **one** open escalation carrying a counter, rather
than a thousand rows in the attention queue (invariant 3). The trigger is a
member of Escalation §2's **open** taxonomy, which is why admitting it needs no
new mechanism.

## 6. Fairness between tenants — and Lease is the only path that touches running work

**The measurable promise**: no tenant is starved by another tenant's _behaviour_.
Being slow because the installation is small is the operator's own decision;
being slow because a neighbour loops is a design fault.

- **Order is not arrival order.** FIFO hands the queue to whoever knocks most
  often, which is exactly the misfiring-schedule scenario this mechanism exists
  for. The scheduler picks the next unit by **resource debt within the window**,
  read from the projection of §2: a tenant that has just consumed heavily goes
  behind, a tenant quiet all day goes ahead. Per-tenant weights are cascade
  parameters, because what a plan buys is policy rather than mechanism. The shape
  is proven outside this system — deficit-based fair queueing in network
  scheduling is the same problem in a different unit.
- **There is no cross-tenant priority column.** `priority` (Task §2) orders work
  _inside_ a tenant. A hand-set cross-tenant priority axis would be a second
  source of truth about order, and it would beat every mechanism precisely
  because it is the nearest thing to hand.
- **The scheduler acts at exactly two points, and both are "not yet started"**:
  admission (§5), and **granting a Lease** (Working Data §3). It **never** kills a
  running attempt. Interrupting a unit that has already written an effect is
  precisely the `orphaned` case the Lease refuses to regrant automatically; it
  does not produce fairness, it produces a half-finished effect or a doubled one
  (consistent with the dead-node rule, RPA North Star §4). Work already running
  has exactly two ceilings and both already exist: its own `budget` (Task §2) and
  **the lease's mandatory TTL**. Because that TTL is a structural constraint, no
  indefinitely running unit exists for a killer to be needed against.
- **The "concurrent runs" ceiling simply _is_ the number of Leases a tenant may
  hold at once** — no new counting mechanism. And because the TTL is mandatory,
  that counter dissolves by itself when the machine holding a lease dies, with
  nobody cleaning up by hand.
- **The scheduler is the ONLY component that reads across tenants, so its read
  scope is declared in public.** It reads **aggregate consumption figures**, and
  never knowledge, memory or calibration — invariant 4 binds the Cloud operator
  too (North Star §8, Tenant §2c). The opposite direction is a mechanism rather
  than an operational habit: **an entry in one tenant's log never carries another
  tenant's identity or figures.** Per-tenant logs (Event Log §1) give that almost
  for free; the rule stated here forbids the reverse — _"why am I waiting"_ is
  answered with the tenant's own numbers (my debt, my ceiling, my queue length),
  never through a window onto the neighbours. Without it, the very tool built to
  explain the wait becomes a countable side channel revealing who else shares the
  cluster — the same class of leak that cross-tenant deduplication is forbidden
  for (Artifact Store §4).

## 7. The economics of the mechanism, and what happens when the figures lag

- **No new write path.** The quota projection aggregates entries already written
  for other reasons; it emits no new event on the hot path. Only a **boundary
  decision** is a new entry, and their number is bounded by the very mechanism
  that produces them (§5, storm control).
- **The regulating valve**: the window and the counter's granularity are
  parameters — the engine forces them to exist, a template supplies values.
  Admission reads one hot total rather than scanning the log; history is rebuilt
  from the log when it is wanted.
- **Lagging figures are a normal state, not an incident** — a token is measurable
  only after it is spent (§1). So **the projection's lag carries a declared
  ceiling**: within it, admission accepts a **bounded overshoot**; beyond it, the
  engine switches behaviour to `reject` and raises an escalation for the operator.
  That ceiling protects the _neighbours_, not the _accuracy of the books_, so the
  right question is "how much overshoot is unacceptable" rather than "never
  exceed" — which no after-the-fact measurement can promise. And failing closed
  entirely whenever the projection lags turns one routine rebuild into an outage:
  it is the wrong place to be absolute.

## 8. Non-goals

- Not a price list, not a plan tier, and not any specific limit — quota is the
  mechanism, a limit is a value (North Star §8).
- Not a replacement for infrastructure-level limits (container CPU, connection
  caps). Those cannot see the tenant boundary, so they throttle the cause and its
  victims equally. Complementary, never a substitute.
- Not quality of service _inside_ one tenant — that is `priority` (Task §2) — and
  not load or performance testing (Test Harness §9).
- No entitlement check, no licence key, no runtime phone-home (North Star §7):
  quota reads the tenant's own cascade parameters and asks nobody outside.
- **No quota killer**: no path touches running work other than `budget` and the
  Lease's TTL.
- Not the tenant lifecycle. `suspended` is a state entered by policy
  (Tenant §2b), never an outcome quota reaches on its own.
- No second projection for tokens or storage, and no new unit of measure — the
  same entries, the same Filler cost function (Role §3), and two counters whose
  positions are declared (§4).

## 9. Decisions

| Question                       | Settled                                                                                                                                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where a limit is declared      | A parameter of the existing default cascade; the control plane supplies the value at tenant level — no second configuration surface                                                          |
| **Resolution direction**       | **A lower level may only tighten, never widen; resolution is the minimum per resource.** The ordinary cascade answers "which value", a ceiling answers "what may not be exceeded"            |
| Snapshotting                   | **No** snapshot into the instance: every unit has exactly one admission and that moment is the resolution — lowering a ceiling blocks the next unit and kills nothing already running        |
| A ceiling nobody declared      | `∅` is a value that must be declared, recorded as a `config-change` entry — never a blank field. Zero configuration still runs on a self-host, and the escape hatch stays labelled           |
| What is measured               | Four resources over an open taxonomy; **two shapes** — countable in advance against knowable only afterwards — with **two different enforcement points**                                     |
| **The `run_kind: test` label** | **Two opposite positions**: excluded from the plan counter, **counted in full** by the resource counter. The label's home is Event Log §1/§3; this document declares a position only         |
| Who applies the label          | The engine, at a launch point requiring a capability (Test Harness §1). A self-declared payload field would make every rule above advice                                                     |
| The boundary outcome           | `reject` / `queue` (with a waiting ceiling) / `degrade`; the default is `reject`. **`degrade` narrows values only and never reaches a mechanism**, storage included                          |
| Visibility                     | Every boundary decision is an entry carrying the ceiling, the amount consumed, the outcome **and the cascade level that supplied the ceiling** — an unexplainable ceiling is one to guess at |
| Order between tenants          | Resource debt within the window, not FIFO, and no cross-tenant priority column; weights are template values                                                                                  |
| Work already running           | Touched only through the Lease and `budget`; **never killed** — interrupting after a commit point is a doubled or half-finished effect                                                       |
| Reading across tenants         | The scheduler only, aggregate consumption figures only (invariant 4 binds the operator); one tenant's entries never carry another's numbers — the side-channel direction is closed too       |
| Figures that lag               | A bounded overshoot with a declared ceiling; past that ceiling, `reject` plus an escalation rather than a full fail-closed                                                                   |

## Litmus

1. A tenant loops a trigger every few seconds: does it hit **its own** ceiling,
   do the other two tenants measure no difference at all — and does their log
   contain not one line about the tenant that misfired?
2. Run that same volume under `run_kind: test`: does the plan counter stay still
   while the token, CPU and concurrency ceilings block exactly as they do in
   production — so that "run it as a test" buys not one extra token?
3. A process, a template or a task declares a `quota` wider than the tenant's:
   which value wins, and does any path exist by which the tenant's ceiling is
   widened?
4. Lower a tenant's ceiling while three instances are running: do all three
   continue to their own `budget` or TTL while the next unit is blocked — with no
   instance killed mid-flight and no effect left half-finished?
5. Point at any single blocked request: does its entry answer which resource,
   what ceiling, which cascade level supplied that ceiling and how much had been
   consumed — or can the user only guess?
6. Delete the whole quota projection and rebuild it from the log: is the result
   equivalent, and does no counter table survive outside the log?
7. Turn `degrade` up to its maximum on every resource: is any Gate skipped, any
   Judgment not produced, any classification or reversibility class lowered, or
   any artifact collected early to free space?

## Failure modes

| Failure                                                            | Detected by                                                                          | Recovery                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The quota projection lags or drifts                                | A checksum against log position (Working Data §2) plus the lag ceiling (§7)          | Within the ceiling, the declared overshoot is accepted. Beyond it, behaviour switches to `reject` plus an escalation; rebuild from the log  |
| The scheduler stops granting leases while work is queued           | The waiting time ceiling expires (§5)                                                | `queue` becomes `reject` plus a terminal escalation — never a silent stall (invariant 5)                                                    |
| A lease TTL expires while the tenant is at its concurrency ceiling | TTL and heartbeat (Working Data §3)                                                  | The concurrency counter dissolves with the TTL; if an effect was already written the lease is `orphaned` and is not regranted automatically |
| A new tenant's ceiling is declared wrongly, `∅` by mistake         | The ceiling is a readable `config-change` entry rather than a blank field            | The correction is another entry, with an actor and a time — there is no "nobody declared it" to blame                                       |
| Evading quota by self-applying the test label                      | The label is applied at a launch point requiring a capability (§4), not in a payload | A forged label does not exist structurally; and even where the capability is abused, the resource counter still blocks (§4)                 |
| Repeatedly hitting a ceiling raises an escalation storm            | Dedup and correlation (Escalation §5)                                                | One merged escalation carrying a counter, rather than one row per attempt in the attention queue                                            |
