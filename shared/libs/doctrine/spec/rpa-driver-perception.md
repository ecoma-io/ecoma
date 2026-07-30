---
title: "RPA: Driver & Perception"
status: design-end-state
---

# RPA: Driver & Perception

## 1. The driver contract

A driver is an adapter to one kind of environment. The interface is Apache 2.0,
so a third party can write a driver without asking for permission — the licence
is the mechanism, not a stated intention to be open.

| Declares           | Content                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`         | (type, id, version) plus **lineage**, like every identity here — a driver carries calibration too: resolution confidence, action failure rate |
| `environment`      | browser / desktop / an open taxonomy (mobile, terminal, VM, …)                                                                                |
| `actions`          | The Action Definitions it supports; it may register new ones into the vocabulary                                                              |
| `perception_modes` | structural / visual / both                                                                                                                    |
| `capture`          | Whether it can capture human actions — the precondition for takeover and record                                                               |

A driver knows **nothing** about scripts, agents or session policy. It receives
an action and returns a result plus perception. That narrowness is what lets a
third-party driver be trusted with an interface rather than with the system.

## 2. Scene — one representation of the environment

Perception returns a **Scene**: a structured, content-addressed snapshot whose
hash is the evidence recorded in the action log.

| Layer      | Source                                                                                      | Used for                                             |
| ---------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Structural | DOM / accessibility tree / UI automation tree                                               | Fast, cheap script resolution; masking by field type |
| Visual     | Screenshot, with sensitive regions masked **before** it leaves perception                   | Agent vision; evidence for whoever reads the audit   |
| Semantic   | A vision model's annotations over the two layers above — element labels, functional regions | Last-tier resolution; generating intent              |

Masking happens **at the perception layer** (Sandbox & Credential §3), so every
consumer behind it — agent, log, evidence, a person watching a replay — sees
only a clean scene. One chokepoint, because a secret that reaches two consumers
has to be caught twice.

A scene diff, before against after an action, is both the unit of evidence and
the drift signal.

## 3. Environment fingerprint

A structural hash of the scene — layout, and the application version where it
can be identified. It serves resume and reconcile (Session §2), detection that
an application changed version (the UI drift smell, Self-healing §5), and
pinning an App Profile to a compatible version.

## 4. The semantic locator — the central mechanism

An action's target is not a selector. It is **a four-tier block that walks itself
down**:

| Tier                 | Content                                                                                       | Cost   | Survives a UI change |
| -------------------- | --------------------------------------------------------------------------------------------- | ------ | -------------------- |
| 1. Structural anchor | Selector or a11y path, with fallback anchors                                                  | ~0     | Poorly               |
| 2. Relational        | Position relative to an anchoring element ("the button right of Email")                       | Low    | Moderately           |
| 3. Visual anchor     | An image pattern or region                                                                    | Medium | Moderately to well   |
| 4. Semantic intent   | Natural language: "the contact form's send button", resolved by a vision model over the scene | High   | **Best**             |

**The resolution cascade** tries 1 → 2 → 3 → 4, and every resolution records
**which tier won**:

- Tier 1 winning consistently means a healthy script.
- Falling to tier 3 or 4 is a **drift signal**, and triggers self-healing to
  propose a new anchor — patching tier 1 from what tier 4 found. The script
  rejuvenates itself.
- Tier 4 failing too means the target cannot be found, and the session
  escalates.

This is why a script and an agent are **two ends of one axis rather than two
systems**: a script is a locator leaning on tier 1, an agent is a locator
leaning on tier 4, and self-healing is nothing more than knowledge flowing from
tier 4 down to tier 1. Build them as two systems and that flow has nowhere to
happen.

## 5. Non-goals

- No vision model is built here. This is an adapter over an open taxonomy, with
  a versioned model identity carrying calibration, exactly as a verifier does on
  the platform side.
- Perception never decides an action. It describes; the executor decides.
- A driver holds no session state. State belongs to the Session.

## 6. Decisions

| Question                     | Settled                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Representing the environment | One unified three-layer Scene, content-addressed, masked at the source         |
| Target                       | A four-tier semantic locator, cascading down, recording the winning tier       |
| Script vs agent              | One axis over the same locator — not two systems                               |
| Drift                        | Measured by the distribution of winning tiers plus the environment fingerprint |
| Third-party drivers          | Apache 2.0 interface; a driver has an identity and calibration                 |

## Litmus

1. Is there any consumer — agent, log, evidence, replay viewer, live view — that
   receives a Scene **before** the masking step?
2. When a locator falls repeatedly to tier 3 or 4, does the system raise a drift
   signal, or does it merely run slower in silence?
3. When tier 4 cannot resolve either, is the outcome an escalation — never a
   guess at some element?
