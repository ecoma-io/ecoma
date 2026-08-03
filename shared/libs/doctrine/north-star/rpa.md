---
title: "Ecoma RPA — North Star"
status: design-end-state
---

# Ecoma RPA — North Star

## The end state

**Ecoma RPA is a computer-use generation automation engine for interacting with
environments: every action is an entity with an identity, a reversibility class,
and evidence; every session is durable, replayable, and interruptible by a person
mid-run; deterministic scripts and vision agents are two ends of one cost–
durability axis with two-way self-healing — usable on its own, or as a source of
labour for [Ecoma Platform](platform.md) through exactly two standard
interfaces.**

The mechanism principles and invariants it specialises are canonical in the
[Platform North Star](platform.md) and are not restated here.

## The problem, and the position

Selector-based automation is a maintenance sink: the interface changes and it
breaks. Computer-use agents survive interface changes far better, but nobody
dares let one run for real — there is no reversibility, no standard action log,
no distinction between looking and writing, and secrets end up inside the model's
context.

The gap between those two is the whole product: **an automation runtime in which
every action is accountable.** That is not a new idea in this system; it is the
rest of Ecoma's design pushed down to the execution layer.

## Five mechanism principles

These specialise the canonical four without replacing them:

1. **Absolute symmetry.** Human actions (takeover, demonstration) and machine
   actions (script, agent) enter **the same action log**, under the same schema,
   differing only in actor identity. Two logs would mean two truths, and the
   interesting question — what actually happened in this session — would have no
   single answer.
2. **Stable identity with lineage** for everything that accumulates: action
   definitions, scripts, drivers, application profiles. A script repaired by
   self-healing is a new version that inherits from its parent.
3. **The engine forces existence, the template forces value** — with one
   conservative rule specific to this domain: **reversibility not declared is
   treated as irreversible.** The safe reading of silence is the only one that
   fails safely.
4. **Complexity is the user's choice.** A bare script runs without declaring
   anything; guards, masking, scope and confirmation are opt-in through the
   cascade.
5. **Integration first.** RPA _always_ emits a Session effect and speaks the
   Filler interface, **including when it runs standalone** — where a minimal
   local consumer stands in for Platform. There is no second execution path, so
   the two modes cannot drift apart.

## The domain, and its specifications

| Layer                                                     | What it covers                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| [Action](../spec/rpa-action.md)                           | A standardised vocabulary, reversibility, evidence, the action log |
| [Session](../spec/rpa-session.md)                         | Durable lifecycle, takeover, record, replay, interruption          |
| [Driver & Perception](../spec/rpa-driver-perception.md)   | The driver contract, the unified scene, **semantic locators**      |
| [Self-healing](../spec/rpa-self-healing.md)               | Script ↔ agent in both directions, patch lineage, drift signals    |
| [Sandbox & Credential](../spec/rpa-sandbox-credential.md) | Session isolation, vault, masking, permission scope                |

## Deployment topology: the Node

A **Node** is the RPA application installed on a machine — a staff machine is
_attended_, a server is _unattended_, and both run the same binary. A node is a
**host, not a Filler**: fillers (a script version, an agent configuration)
register _through_ a node. One node hosts many fillers, and one filler can run on
many nodes.

**Placement.** A node declares what it has: installed applications, available
persistent profiles, network zone, capacity, whether a person is present, and its
engine and protocol versions. Assignment resolves as a chain — role, then filler
pool, then a node that qualifies, with version being one of the qualifying
conditions.

**Pull, outbound only.** A node claims tasks from the server. Platform never
pushes a remote-control command into a node. The session runs locally and the
Session effect streams back. The transport is a detail; the required mechanism is
outbound-only plus **a stream with a resumable cursor**. Lose the network and the
session stays durable locally, the log buffers, and reconnection resumes from the
offset — entries are content-addressed, so at-least-once delivery deduplicates
itself. If the node dies, the session ends as interrupted with a state that
evidence can substantiate.

**A claim is a lease with a heartbeat**, and its expiry is deliberately not a
re-run. Once the log shows actions already taken — especially past a commit point
— silently reassigning the work would repeat an effect on a real system. It
becomes an interruption plus the declared failure path instead. A session is
**pinned to its node** and does not migrate, because its state is local.

