---
title: "RPA: Session"
status: design-end-state
---

# RPA: Session

A Session is **one continuous interaction with an environment**: a driver
attached to it, an action log of its own, a sandbox of its own, and state that
survives interruption. Every action belongs to exactly one session.

## 1. Lifecycle

```
created → attached(driver, sandbox) → running ⇄ paused
                                            ⇄ human_control
                                    → completed | failed | interrupted
```

| State           | Notes                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`       | An executor — script or agent (Self-healing) — is emitting actions                                                                                                |
| `paused`        | Durable: the state is (log position, last evidence, environment fingerprint). It survives a restart                                                               |
| `human_control` | **Takeover is a first-class state** (§3)                                                                                                                          |
| `interrupted`   | Broken off unintentionally. The engine knows exactly which action ran and whether the commit point was passed, from the evidence, and emits `session_interrupted` |

A session lives on a **Node** (RPA North Star §4). A node losing its connection
to the server is **not** an interrupted session: the session continues durably
on the node, the Session effect stream buffers, and resumes by cursor when the
link returns — at-least-once, with content-addressed entries that deduplicate
themselves. `interrupted` means the session or the node itself died.

## 2. Resume and reconcile — the guard against a drifted environment

The environment can change while a session is paused: a page times out, someone
else edits the data. Resume therefore never runs blind:

1. Re-perceive the current scene.
2. Run the next action's `preconditions` (Action §3).
3. Matching → continue. Diverged → the **healing loop** (Self-healing) or
   escalate, by the policy cascade. The default is conservative: a divergence
   before the commit point may heal, a divergence after it escalates.

The asymmetry is the point. Before the commit point, being wrong costs a retry;
after it, being wrong costs an action the world has already seen.

## 3. Human takeover — symmetry down to the individual click

A person can take manual control mid-session. Every action they take is captured
by the driver as an **Action instance in the same log**, with `actor` set to
their identity (RPA principle #1). Input into a sensitive field is redacted at
the capture layer (Sandbox & Credential §3), which applies to record mode too —
capture is the only place where redaction can be complete, because it is the
only place before the value exists anywhere else.

On handback the engine re-perceives and the executor continues.

Under integration, entries made during `human_control` carry the person as actor
and are attributed to an **escalation task** (`assistance_request`). One session
can serve several platform Tasks, so attribution rides the actor-to-task entry
in the Session effect stream (Handoff §8) rather than being inferred from
timing.

**A takeover diff is a training label.** The sequence a person performed by hand,
against what the executor intended or failed to do, is a Judgment of the
approve-with-edit kind with the person as actor, emitted to the core as a
learning signal. It is the most valuable label available for tuning an agent's
configuration (RPA North Star §7), because it is a correction rather than a
score.

A request for takeover projects into an `assistance_request` (Escalation) under
integration — the person handling it is a Filler, with calibration. Standalone,
it is a notification through the minimal internal consumer. **One mechanism, two
surfaces**; a second mechanism for the standalone case would be the second code
path RPA principle #5 exists to forbid.

## 4. Record mode — a script grown from a demonstration

A session running in `record` mode captures what a person does into an action
log, with the intent either annotated by them or proposed by AI for them to
confirm.

**A script is the generalisation of an action log** (Self-healing §2). That one
sentence is what makes a script grown from a human demonstration and a script
grown from an agent's successful run **the same entity on the same path**.
Record-and-replay is therefore not a separate feature with its own machinery; it
is one more source of action log.

## 5. Replay and dry-run

**Replay-as-audit** reconstructs a session from log plus evidence — every step
with its before and after scene image, already masked. It answers "who or what
did what, when, and what the screen looked like" completely.

**Dry-run** replays a session but executes only `read` actions; writing actions
are simulated and marked as such. It is the standard way to test a new script or
App Profile safely, and it is the mode a **shadow filler** runs in under
integration (Role §4: shadow may never touch production).

## 6. Session scope

Each session declares its scope: which domains and applications are permitted,
the maximum action class permitted — a session may be **read-only**, which is
the standard rail for an agent spawning RPA tasks under a `spawn_policy` — and
which credential handles are issued. The engine forces the scope to exist; a
template supplies the values. Mechanism and policy, kept apart.

## 7. Non-goals

- A session does not know about any process larger than itself. No role, no
  gate — those belong to the platform.
- There are never two executors at once in one session. Handover between script,
  agent and person is sequential and leaves a trace in the log.

## 8. Decisions

| Question                 | Settled                                                                                   |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Resume                   | Never blind: re-perceive plus preconditions; divergence policy hinges on the commit point |
| Takeover                 | A first-class state; human actions land in the same log; projects to `assistance_request` |
| Record                   | Not a separate feature — one more source of action log; a script is a generalised log     |
| Shadow under integration | Runs as dry-run mode                                                                      |
| Read-only session        | A scope mechanism, used as the rail for dynamic spawning                                  |

## Litmus

1. Resuming after a long pause: is there any path that continues **without**
   re-perceiving and checking preconditions?
2. A session breaks after passing its commit point — can the system say exactly
   which action ran, and does it refrain from re-running it?
3. Are a person's actions during `human_control` and an executor's actions in
   the same log, distinguished **only** by actor?
