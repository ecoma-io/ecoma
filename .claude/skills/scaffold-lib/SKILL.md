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

## 3. Replace the stubs — the only prose that matters

Both stubs are placeholders, and replacing them is part of the scaffold, not a follow-up. The scaffold may land with a loud `export {};` core; it must never land with these TODOs still in it.

**`CLAUDE.md`** — content per the root `CLAUDE.md` Documentation mandate: only what reading the code does **not** reveal (role, invariants, footguns, pairing rules); point to owning tiers instead of copying rules down; a thin lib gets a short boundary card, not padding. Model it on a real one (e.g. `shared/libs/core-tauri/CLAUDE.md`).

**`README.md` · `README.vi.md` · `README.zh.md`** — every subproject carries all 3, and they are **written**, not machine-translated placeholders left in place. The generator already fixed everything structural (frontmatter `name`/`subsystem`/`lang`/`description`, the language-switcher nav line, the `# H1`, and the 5 ordered `<!-- readme:* -->` markers); `check-subproject-readmes` gates exactly that much and no more. What is on you is the part no gate can judge:

- Write the **description and every section body in that file's own language** — Vietnamese prose in `README.vi.md`, Chinese in `README.zh.md`. English text sitting under a `lang: vi` frontmatter passes every check and is still wrong.
- Keep the 3 **semantically in agreement**: facts, instructions, and links must not diverge; wording may. Changing one variant and not the other two is the failure mode here (`repo-care` flags this advisory-only — it is a judgment call, so it cannot block a merge and will not catch you).
- The sections answer fixed questions — why it exists · who consumes it · where it sits · what it deliberately does not do · status. A README is not the `CLAUDE.md`: it is the outside view (why this project earns its own directory), while `CLAUDE.md` is the inside view (mechanics for whoever edits it). Do not write one twice. Model on a real triad, e.g. `shared/tools/nx-polyglot-graph/README*.md`.

## 4. Verify and commit

```bash
node shared/tools/dev-cli/src/main.mjs check-project-conventions
node shared/tools/dev-cli/src/main.mjs check-claude-md
node shared/tools/dev-cli/src/main.mjs check-subproject-readmes
pnpm nx run <name>:lint && pnpm nx run <name>:typecheck
```

Commit as `feat(<name>): …` — the scope is valid in the same commit that adds the `project.json` (commit-msg skill §6).
