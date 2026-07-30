---
title: "Release & Compatibility"
status: design-end-state
---

# Release & Compatibility

## 0. Position — the sole home of four things

This document is the canonical home of **(1)** the version identity of every
artifact, **(2)** compatibility negotiation between two separated components,
**(3)** the upgrade and rollback law, and **(4)** deprecation and EOL. Everywhere
else may **point** here and may not restate.

It does **not** describe the procedure for doing any of it — that is the `deploy`
charter. The boundary in one sentence: **a specification declares the conditions
under which a path exists; a charter declares how to walk it.**

## 1. Three version axes, never mixed

| Axis                                                 | Read by                                                         | Shape                                     | Changes when                      |
| ---------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- | --------------------------------- |
| **Release train `X.Y.Z`**                            | People, operations, support                                     | Semver, belonging to the **WORKSPACE**    | Every time a tag is cut           |
| **Protocol version**                                 | Two separated components at handshake — node↔server, client↔Hub | A monotonic integer, **one per protocol** | Only when the wire format changes |
| **Schema version** of an entry, contract or manifest | The engine, when reading old data                               | An integer, one per entity                | Only when the data shape changes  |

Mixing the three is the classic error: a website CSS fix would force every node
to upgrade, or a wire-format change would hide inside a patch release. Three axes
change for three different reasons, so they are counted separately.

**`X.Y.Z` belongs to the workspace, not to an app.** One tag cuts **every**
artifact; an app's `package` target only **stamps** that tag onto its artifact and
**never generates a version**. Node skew of **N-1 minor** and protocol
negotiation both rest on **one shared axis**; per-app versions kill both
mechanisms and turn "is this node compatible" into an unanswerable question.

## 1c. One version axis, two repositories

`cloud/` lives in its own private repository, mounted into the public tree as a
submodule. That must **not** produce a second version axis:

| Task                                      | Where                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Cutting the tag `vX.Y.Z`**              | **Only in the public repository.** One axis, one place it is cut                               |
| Stamping the tag onto a `cloud/` artifact | The private repository's CI **reads** the tag and stamps it — it **never generates a version** |
| Signing artifacts                         | Each CI signs its own artifacts; credentials never cross the repository boundary               |

Cloud is **downstream** of the public workspace rather than an equal half of it.
Letting it generate its own version would rebuild exactly the per-project
versioning §1 just rejected, at repository scale, and would once again make _"is
this node compatible with this control plane"_ unanswerable.

**A real consequence, stated rather than hidden**: cloud's CI builds against
`ecoma@main`, which is a moving target. That is **not** a defect — it is how a
third party experiences the public interface, only earlier. If cloud breaks from a
public change, that is **a breaking change that slipped past §3**, not a
scheduling accident.

## 1b. An artifact's identity

Every distributed artifact carries `train_version`, `source_digest`,
`protocol_versions_supported[]`, and `build_provenance` — who built it, where, and
from which commit. **Signatures are produced only in the origin repository's CI**;
a public mirror holds no signing credential. An artifact missing any of the four
fields is not a distributed artifact; it is a file.

## 2. Negotiation — who refuses whom

At handshake the initiator sends `protocol_versions_supported[]` and the receiver
picks **the maximum of the intersection**.

| Situation                                        | Rule                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| There is an intersection                         | Use the shared maximum; the chosen number is recorded in the session's entry                                                                                                                                                                                                                                                                               |
| **No intersection**                              | The receiver **refuses** and emits a `protocol_incompatible` entry carrying both lists. There is no "try anyway" mode                                                                                                                                                                                                                                      |
| A node further than **N-1 minor** from the train | The node **refuses to claim new tasks** — but **keeps heartbeating, keeps accepting update commands, and finishes the task in hand**. A node that silently vanishes from management is a worse failure than one that stops taking work                                                                                                                     |
| A server older than the node                     | The same rule, symmetrically — **a server never downgrades to a protocol it has dropped**                                                                                                                                                                                                                                                                  |
| **A mixed server fleet**                         | During a rolling upgrade a node may reach two servers on different trains. The rule: **dropping a protocol version is an act of the WHOLE fleet, not of one server**, permitted only once **every** server runs a train supporting the new set. Inside the rolling window the fleet's protocol set is the **intersection** across servers, never the union |

**Auto-update is forbidden in every direction** (RPA North Star §4): the system
only **reports** incompatibility; a person decides to upgrade.

## 3. Breaking changes and deprecation

**Before 1.0, minor plays the role of major.** The condition for cutting
`1.0.0` is **when ◆G4 closes** — that is, when every tier 1–3 interface has been
frozen (North Star §8, roadmap §1b). `1.0` is the promise that the public wire
format has stabilised, and anchoring it to **the final freeze gate** anchors it to
a real event rather than to a feeling of readiness. From then on, breaking is
permitted at minor and every rule below reads "minor" for "major".

