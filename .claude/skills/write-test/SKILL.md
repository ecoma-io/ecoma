---
name: write-test
description: Write a test that fits this repo's enforced taxonomy and actually pins intent - choosing the right tier (unit vs integration vs e2e), satisfying the mock-isolation lint, and titling by behavior. Use when adding or reworking tests here, or when the `no-unmocked-internal-imports` / `no-focused-or-skipped-tests` lint rules rejected a test.
---

# Write a test (Ecoma)

The lint rules enforce the mechanics (`local/no-unmocked-internal-imports`, `local/no-focused-or-skipped-tests` — see `eslint.config.mjs`); this skill owns the judgment they cannot check: picking the tier and making the test worth having (Rule 8).

## 1. Pick the tier — by what is under test, not by convenience

The tier is a judgment call about **what is under test**, and it is the same call in every language:

- **Unit** (the default): the unit's own logic is under test, isolated from **every** project-internal collaborator; never mock pure third-party libraries. If isolating a collaborator makes the test meaningless, that is a signal you are in the wrong tier, not a reason to fight the mechanism.
- **Integration**: only when the **interaction itself** is the thing under test — real collaborators, real fs/git in throwaway temp dirs where needed (see `dev-cli`'s `*.integration.test.mjs` for the pattern). "The unit test was annoying to isolate" is not a reason; "the contract between these two pieces is the behavior I'm pinning" is.
- **e2e** (`Foo.e2e.test.ts` · `foo_e2e_test.go` · `foo_e2e_test.py`; Rust has no marker, its e2e files are plain `tests/*.rs`): lives only in the `<app>-e2e` project, never co-located (`check-project-conventions` rejects the other three elsewhere; the Rust case is on review). Drives built apps; reach for it only when runtime proof through the real shell is the point.

## 2. Express the tier in the language's own mechanism

|            | Unit                                                | Integration                               | Isolation is enforced by                                                 |
| ---------- | --------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| **TS**     | `Foo.test.ts`, co-located                           | `Foo.integration.test.ts`, co-located     | `local/no-unmocked-internal-imports` (lint)                              |
| **Go**     | `foo_test.go`, in the package                       | `foo_integration_test.go`, in the package | nothing — **review only**                                                |
| **Rust**   | `#[cfg(test)] mod tests` **inside** the source file | `tests/*.rs` at crate root                | the compiler — `tests/` is a separate crate and sees only the public API |
| **Python** | `foo_test.py`, next to `foo.py` in `src/<module>/`  | `foo_integration_test.py`, same place     | nothing — **review only**                                                |

Each language's `test` target already runs **both** tiers (`vitest run` · `go test ./...` · `cargo test` · `uv run pytest`) — there is no separate integration target and no build tag or pytest marker to add. Do not invent a second tier mechanism alongside the filename; it can only drift from the name it duplicates.

Two consequences worth naming out loud:

- In **Go and Python** nothing stops a `foo_test.go` / `foo_test.py` from quietly touching a real collaborator. Isolating it is on you; letting it slide is a Rule 11 miss, not a shortcut.
- In **Rust** the split is not a convention you can bend: a `tests/*.rs` file physically cannot call a private item (`error[E0603]`). If an integration test needs internals, the behavior belongs in the unit tier, not in a `pub` you widened to make the test compile.

## 3. Make it pin intent (Rule 8)

Before writing assertions, answer: _which important behavior, if someone broke it, must this test catch?_ Then check the test you wrote against it — if the important logic could change and the test stays green, the test is inadequate regardless of coverage. Prefer asserting observable behavior and contracts over internal call sequences; a test that pins "was called with" usually survives refactors worse than one that pins "produces".

## 4. Title and hygiene

- Title = the behavior pinned, present tense, no journey (Rule 13): "flags a scope tag that contradicts the directory", never "works", "fixes bug", or a phase/ticket reference.
- Planned-but-unbuilt behavior is declared, not hidden: TS `it.todo("…")` — never a committed `.skip`/`.only`, which `local/no-focused-or-skipped-tests` blocks. The other languages have no such lint, so the same honesty is on review: Go `t.Skip("…")` and Python `@pytest.mark.skip(reason="…")` must carry a reason naming what is unbuilt, and Rust `#[ignore = "…"]` likewise. A skip whose reason is missing or says "flaky" is a disabled test pretending to be a plan.
- A bug fix ships with the test that fails without it (CONTRIBUTING.md).
- Determinism: inject clocks/randomness/fs boundaries rather than reading them ambiently — the repo's cores never read the clock themselves.

## 5. Verify

Run the project's `test` target and confirm the new test fails when you sabotage the behavior it pins (comment the logic, flip a branch) — a test never seen red proves nothing (Rule 11).
