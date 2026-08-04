---
name: commit-msg
description: Compose or fix a Conventional Commit message for THIS repo, whose rules are stricter than plain Conventional Commits — scope is mandatory and must be the narrowest project/subsystem/workspace scope covering every changed path, with one relaxation for upstream-dependency commits. Use whenever you are about to write, amend, split, or debug a rejected commit message here (the commit-msg hook or CI failed on `scope-empty`, `scope-enum`, or "scope does not match the changed paths").
---

# Commit messages (Ecoma)

This repo runs **two** commit-message gates, both on the local `commit-msg` hook and re-run per PR commit in CI (`.github/workflows/ci.yml`). PRs are rebase-merged, so every branch commit lands on `main` verbatim — a `wip` commit or a wrong scope fails CI even if the final tree is fine. Get each commit right as you write it.

- **Tier 1 — shape + vocabulary** (`commitlint.config.mjs`, `@commitlint/config-conventional`): the header must be a Conventional Commit, the scope is **mandatory**, and it must be one word from a fixed vocabulary.
- **Tier 2 — scope ↔ path** (`dev-cli check-commit-scope`, source `shared/tools/dev-cli/src/check-commit-scope.mjs`): the scope must be the **narrowest** scope that covers **every** path the commit touches.

Full prose rationale lives in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md); this skill is the operational procedure.

## 1. Header anatomy

```
type(scope): subject
```

- **type** — exactly one of `build` `chore` `ci` `docs` `feat` `fix` `perf` `refactor` `revert` `style` `test`, lowercase. Nothing else passes.
- **scope** — **required** (plain Conventional Commits allows omitting it; this repo does not — `scope-empty` is an error). Exactly one scope, no commas / slashes / spaces. It must be a member of the vocabulary in §2 and satisfy the path rule in §3.
- **subject** — non-empty, imperative mood, **no trailing period**, and not `Sentence-case` / `Start-Case` / `PascalCase` / `UPPER-CASE` (start lowercase). Header (`type(scope): subject`) ≤ **100** chars.
- **breaking change** — put `!` before the colon (`feat(core-ui)!: …`) and/or a `BREAKING CHANGE:` footer.
- **body / footer** — optional; leading blank line before each (warning), lines ≤ 100 chars.

Agent note: the `Co-Authored-By: Claude` / `Claude-Session:` trailers are stripped automatically by the `prepare-commit-msg` hook — do not add them, and do not rely on them being present.

## 2. Scope vocabulary

