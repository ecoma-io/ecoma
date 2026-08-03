---
title: "Process Test Harness"
status: design-end-state
---

# Process Test Harness

## 1. Test mode is a mode of the engine, not a second engine

**A test run scope** is **one labelled run, inside the very tenant that owns the
definition**. Every entry it produces carries `run_kind: test` and a
`test_run_id`. **Isolation is a projection filter**, not a new hard boundary.

**Why not a separate tenant.** A tenant is the system's **only hard boundary**
(Tenant §2). Inventing a `test` tenant would force answers about cardinality,
ownership, lifecycle, key tree and metering, and would force open a
**cross-tenant artifact copy path** for definitions and fixtures — which Artifact
Store §4 forbids explicitly, because cross-tenant content addressing is a side
channel, and which invariant 4 forbids for learning.

The harness has exactly three real needs, and all three **already have
mechanisms**: no outward effects → `test_behavior` on the Contract; no poisoning
the flywheel → the only write path into calibration is a valid Judgment
(Calibration §2); no dirtying production data → every write is an event, so
filtering by label suffices. **Adding a concept to solve a problem that already
has a mechanism is a more expensive half-mechanism.**

**What the label forces** — engine behaviour, not convention. The label's
canonical home is Event Log §1/§3; this table lists each consumer's position
rather than redefining the label:

| Dimension                  | The rule under `run_kind: test`                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calibration                | A Judgment produced in a test run **never enters a production cell** (Calibration §2 reads the label)                                                               |
| Metering / quota / billing | The metering projection **excludes the test label** (Event Log §3) — except that real incurred cost, tokens and sandbox CPU, is still measured, because it happened |
| DataTable / Working Data   | A test run's writes land in **a projection split by label**; production tables do not see them                                                                      |
| Outward effects            | Blocked at the Contract (§5)                                                                                                                                        |
| Secrets                    | Production handles do not resolve (Vault §5)                                                                                                                        |
| n=1                        | The user sees no concept at all: there is a "try it" button                                                                                                         |

**A test run is an entry in the log**, with an id, `definition@version`,
`fixture@version`, result and provenance — comparable across versions, and
reconstructable.

**No separate code branch for test.** Same engine, same primitives, same write
path. What differs is the run label, the filler binding, and the contract's
`test_behavior`.

## 2. Fixture — versioned seed data

| Component          | Content                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Seed entries       | The initialising entries — tasks, artifacts, parties, working data — replayable                                                                           |
| Filler binding     | The mapping from Role to mock filler (§3)                                                                                                                 |
| Recorded responses | Recorded LLM and HTTP responses, used in `replay` mode (§4)                                                                                               |
| Clock              | Virtual time, so timers and SLAs can be **fast-forwarded** — Escalation timers are entries, so fast-forward means emitting them early rather than waiting |

A fixture is **an artifact with an id, version and lineage**, like everything
else here: editing one creates a new version, so results before and after are
comparable.

## 3. A mock filler is still a real Filler

A mock filler has a **real identity** (`mock:<name>@version`) registered through
**the ordinary Filler interface**. It is simply a filler that returns predetermined
results. No new mechanism, and it is evidence that the human/AI/mock symmetry
holds.

**`environment: test` is a dimension of filler identity, NOT a fifth trust
tier.** Role §5's table keeps exactly **four tiers** (`shadow`, `gated`,
`sampled`, `autonomous`), because the tier taxonomy has one home. A filler
carrying `environment: test` **is not eligible for a production task**,
independently of its tier. Mixing the two axes — confidence and environment —
into one enum would create a second source of truth for the tier taxonomy.

**Hard boundary: a mock filler's Judgment NEVER enters a production calibration
cell.** A calibration cell is an organisational asset (Calibration §0), and
poisoning it with synthetic data breaks the flywheel irreversibly. It is enforced
by the `run_kind: test` label on the entry (§1), not by a new tenant boundary.

A mock may return a fixed result, a sequence of results, fail deliberately, or be
slow deliberately, which is how SLA and escalation get tested.

## 4. Non-determinism — three modes

| Mode     | Used when                        | Behaviour                                                                                                           |
| -------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `replay` | **The default in CI**            | Reads recorded responses only — perfectly deterministic                                                             |
| `record` | Creating or refreshing a fixture | Calls for real and writes the responses into the fixture, labelled with cost and timestamp                          |
| `live`   | Nightly, or before a release     | Calls for real and accepts non-repeatability; results carry a `non_deterministic` label and may never block a merge |

## 5. Effects — the safety boundary lives on the Contract

Each contract declares `test_behavior`: `mock`, `dry_run`, or `forbidden`
(Handoff §3). **An absent declaration resolves to `forbidden`**, and the engine
blocks it with an entry saying why.

**The harness never guesses** which effect is safe; it only executes what was
declared. Guessing wrong once means a real email to a real customer.

**`dry_run` requires the adapter to declare the capability.** Dry-run is **a
capability of the adapter** — channel, driver, HTTP, mail — not of the contract.
An adapter declares `supports_dry_run`; **a contract declaring `dry_run` against
an adapter that does not support it resolves to `forbidden`** — missing capability
means stricter, never looser — and **static analysis checks the
`contract × adapter` pair** before anything runs (Composition §4). Without that
rule, the exact place the harness swears never to guess is the place it would have
to: either send the real mail, or silently skip.