**Breaking changes happen only at major.** Minor adds; patch fixes.

**Deprecation runs at least one minor before removal**, marked **in the declaring
artifact itself** — `deprecated_since` and `removed_in` on a protocol descriptor,
a contract, a manifest field. **Not in a changelog**: a changelog is not
machine-checkable, and what cannot be checked by machine drifts.

Every use of a deprecated path emits a **`deprecated_used`** entry — who, where,
which path. The projection "who still uses what" is **the precondition for daring
to remove it**; without it, removal is a guess.

## 4. Upgrade

The immovable rules, from North Star §8: **the log is never rewritten**;
projections are **rebuilt** rather than patched; **a migration is an entry**; and
**majors are sequential, never skipped** — X to X+2 passes through X+1.

The standard sequence is four phases, each with a safe stopping point:

| Phase              | Work                                                                                            | If it fails here                                                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · install beside | The new artifact is placed beside the old; the old is still running                             | Delete the new artifact; nothing has changed                                                                                                                                       |
| 2 · migrate        | Each migration is **a Task with an Attempt**: read old, write new, idempotent on `migration_id` | **No half state exists**: on failure the engine **stays on the old version**, projections are untouched, and an escalation is emitted. Re-running is safe because it is idempotent |
| 3 · cutover        | Traffic moves to the new artifact                                                               | Return to phase 2 — the old is not yet removed                                                                                                                                     |
| 4 · retain         | The old artifact is **kept until the rollback window closes** (§5)                              |                                                                                                                                                                                    |

## 5. Rollback — the conditions under which a way back exists

The base rule (North Star §8): **every major migration declares a reverse path, or
declares the flag `irreversible_migration`**, which forces a Gate and a copy taken
beforehand. Checked statically in Composition §4; at the block layer it is
`migrations[].down` (Block §7).

This document adds the **rollback window**: the period during which the reverse
path is still **guaranteed** to run. The first anchor is **until the end of the
next minor**.

**The boundary with the charter**: inside the window, rollback means running the
reverse path, with the procedure in the `deploy` charter. **Outside the window,
rollback no longer exists as an operation** — it becomes _restore from backup plus
replay_, a completely different path with completely different risk. The charter
**must** name that difference and may not call both of them "rollback".

## 6. EOL, the support window, and its interaction with backup

**The support window is the current major plus one previous major**; changing it
requires a stated reason.

**An EOL announcement is a mechanism, not an email.** One truth — the train
registry — with three channels: a `version_eol_announced` entry, a warning in the
Hub's `resolve`, and a warning in the node handshake. Whoever misses one channel
meets another.

**The interaction with the `deploy` charter**: a backup is only useful while **a
version still exists that can read it**. The rule: **a backup's retention window
may not exceed the support window**, unless the charter explicitly declares a
**restore path** that lifts an old backup through the sequential migration chain.
Keeping five years of backups while supporting two majors is **holding a promise
that cannot be kept**.

## 7. A conformance suite is an interface, so it has a version

A suite carries a `suite_id` and **its own major.minor**, independent of the
train.

**Changing a suite is changing an interface, which is breaking**, and it takes the
suite's own major route (Test Harness §7 states this; the breaking law lives
here).

Adding a case **within the same major** is valid only if it **does not turn a
passing implementation into a failing one**. If it does, it is a major — however
much the author considered it a clarification.

A **◆G gate freezes exactly one major of a suite**. Raising the suite's major
reopens the gate, which is a decision requiring reasoning rather than a
maintenance action.

## 8. Two artifacts on one machine — never on different trains

An attended machine runs **two artifacts**: the headless node runtime and the
attended UI layer (ADR-0005). They are on **the same train version**, with no
exception.

At the in-machine handshake the UI layer reads the runtime's `train_version`, and
**a mismatch makes the UI refuse to run** and tell the user to update — it never
self-updates (RPA North Star §4). Dropping back to digest N-1 is an explicit
action with an event, and **both artifacts must move together**. Two artifacts on
one machine drifting apart is _in-machine_ skew, which none of the system's
handshake channels can see, so it has to be blocked where it happens.

## 9. The publish seam for pluggable units

Any unit falling under the **Apache 2.0** layer by the classification rule (North
Star §8 — interface, schema, protocol, client, SDK, vocabulary) **must be
publishable**: a real entry point, a build, and **no** `private: true`.

**A published package's version is the train version**, not a free choice. A third
party has to be able to infer _"which protocol does this client speak"_ from the
single number they can see; two version axes for one artifact makes them consult
a table.

## 10. Non-goals

- **No** version management for blocks or templates — that is the Hub and Block §7
  (digest plus lockfile), a different system.
- **No** auto-update in any direction.
- **No** independent semver for internal libraries.
- **No** promise of infinite backward compatibility — the support window is finite
  and is stated.
