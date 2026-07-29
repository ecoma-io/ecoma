---
title: "RPA: Self-healing"
status: design-end-state
---

# RPA: Self-healing

Automation breaks when the interface it drives changes. The question that
decides whether robotic automation is worth owning is not whether it breaks but
**who repairs it** — and the answer here is that the automation repairs itself,
under lineage and behind approval gates sized to the risk of what it touches.

## Executor: two ends of one axis

|                              | Script                                                                          | Agent                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| What it is                   | A sequence of actions generalised from the action log; locators lean structural | A vision model plus intent; locators lean semantic                                                  |
| Cost and speed               | Near zero, fast                                                                 | High, slow                                                                                          |
| Survives an interface change | Poorly                                                                          | Well                                                                                                |
| Identity                     | Id, version and **lineage**                                                     | `(model, version, config_hash)` plus lineage — the same shape a Filler carries on the platform side |

An automation's executor is a **dial, not a binary choice**: each individual
action may resolve through a different locator tier. Treating it as a choice
between two products forces the whole automation to pay the agent's cost for
the few steps that need it.

## The healing loop: script → agent → script

```
script fails (locators exhausted at the structural tiers, or a precondition drifted)
  → the agent takes over that one action: resolves semantically, executes the intent
  → on success it emits a patch: a new structural anchor, learned from what worked
  → new script version, parent = the old one — lineage, with inherited trust that decays
```

**Approval scales with reversibility.** Complexity is a choice the operator
makes; the default is the safe one.

| Class of the patched action | Default                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Read-only, or reversible    | Applied automatically, logged                                                                                    |
| Compensable                 | Applied automatically, flagged for review after the fact                                                         |
| Irreversible                | **Held for approval** — a proper gate when integrated; a confirmation through the local consumer when standalone |

When healing itself fails — the semantic tier cannot resolve it either — the
automation escalates rather than guessing.

## The other direction: distillation

An automation that runs purely on an agent but proves **repeatable** — the same
action sequence, the same distribution of winning locator tiers across many
sessions — earns a proposal to compile it into a script. That trades orders of
magnitude of cost for a locator set that keeps the semantic intent as a safety
net. Accepting the proposal produces a script whose lineage starts at the
agent's identity.

The two directions close a loop: an automation **matures toward cheap** on its
own, and **falls back toward durable** when its environment turns volatile.
Neither direction is a migration anyone schedules.

## A patched version earns trust; it is not granted it

- A new script version is a new identity with lineage, so when integrated it
  passes through the platform's trust tiers **like any other filler** —
  inheriting the parent's calibration with decay, and running in shadow against
  the parent first where policy asks for it. There is no "it was only a patch"
  exemption, because that exemption is exactly how an unreviewed behaviour
  change reaches production.
- **Decay is proportional to what the patch changed**, a value the template
  sets: a locator-only patch that leaves behaviour identical decays by nearly
  nothing; a patch that alters the action sequence decays a great deal. Shadow
  comparison is an **action-log diff**, because the artefact this system
  produces is the log and the effects, not a return value.
- **What registers as a filler is the automation**, not the executor of the
  moment. Handing one action from script to agent is behaviour _inside_ the
  filler and is recorded as a sub-actor. Calibration follows the registered
  filler; anything finer reads the sub-actor.
- Standalone deployments keep the same principle with fewer rungs: the approval
  table above is the whole of local trust.

## Interface drift is data, not just damage

Every healing event records the locator, the tier that failed, the tier that
won, the patch, and a fingerprint of the application. That record is worth more
than the repair:

- **The same locator healing repeatedly** marks an unstable element, and earns a
  proposal to strengthen that locator in the application profile — repairing the
  cause rather than each symptom.
- **Many locators in one application healing at once, with a changed
  fingerprint**, marks a version change in the application itself, and earns a
  proposal for a new profile version. One fix, every automation that drives that
  application.
- When integrated, those proposals enter as proposals: through the paired design
  loop, with a gate and a judgment. **Shared knowledge is never rewritten at
  runtime**, because knowledge that changes without review is knowledge nobody
  can be accountable for.

## Non-goals

- **No healing of business meaning.** A form that gained a required field is a
  process change, and it escalates into design rather than being patched at the
  locator layer. The distinction is not fussiness: a locator patch that quietly
  satisfies a new required field is an automation inventing data.
- **No automatic application of a patch to an irreversible action**, under any
  default configuration.

## What was decided, and why

| Question                   | Settled as                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------- |
| Script or agent            | Two ends of one axis over semantic locators; handover is per action, not per automation |
| What a patch produces      | A new version with lineage; approval scaled to reversibility; irreversible always held  |
| The reverse direction      | Distillation from agent to script once behaviour is stable — the axis runs both ways    |
| Trust in a patched version | Through the platform's trust tiers, with no exemption                                   |
| What healing teaches       | Drift signals become profile proposals through review, never a runtime self-edit        |

## Litmus

1. Is there any default configuration in which a patch to an irreversible action
   is applied without approval?
2. Is a freshly patched script trusted immediately, or does it pass the trust
   tiers with decay proportional to what the patch changed?
3. Can one tenant's healing reach shared knowledge — the application profile
   catalogue — without an explicit opt-in and a review?