**Secrets**: a test run scope **cannot resolve a production secret handle** (Vault
§5). `forbidden` blocks only _writing_ effects; a test _reading_ real customer
data with a real key is still a leak, and the contract door does not stop it.

Running for real inside a test is possible, and requires an explicit declaration
and a capability — deliberate rather than accidental.

## 6. Assertions — over the log, not the UI

| Kind         | Example                                                      |
| ------------ | ------------------------------------------------------------ |
| Reachability | A task reaches Gate X, or state Y                            |
| Judgment     | The verdict is reject on criterion Z                         |
| Timer        | The SLA fires after interval T, on the virtual clock         |
| **Negative** | **No effect left the system**; no entry of kind E appeared   |
| Invariant    | Every Gate has a Judgment; no attempt exists without a lease |

An assertion is **a declared artifact** with a version, attached to a definition —
not hand-written code scattered around.

## 7. The conformance suite — same mechanism, different subject

A suite for an **interface** (◆G0–G4) rather than for a definition: the same
fixtures and assertions, run against an **implementation** to check that it obeys
the interface. One harness, two uses.

A suite is **a versioned artifact**, and **changing a suite is changing the
interface, which is breaking** and goes the major-version route.

It lives in CI, and passing a gate means **passing the suite** rather than having
read it carefully.

It runs **independently** against any implementation, which is the precondition
for opening parallel tracks at all.

**Every projection must carry a `run_kind` negative test in the suite that
arbitrates it** (Event Log §3): a new projection arriving without one fails that
suite and is blocked from merging. That is where the harness pays back the very
isolation law it depends on.

## 8. Who runs it

| Consumer | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User     | Before publishing a process definition — static analysis catches structural errors, the harness catches _behavioural_ ones                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| CI       | Every pull request, across the three speed tiers; the conformance suite at every gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Hub**  | **Verified review**: a block or template ships its own suite, so a publisher can demonstrate the block works. The suite is **supporting evidence and never sufficient** for the badge — a reviewer's Judgment is what grants it. It runs in **the operator's test run scope**: effects fully `forbidden`, **zero secret handles**, and time and resource ceilings. For a `code` trust-class block the review loop runs **inside the runtime sandbox** (Runtime Sandbox §6) — there is no path by which unverified code runs outside that enclosure in order to become verified (Hub §7) |

## 9. Non-goals

- Not load or performance testing — a different purpose and a different
  mechanism.
- No separate engine branch, no separate store or database for tests — **and no
  separate tenant** (§1).
- No AI-generated assertions today; the door is open through pair-design, where a
  Drafter proposes and a person approves through a Gate.
- Not a replacement for static analysis (Composition §4). Two different layers:
  structure against behaviour.

## 10. Decisions

| Question                                 | Settled                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is                               | A mode of the engine plus a **labelled test run scope** inside the tenant itself, not a second system; a test run is an entry                                                                                                                                                                                                      |
| **Why not a separate tenant**            | A tenant is the only hard boundary; a `test` tenant would force open cross-tenant artifact copying (which Artifact Store §4 forbids) and force answers on cardinality, key tree and metering. The three real needs already have mechanisms: `test_behavior`, the Judgment-only calibration write path, and every-write-is-an-event |
| **`test` is an environment, not a tier** | Trust tiers stay at four (Role §5) — mixing confidence with environment creates a second source of truth for the tier taxonomy                                                                                                                                                                                                     |
| **`dry_run`**                            | **A capability of the adapter** (`supports_dry_run`); unsupported resolves to `forbidden`; static analysis checks the contract × adapter pair                                                                                                                                                                                      |
| **Secrets in test**                      | Production handles do not resolve — `forbidden` blocks _writes_, not _reads_                                                                                                                                                                                                                                                       |
| The effect boundary                      | Declared on the **Contract** (`test_behavior`), defaulting to `forbidden` — the harness executes rather than guesses                                                                                                                                                                                                               |
| Mock filler                              | A real filler in the `test` environment, **absolutely barred from production calibration**                                                                                                                                                                                                                                         |
| LLM calls                                | `replay` by default in CI, `record`, and `live` nightly without blocking merges                                                                                                                                                                                                                                                    |
| Assertions                               | Declared artifacts, measured over the log, including a **negative** kind                                                                                                                                                                                                                                                           |
| Conformance suite                        | The same mechanism with an implementation as its subject; changing a suite is breaking                                                                                                                                                                                                                                             |
| Relation to static analysis              | Complementary, not a replacement: structure against behaviour                                                                                                                                                                                                                                                                      |

## Litmus

1. Run a process whose contract sends email, in test mode: does **no email leave
   the system**, and does the log record that it was blocked as `forbidden`?
2. The same fixture under `replay`, run a hundred times — **identical results**?
3. Is there any path by which a mock filler's Judgment reaches a production
   calibration cell?
   3b. A contract declaring `dry_run` against an adapter that does **not** declare
   `supports_dry_run`: does the engine resolve to `forbidden` and static analysis
   report the error before anything runs — with no path that either runs for real
   or silently skips?
4. Does a seven-day SLA test complete in **seconds** on the virtual clock, without
   editing a single line of the definition?
5. Can a new implementation of any ◆G interface run the conformance suite
   **independently**, without the rest of the system?