**Enrolment is mandatory.** A node has a cryptographic identity and an
administrator approves it explicitly. A task carrying a given credential scope
routes only to a node explicitly granted that scope, and the vault issues only
short-lived secrets, to an enrolled node identity, scoped per session, at the
driver layer. Planned removal is a **graceful drain**: the node stops claiming,
running sessions finish or are reassigned by lease, then keys are revoked — every
step an event. That is a different procedure from emergency revocation of a
compromised node, which cuts immediately.

**Takeover has a channel but never a standing privilege.** No ambient
remote-control capability exists. A view-or-control channel opens **per session,
initiated by the node, outbound**, once an assistance request is accepted and the
node's own policy permits it. Every human input passes through the driver and
becomes an Action with an actor, in the same log. On an attended node, takeover
routes to the person at that machine — who is also a Filler.

**Attended is consent-first** (run when idle, on user trigger, or in a separate
virtual desktop — a policy cascade). **Unattended is isolation-first** (a sandbox
or a virtual machine).

**The local attended UI is not a third interface.** The node runtime is a single
headless binary running both modes; an attended machine additionally installs a
local UI layer that talks to the runtime over an on-machine channel authenticated
by node identity. Three hard boundaries keep it from becoming an interface of the
system:

1. The on-machine channel carries **only local session control** — open, close,
   pause, take over. It carries no effect stream and no labour semantics.
2. **Every act of labour from the attended UI — approve, judge, claim, release —
   goes straight to the engine API**, like any other client. There is no private
   write path for the UI.
3. The attended UI **stores no frames**. What reaches the log is always a masked
   Scene.

The litmus is direct: switch the on-machine channel off, and the node runtime
still runs — it merely loses its UI — while no write path is lost, because none
of them went through that channel.

**Node updates have a way back.** Updating a node through Hub is an explicit
action, and **stepping back to the previous digest is equally explicit and equally
an event**, valid inside the declared skew window. Without a way back, "update"
would be a one-way operation on the most security-sensitive component in the
system.

**Evidence streams as hashes immediately and uploads blobs lazily**, so log
integrity is instant and bandwidth is not the bottleneck. Nodes update through
Hub itself, verifying signatures, and **never auto-update under any default
configuration**.

## What each RPA concept becomes when integrated

| In RPA                                                                              | When plugged into Platform                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session                                                                             | The Session effect of a Task                                                                                                                                                               |
| Human takeover                                                                      | An assistance request — an escalation whose handler is itself a Filler                                                                                                                     |
| A healed script version                                                             | A new Filler identity with lineage, passing through the trust tiers                                                                                                                        |
| A healing confirmation                                                              | A Gate, with criteria derived from reversibility                                                                                                                                           |
| The action log plus evidence                                                        | The provenance of an Artifact                                                                                                                                                              |
| An application profile                                                              | A block type on Hub; installed into a tenant it becomes a source of cascade defaults                                                                                                       |
| Interface drift signals                                                             | Escalation and intelligence input — a process smell at the execution layer                                                                                                                 |
| A read-only session scope                                                           | A rail on the spawn policy when an agent creates RPA tasks itself                                                                                                                          |
| **An automation** (a script version plus healing policy, or an agent configuration) | **The registered Filler itself.** Handing one action between script, agent and person is behaviour _inside_ the filler, recorded as a sub-actor; calibration follows the registered filler |
| Learning signals                                                                    | Derived from the Session effect plus `proposal` entries in the same stream — **not a third interface** — landing as Judgments, escalations, or per-tenant calibration                      |

## Deterministic and reasoning, on one axis

The same axis, dialled **per action** rather than per product:

| Aspect             | Deterministic             | Reasoning                    |
| ------------------ | ------------------------- | ---------------------------- |
| Executor           | Script, structural tiers  | Vision agent, semantic tiers |
| Where it starts    | Recording a demonstration | Distillation from an agent   |
| Resolving a target | Structural anchor         | Semantic intent              |
| Checking           | Precondition assertion    | Reconciliation and healing   |
| Handover           | Script → agent on failure | Agent → script once stable   |

## One learning core, and RPA produces signals for it