- **No** operational procedures (the `deploy` charter).

## 11. Decisions

| Topic                                  | Settled                                                                | Reasoning                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Three version axes                     | Train, protocol, schema — counted separately                           | Three different reasons to change; mixing forces needless upgrades or hides breaking changes inside patches                                   |
| The train belongs to the workspace     | One tag equals every artifact; `package` only stamps                   | N-1 skew and negotiation both rest on one shared axis; per-app versions kill both                                                             |
| A node beyond the skew                 | **Refuses to claim, still heartbeats, still accepts updates**          | A node that silently vanishes is more dangerous than one that stops taking work                                                               |
| Deprecation marked on the artifact     | `deprecated_since` / `removed_in` in the descriptor, not the changelog | A changelog is not machine-checkable, so it drifts                                                                                            |
| Daring to remove needs evidence        | The `deprecated_used` entry plus a "who still uses what" projection    | Removing without measuring usage is guessing                                                                                                  |
| A failed migration                     | Stay on the old version, no half state; idempotent on `migration_id`   | A half state is a state nobody can write a rule for                                                                                           |
| The rollback window                    | Until the end of the next minor; outside it, **it is not rollback**    | Calling restore-from-backup "rollback" makes an operator press the button with the wrong expectation                                          |
| Retention ≤ the support window         | Unless an explicit restore path is declared                            | A backup nothing can read is an empty promise                                                                                                 |
| A suite has its own version            | Changing a suite is breaking; a ◆G gate freezes one suite major        | A suite is an interface, and an interface changing quietly breaks every parallel implementation                                               |
| Two artifacts on one train             | The attended UI refuses to run on a mismatch                           | In-machine skew is invisible to every handshake channel the system has                                                                        |
| A published package's version          | The train version; no independent semver                               | A third party must infer the protocol from one number                                                                                         |
| **The condition for cutting 1.0**      | **When ◆G4 closes**; before that, minor plays major                    | `1.0` is the promise that the wire format is stable; anchoring it to the last freeze gate anchors it to a real event rather than to a feeling |
| **Dropping a protocol is a fleet act** | Inside the rolling window, the protocol set is the **intersection**    | A mixed fleet is the normal state during an upgrade, not an exception                                                                         |

## 12. Failure modes

| Failure                                                  | Detected by                                                            | Recovery                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A migration fails part-way                               | A failed Attempt plus an entry                                         | Stay on the old version; re-run, which is idempotent; escalate if it repeats                                                 |
| Many nodes fall outside the skew after a server upgrade  | Counting `protocol_incompatible` and `claim_refused` entries per node  | Move servers back to the previous train, inside the window, or upgrade the node fleet. **Never** downgrade the protocol      |
| A declared reverse path that fails when run              | Run `down` in phase 2 of a prior environment before the real cutover   | Restore plus replay (a different path, §5), **and mark that migration `irreversible_migration` for remaining installations** |
| A backup outside the support window with no restore path | Reconciling retention against the support window, gated in the charter | There is no path — which is why §6 exists. Prevention, not cure                                                              |
| A suite changed quietly within one major                 | A passing implementation suddenly fails in CI                          | Name it correctly: that is a major. Roll the suite back and cut a new major                                                  |
| Two attended artifacts on different trains               | The UI checks at the in-machine handshake                              | The UI refuses to run; the user moves **both** together                                                                      |
| A node handshakes with server A and fails with server B  | `protocol_incompatible` entries from only part of the fleet            | Finish the rollout so the whole fleet shares one set. **Do not** patch it by pinning the node to one server                  |
| An artifact missing provenance or a signature            | Checked at install                                                     | Refuse to install — there is no "install anyway" mode                                                                        |

## 13. Litmus

1. Fix a CSS bug on the website: does any artifact **force a node to upgrade**? It
   must not — three axes, §1.
2. A node **two minors** behind: does it **refuse to claim** while **still
   heartbeating and still receiving update commands** — or does it vanish from the
   fleet view?
3. Removing a `deprecated` field: can "who still uses it" be answered by a
   projection, or only by faith?
4. A major migration fails at record 10,000: does the system stay on the old
   version **intact**, and does re-running **duplicate nothing**?
5. A rollback **after** the window: does the system call it "rollback"? It must
   not — it is restore plus replay, different risk, different procedure.
6. Keeping five years of backups while the support window is two majors: does a
   gate block that configuration, or does it quietly become an empty promise?
7. Adding a case to a conformance suite within one major that turns a passing
   implementation into a failing one: does CI call that **breaking**, or let it
   through?
8. On an attended machine, force an old-train UI layer against a new-train
   runtime: does the UI **refuse** — or run and fail somewhere nobody predicted?
9. Mid-rollout, a node reaching two servers on different trains: does it see the
   protocol set as the **intersection** of the fleet — or handshake with one
   server and break against the other?