Never maintained by hand — emit it live (derived from the tracked `project.json` files, the same module commitlint's `scope-enum` reads):

```bash
node shared/tools/dev-cli/src/main.mjs list-scopes         # one scope per line
node shared/tools/dev-cli/src/main.mjs list-scopes --json  # JSON array
```

It contains every Nx project name, every subsystem root that contains projects, and `workspace` (a project can share its subsystem's name when that subsystem has exactly one project — those dedupe to one scope). A new project's scope is valid the moment its `project.json` is committed.

## 3. Picking the scope

The checker (`dev-cli check-commit-scope`) owns the algorithm — never re-derive it from prose; when unsure, dry-run it (§7). The shape of the rule, for prediction only:

- Each changed path is owned by the **deepest project** containing it (`shared/libs/core-ui/…` → `core-ui`, not `shared`); else by its **subsystem** — the top-level dir, which owns files no project claims (`shared/CLAUDE.md` → `shared`); else by **workspace** (repo-root files, `.github/…`, `.claude/…`).
- The scope must be the **narrowest cover**: one project → that project; several owners inside one subsystem → the subsystem; every touched path root-owned (or spanning two-plus subsystems) → `workspace`. `pnpm-lock.yaml` never counts.
- Tightness fails both ways: too broad (`shared` when only `core-ui` changed) **and** too narrow (a project scope while a sibling project also changed) — split the commit or move up.
- **A commit that mixes root-owned paths with project- or subsystem-owned paths has no honest scope and is rejected outright**, whatever scope you claim — `workspace` would bury the project-specific work in a bucket the changelog can't attribute; the project/subsystem scope would misdescribe the root-level change. Split it: one commit scoped `workspace` for the root paths (e.g. adding a dependency in root `package.json`), one per project/subsystem for the rest. This is enforced, not a style preference — see §8's last example.

## 4. The upstream-dependency exception

The one relaxation, so an atomic cross-project change stays honest instead of ballooning to `workspace`:

> When **every** changed path is owned by a project (no subsystem docs, no root files) **and more than one project** is touched, a touched project **P**'s own name is also allowed **if every other touched project transitively depends on P** in the Nx graph (`pnpm nx graph`).

Direction matters: the allowed scope is the **dependency** (the thing others import), not a consumer. Example — an API change in `core-ui` plus the edits that adapt its consumers in the same commit:

```
fix(core-ui): rename Slider step prop and update its callers
```

is accepted when every other touched project (e.g. a lib that consumes `core-ui`'s primitives) transitively depends on `core-ui`. If even one touched project does **not** depend on the chosen scope, or a subsystem/root file sneaks in, the exception evaporates and you fall back to the subsystem or `workspace` — or, better, split the commit.

## 5. Messages the gates ignore

These skip both tiers (matching commitlint's defaults) — you don't force a scope onto them:

- merge commits (`Merge branch …`, `Merge pull request …`, `Merge remote-tracking branch …`);
- reverts git writes (`Revert "…"`);
- `fixup!` / `squash!` / `amend!` autosquash headers;
- a bare version bump (`1.2.3`, `v1.2.3-beta.1`).

Everything else you author by hand must carry a valid `type(scope)`. Keep branch history clean — autosquash/`wip` commits that survive to the PR fail CI.

## 6. Scaffolding a new project

The checker discovers projects from the **tree it is judging**, so a commit that adds `foo/libs/foo-thing/project.json` may already use `feat(foo-thing): …` in that same commit — the new scope is live as soon as its `project.json` is staged. (Every new `project.json` also needs its own `CLAUDE.md`, enforced by `dev-cli check-claude-md`.)

## 7. Verify before you rely on it

- **Fastest loop:** stage your change, write your best-guess message, and commit. On a scope mismatch the hook prints `allowed here: <scopes>` and lists each owner with its paths — read it and correct the scope. This is the source-of-truth check; don't second-guess it.
- **Dry-run without committing:** point the checker at a message file against the current index —
  ```bash
  node -e "fs.writeFileSync('.git/COMMIT_MSG_DRYRUN', 'feat(core-ui): my subject\n')"
  node shared/tools/dev-cli/src/main.mjs check-commit-scope .git/COMMIT_MSG_DRYRUN
  ```
  exit `0` = accepted, `1` = rejected (reason on stderr). It judges **staged** paths (`git diff --cached`), so stage first. (Node-only on purpose — contributor machines guarantee Node, not a POSIX shell; `.git/` keeps the scratch file out of the tree.)
- **Judge an existing commit** (what CI does): `node shared/tools/dev-cli/src/main.mjs check-commit-scope --commit <sha>`.

## 8. Worked examples

```
feat(core-ui): add drag handles for element resizing       # one project
fix(dev-cli): correct commit-scope path matching            # one project
docs(shared): clarify shared-tier boundary                  # shared/CLAUDE.md → subsystem
chore(shared): bump shared tooling deps                     # two shared projects → subsystem
fix(core-ui): rename Slider prop and adapt consumers        # upstream exception (§4)
chore(workspace): bump nx                                  # root files → workspace
docs(workspace): add commit-msg skill                      # .claude/ files → workspace
```

Rejected — split instead, whatever scope is claimed:

```
chore(workspace): add lodash and use it in the Slider        # package.json + core-ui code, mixed
```

becomes two commits: `chore(workspace): add lodash` (root `package.json` only), then `feat(core-ui): use lodash in Slider` (project-owned only).

## Downstream workspaces

The private cloud workspace consumes this skill through its pinned harness
reference: the procedure is unchanged, but `shared/tools/dev-cli/...`
commands are reached at `.harness/shared/tools/dev-cli/...` there, and the
tree being judged is the one the session stands in.
