---
name: scaffold-lib
description: Create a new internal library the way this workspace requires - the mechanical scaffold comes from `dev-cli scaffold-lib` (never hand-copied files), the judgment (which subsystem, which layer, real CLAUDE.md content) stays here. Use whenever adding a lib to shared/ (the only subsystem with real library consumers today); apps are out of scope.
---

# Scaffold a library (Ecoma)

The file shapes are mechanical and owned by `dev-cli scaffold-lib` — never write `project.json`/`package.json`/alias wiring or the README frontmatter by hand (a hand-copy is how convention drift starts). What this skill owns is the judgment the generator cannot make: where the lib lives, and the prose that replaces its loud stubs.

## 1. Decide where it lives — this is an architecture decision

- **Subsystem**: `--subsystem <s>` must name a subsystem that already exists in the tracked file tree — the generator derives the valid set dynamically (`deriveSubsystemRoots` in `scaffold-lib.mjs`), never from a hardcoded list. `shared` is the only one with real library consumers today; a product domain earns generator use once a real leaf exists to scaffold into. Promoting code to `shared` on speculation is the reserved-seam mistake (a contract designed for `n=1` is a guess); `shared` earns a new lib only when a real second consumer needs it now.
- **Language**: `--lang <ts|go|rust|python>` (default `ts`) — pick by what the lib must do, not preference: `ts` is the workspace default; reach for another language only when a real constraint demands it (an ecosystem library, performance, a runtime the product dictates). A polyglot lib still gets a hand-written `project.json` (targets are never inferred) and its cross-project deps are seen by `nx affected` through the `nx-polyglot-graph` plugin.
- **Layer**: the tag constrains every future import this lib may have — pick from what the lib _is_, per the depConstraints in the root `eslint.config.mjs` (the source of truth for what each layer may depend on): `util` cross-cutting pure helpers · `domain` pure types/logic · `port` an interface a domain exposes · `adapter` implements a port · `view` presentational, free of the desktop host runtime. Omit the layer only for genuinely non-layered plumbing (compare `core-tauri`) — omitting to dodge the constraints defeats the boundary.
- If the answer is ambiguous, that ambiguity is a design question — surface it (Rule 1) instead of picking silently.

## 2. Generate

```bash
node shared/tools/dev-cli/src/main.mjs scaffold-lib <name> --subsystem <s> [--lang <ts|go|rust|python>] [--layer <l>]
```

Name is kebab-case, for the end state, never the journey (Rule 13). The generator refuses to overwrite; for `ts` it registers the `@ecoma-io/<name>` alias itself, and for `go`/`rust`/`python` it wires the repo-root workspace file (`go.work` · `Cargo.toml` members · `pyproject.toml` `[tool.uv.workspace]`) and the needed `.gitignore` lines. It also emits the mandatory doc set — `CLAUDE.md` plus **all 3 README language variants** — as loud TODO stubs that already satisfy their gates.

## 3. Replace the stubs and close the seam

The generator leaves three placeholders, and replacing them is part of the scaffold, not a follow-up: two prose stubs and one config seam. A scaffold may land with an empty core; it must never land with a TODO or a half-closed seam still in it.

`src/index.ts` arrives as `export {};` and stays a **re-export barrel** — every `index.ts` in this workspace is one (`core-tauri`'s is two lines, with the logic and its test in `window-controls.*`). Logic goes in a named module beside it, and its test is named after that module. A test called `index.test.ts` names a barrel rather than a unit, which tells a reader nothing about what is under test.

**`CLAUDE.md`** — content per the root `CLAUDE.md` Documentation mandate: only what reading the code does **not** reveal (role, invariants, footguns, pairing rules); point to owning tiers instead of copying rules down; a thin lib gets a short boundary card, not padding. Model it on a real one (e.g. `shared/libs/core-tauri/CLAUDE.md`).

**`README.md` · `README.vi.md` · `README.zh.md`** — every subproject carries all 3, and they are **written**, not machine-translated placeholders left in place. The generator already fixed everything structural (frontmatter `name`/`subsystem`/`lang`/`description`, the language-switcher nav line, the `# H1`, and the 5 ordered `<!-- readme:* -->` markers); `check-subproject-readmes` gates exactly that much and no more. What is on you is the part no gate can judge:

- Write the **description and every section body in that file's own language** — Vietnamese prose in `README.vi.md`, Chinese in `README.zh.md`. English text sitting under a `lang: vi` frontmatter passes every check and is still wrong.
- Keep the 3 **semantically in agreement**: facts, instructions, and links must not diverge; wording may. Changing one variant and not the other two is the failure mode here (`repo-care` flags this advisory-only — it is a judgment call, so it cannot block a merge and will not catch you).
- The sections answer fixed questions — why it exists · who consumes it · where it sits · what it deliberately does not do · status. A README is not the `CLAUDE.md`: it is the outside view (why this project earns its own directory), while `CLAUDE.md` is the inside view (mechanics for whoever edits it). Do not write one twice. Model on a real triad, e.g. `shared/tools/nx-polyglot-graph/README*.md`.

**`vitest.config.ts` — the reserved seam, both halves.** The emitted config ships `passWithNoTests: true` and `coverage.enabled: false`, and its comment says to close both once real tests land. They exist because a fresh scaffold has no tests: the gate must pass against none, and a floor measured against none would fail on the first commit. Neither survives the arrival of tests, and closing one is not closing the seam — with `passWithNoTests` left in, deleting every test keeps the target green; with coverage left off, the project never measures the floor every other project holds. `check-project-conventions` now judges both, keyed on the project having test files exactly as its pytest twin is: a project with tests must carry no `passWithNoTests: true`, must set `coverage.enabled: true`, and must take `thresholds` from the repo-root `coverage.config.json` — which is also why closing the seam is a two-word edit rather than a number to look up, and why importing the shared floor and then overriding a metric downward fails the same gate.

## 4. Verify and commit

```bash
node shared/tools/dev-cli/src/main.mjs check-project-conventions
node shared/tools/dev-cli/src/main.mjs check-claude-md
node shared/tools/dev-cli/src/main.mjs check-subproject-readmes
pnpm nx run <name>:lint && pnpm nx run <name>:typecheck && pnpm nx run <name>:test
```

`test` belongs in that list precisely because it is what proves the seam is closed: with coverage still disabled the target passes while measuring nothing, and the run is where you see the floor either hold or fail.

`check-project-conventions` reads `git ls-files`, so it reports the alias as pointing at a missing file until the scaffold is staged. Run `git add` first rather than debugging a path that is on disk.

**Two commits, not one.** The generator always writes a root-owned file alongside the project — `tsconfig.base.json` for `ts`, and `go.work` · `Cargo.toml` · `pyproject.toml` for the others — and `check-commit-scope` refuses to cover a root-owned path and a project-owned one under a single scope. Commit the project as `feat(<name>): …`, then the root registration as `build(workspace): …`. That order matters: an alias pointing at a file that does not exist yet breaks resolution for anything typechecking in between, while a library with no alias merely goes unimported.

## Downstream workspaces

The private cloud workspace consumes this skill through its pinned harness
reference: the procedure is unchanged, but `shared/tools/dev-cli/...`
commands are reached at `.harness/shared/tools/dev-cli/...` there, and the
tree being judged is the one the session stands in.
