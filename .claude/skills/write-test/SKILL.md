---
name: write-test
description: Write a test that fits this repo's enforced taxonomy and actually pins intent - choosing the right tier (unit vs integration vs e2e), the property/fuzz technique per language, satisfying the mock-isolation lint, and titling by behavior. Use when adding or reworking tests here, or when the `no-unmocked-internal-imports` / `no-focused-or-skipped-tests` lint rules rejected a test.
---

# Write a test (Ecoma)

The lint rules enforce the mechanics (`local/no-unmocked-internal-imports`, `local/no-focused-or-skipped-tests` — see `eslint.config.mjs`); this skill owns the judgment they cannot check: picking the tier and making the test worth having (Rule 8).

## 1. Pick the tier — by what is under test, not by convenience

The tier is a judgment call about **what is under test**, and it is the same call in every language:

- **Unit** (the default): the unit's own logic is under test, isolated from **every** project-internal collaborator; never mock pure third-party libraries. If isolating a collaborator makes the test meaningless, that is a signal you are in the wrong tier, not a reason to fight the mechanism.
- **Integration**: only when the **interaction itself** is the thing under test — real collaborators, real fs/git in throwaway temp dirs where needed (see `dev-cli`'s `*.integration.test.mjs` for the pattern). "The unit test was annoying to isolate" is not a reason; "the contract between these two pieces is the behavior I'm pinning" is.
- **e2e** (`Foo.e2e.test.ts` · `foo_e2e_test.go` · `foo_e2e_test.py`; Rust has no marker, its e2e files are plain `tests/*.rs`): lives only in the `<app>-e2e` project, never co-located (`check-project-conventions` rejects the other three elsewhere; the Rust case is on review). Drives built apps; reach for it only when runtime proof through the real shell is the point.

## 2. Express the tier in the language's own mechanism

The per-language mechanics — filename suffixes, co-location, which tier's
isolation is machine-enforced and which stays on review, and the fact that one
`test` target runs both co-located tiers with no second mechanism to add — are
owned by the root `CLAUDE.md` test-taxonomy bullets. Read them there; a copy
here would be a second rule with no way to tell which binds.

One consequence the owning tier states only as "compiler-guaranteed", spelled
out because it changes what you write: in **Rust** the split is not a
convention you can bend — a `tests/*.rs` file physically cannot call a private
item (`error[E0603]`). If an integration test needs internals, the behavior
belongs in the unit tier, not in a `pub` you widened to make the test compile.

## 3. Property and fuzz tests — a unit-tier technique, not a fourth tier

Property-based and fuzz tests pin an invariant over a generated input space — totality ("never throws"), idempotence, round-trips, clamping. They are a **technique inside the unit tier**, not a new tier: same co-location, same filename suffix, same `test` target, same isolation rules (mock project-internal collaborators; never third-party libs). `shared/libs/core-ui/src/lib/cn.test.ts` is the TS pattern to copy.

|            | Mechanism                                                                                 | Runs under the plain `test` target | Counterexample → committed pin                                                                                                                                                                                                                                                                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TS**     | `fast-check` via `@fast-check/vitest` — `test.prop([...arbitraries], { numRuns, seed })`  | yes (plain `*.test.ts`)            | pin the shrunk counterexample as a plain `test()`, or fix `{ seed }` — the wrapper seeds each run from `Date.now() ^ Math.random()` and prints it in the test title (`with seed=…`), so a failure replays but a sample never repeats on its own                                                                                                                               |
| **Go**     | native `testing/fuzz` — `FuzzXxx(f *testing.F)` in `*_test.go`, seeds via `f.Add(...)`    | seeds only, always                 | commit the crash file `testdata/fuzz/<FuzzXxx>/<hash>` — it becomes a seed every `go test` replays; the engine itself runs only with `-fuzz` (bounded by `-fuzztime`) and never belongs in the CI `test` target. The corpus dir is keyed by the target's name: rename `FuzzXxx` without moving `testdata/fuzz/FuzzXxx/` and the pins go silently dead — `go test` stays green |
| **Rust**   | `proptest` (`proptest!` / `#[proptest]`), inside `#[cfg(test)] mod tests` — the unit tier | yes (`cargo test`)                 | commit the `proptest-regressions/<file>.txt` file the failure generated — it replays automatically, before the random cases                                                                                                                                                                                                                                                   |
| **Python** | `hypothesis` — `@given(...)` strategies in `foo_test.py`                                  | yes (`uv run pytest`)              | pin the minimized failing input with `@example(...)` — the workspace's pin is the visible decorator, so the `.hypothesis/` DB stays local replay and gitignored (hypothesis itself supports committing `.hypothesis/examples/`; we trade that for a pin readable in the test file)                                                                                            |

- The `test` target runs a **bounded** search, never an unbounded engine: a fixed budget per run (`numRuns` · proptest's default 256 cases · hypothesis's `max_examples` — or, for Go, no generation at all, just seeds+corpus replay). Anything that must _keep searching_ (Go's `-fuzz` engine, an extended hypothesis run) is interactive-or-scheduled only, and its discoveries return to the suite as pins.
- On CI the `test` target is additionally **deterministic**. Random exploration belongs to dev runs — a CI red must be attributable to the change that caused it, never to an unlucky seed landing on an unrelated PR, and Nx task caching assumes same inputs → same result, which a run-varying seed breaks in both directions (spurious red on innocent changes, cached green replaying over a real counterexample). Per language: TS/JS pins the seed when `CI` is set (`fc.configureGlobal` in the repo-root `vitest.property-seed.mjs` — load it from the project's `setupFiles`, never copy the constant into a second file); Go needs nothing (corpus-only under `go test`); Rust sets `PROPTEST_RNG_SEED` in the CI env once a crate exists; Python needs nothing — hypothesis auto-activates its `ci` profile (`derandomize=True`, `database=None`) when the `CI` env var is set.
- A property test states its invariant as the title (Rule 13) — "is idempotent: re-merging the merged result leaves it unchanged", never "fuzzes cn".
- They fit pure logic: parsers, transforms, merge/split, clamps. If the behavior under test cannot state an invariant, what you wrote is a slowly-random example test — write the example test instead.
- A counterexample a property test finds is a bug report: pin it before fixing, so the fix ships with its regression (CONTRIBUTING.md).

## 4. Make it pin intent (Rule 8)

Before writing assertions, answer: _which important behavior, if someone broke it, must this test catch?_ Then check the test you wrote against it — if the important logic could change and the test stays green, the test is inadequate regardless of coverage. Prefer asserting observable behavior and contracts over internal call sequences; a test that pins "was called with" usually survives refactors worse than one that pins "produces".

## 5. Title and hygiene

- Title = the behavior pinned, present tense, no journey (Rule 13): "flags a scope tag that contradicts the directory", never "works", "fixes bug", or a phase/ticket reference.
- Planned-but-unbuilt behavior is declared, not hidden: TS `it.todo("…")` — never a committed `.skip`/`.only`, which `local/no-focused-or-skipped-tests` blocks. The other languages have no such lint, so the same honesty is on review: Go `t.Skip("…")` and Python `@pytest.mark.skip(reason="…")` must carry a reason naming what is unbuilt, and Rust `#[ignore = "…"]` likewise. A skip whose reason is missing or says "flaky" is a disabled test pretending to be a plan.
- A bug fix ships with the test that fails without it (CONTRIBUTING.md).
- Determinism: inject clocks/randomness/fs boundaries rather than reading them ambiently — the repo's cores never read the clock themselves.

## 6. Verify

Run the project's `test` target and confirm the new test fails when you sabotage the behavior it pins (comment the logic, flip a branch) — a test never seen red proves nothing (Rule 11).