**RPA has no learning core of its own.** The only one is Platform's intelligence
layer. Learning signals are not a third channel: most derive from the action log,
which is the Session effect, and the _proposals_ — patch an application profile,
distil to a script, change model routing — are entries of a `proposal` kind in
that same stream, which Platform materialises into Tasks. Running standalone,
a minimal local consumer does deterministic statistics only: counting,
thresholds, and promoting an anchor **inside its own script** under the same
approval rules. There is deliberately no second brain that could drift from the
first.

Every proposal is applied **through a review**, never by editing the runtime.
Signals belong to the tenant; a community catalogue receives them only on opt-in,
through review.

## Litmus

1. Does the same automation run under a script **and** under a vision agent,
   without changing its definition?
2. When a script breaks because the interface changed, does the agent take over
   and produce a patched version with lineage, without a person editing it?
3. Can any session be replayed from log and evidence — who or what did what,
   when, and what the screen looked like?
4. When a person takes over mid-session, do their actions land in the same log as
   the machine's?
5. Do secrets ever appear in the log, in a screenshot handed to a model, or in an
   agent's context?
6. Are standalone and integrated the **same binary on the same effect path**?
7. If a node loses the network mid-session, does the session continue locally and
   resume from its cursor with no lost and no duplicated entries?
8. Can an unenrolled node claim a task or receive a secret — even with perfect
   placement attributes?
9. Is there any standing control channel into a node, or does takeover open per
   session, initiated by the node, with each input becoming an Action with an
   actor?
10. Switch off the attended UI's on-machine channel: does the runtime still run,
    and is any write path lost?

## Non-goals

- **No multi-step, multi-role, checkpoint orchestration.** That is Platform's
  work.
- **Not an integration platform.** Where an API exists, call the API — that is a
  rule filler on the Platform side. RPA is for where there **is no** API.
- **No vision model of our own.** Models arrive through an adapter, under an open
  taxonomy.
- **No secrets stored outside the vault, and no private integration path** with
  Platform despite sharing a repository.
- **No undetectability engineering.** Solving an access challenge presented to an
  authorised session — a CAPTCHA in front of a login the tenant holds a
  credential for — is an ordinary Action, logged with its actor like any other,
  and it is squarely what "for where there is no API" means. What the engine does
  **not** author is the opposite capability, whose only function is to make a
  destination misattribute a machine as a human: fingerprint spoofing, residential-proxy
  rotation, timing mimicry tuned to defeat a detector. The reason is the domain's
  own position — every action is accountable, and that accountability is
  **end-to-end**: driving an authorised human path leaves the destination's own
  log truthful, whereas evasion exists precisely to make that log lie. The two are
  different acts, and the line is drawn at the session's permission scope (Sandbox
  & Credential §4). A tenant that needs an undetectability capability installs it
  as an opt-in `code`-class driver and owns the terms-of-service and legal
  exposure; the engine neither ships nor markets it.

## Distribution

- The domain lives in its own area. Licensing follows the canonical
  classification rule in the [Platform North Star](platform.md) — the action
  vocabulary, the driver interface and the application profile schema are things
  a third party plugs into; the core and the node runtime are things you run.
  This document does not restate the rule, so there is no second source for it.
- Application profiles, macros, scripts and drivers are distributed as **blocks
  through [Hub](hub.md)** — RPA speaks to Hub directly through the client
  interface, including when standalone, rather than routing through Platform. A
  driver is a **code** artifact, which is a distinct trust class: it requires a
  verified publisher and an explicit administrator opt-in.
- Standalone means a command line, an SDK, and self-hosting. It is the adoption
  wedge: arrive for the automation, stay for the Platform.

## Failure modes

| Failure                            | Detected by                         | Recovery                                                                                                                               |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Node loses the network mid-session | Heartbeat and lease expiry          | The session stays durable locally and resumes from its cursor; if the node dies, it ends as interrupted with a state evidence supports |
| Node is compromised                | Enrolment identity, key revocation  | Every claim and every secret request is refused immediately                                                                            |
| Evidence buffer fills on a node    | Hashes already streamed, blobs lazy | A capacity warning; log integrity is unaffected because the hashes are already recorded                                                |
