# Contributing to Ecoma

Thank you for your interest in contributing to Ecoma! We welcome contributions from developers of all skill levels.

## Contribution Philosophy

All work in this project follows a small set of numbered working principles — correctness and evidence over speed, simplicity first, surgical changes, upstream-first conflict resolution. They are defined once, in [`CLAUDE.md`](./CLAUDE.md); this section intentionally does not restate them — read that file, it is the source of truth.

## Getting Started

### Prerequisites

Supported development platforms are **Linux, macOS, and native Windows** —
the Tauri desktop shell needs native Windows builds, so Windows is a
first-class local dev platform, not an emulated one.

- **Node.js** ≥ 22
- **pnpm** 10.32.1 or later
- **Git**
- **Go** and **Rust** (rustup stable with the `clippy` and `rustfmt`
  components) — required even before any Go/Rust project exists: dev-cli's
  scaffold-lib integration tests drive the real `go vet` and `cargo check` on
  every test run, and CI installs both unconditionally for the same reason.
  When `go.work` exists it pins the Go version (Go auto-fetches the exact
  pinned toolchain).
- **uv** — the entire Python story of this polyglot workspace: it installs
  the pinned Python itself, and `ruff`/`pyright`/`pytest` run through
  `uv run` from each project's dev dependency group. Baseline so a machine is
  ready the moment the first Python lib is scaffolded.
- **Chromium via Playwright** (`pnpm exec playwright install chromium`) — the
  `design-system-e2e` project's `e2e` target drives the built Storybook in a
  real browser. `core-ui`'s own Vitest suite is jsdom-only and needs none of
  this.

Additional toolchains keyed off workspace marker files at the repo root:

- **golangci-lint v2** (when `go.work` exists) for the Go lint targets.

`pnpm nx affected -t lint test typecheck build e2e` stays the single definition
of done regardless of language: every project's targets are hand-written
`nx:run-commands` in its `project.json`, and cross-project Go/Rust/Python
dependencies reach `nx affected` through the local `nx-polyglot-graph`
plugin. New libs of any language come from
`node shared/tools/dev-cli/src/main.mjs scaffold-lib <name> --subsystem shared --lang <ts|go|rust|python>`.

### Setup

```bash
# Clone the repository, then:
cd ecoma

# Verify the toolchain and set up the repo — installs dependencies, git hooks
# (lefthook), and the Playwright Chromium the tests need. Tools with official
# user-space installers are installed after a prompt; system runtimes (Git,
# Node.js, Go) are only reported with the exact install command, never sudo'd.
pnpm run setup

# Verify only, changing nothing:
pnpm run setup -- --check

# Start the design system's Storybook
pnpm nx run design-system:serve
```

Claude Code cloud sessions provision themselves with the same script: a
SessionStart hook (`.claude/hooks/session-start-remote.mjs`, registered in
`.claude/settings.json`) runs `setup.mjs --yes` in remote sandboxes only, so
there is exactly one setup path to maintain.

## Development Workflow

1. **Read [`CLAUDE.md`](./CLAUDE.md) first** — Product & Strategy and the numbered Working Principles record the decisions and constraints the project is built on.

2. **Create a branch** — Use descriptive names:

   ```bash
   git checkout -b feat/toast-stack-pause-on-hover
   git checkout -b fix/commit-scope-hook-crash
   ```

3. **Make changes** — Follow the codebase conventions in each directory. Commit messages use [Conventional Commits](https://www.conventionalcommits.org/), with two extra contracts enforced by the `commit-msg` hook and re-checked per commit in CI (PRs are rebase-merged, so every branch commit lands on `main` verbatim — keep branch history clean; `wip` commits fail CI):

   - **Scope is mandatory, one per commit.** Valid scopes: every Nx project name (`pnpm nx show projects`), every subsystem root that contains projects (`shared` today; a product domain root once one exists), and `workspace`.
   - **Scope ↔ path.** The scope must be the _narrowest_ one covering every path the commit touches: one project → that project's name; several owners inside one subsystem (including subsystem files like `shared/CLAUDE.md`) → the subsystem; anything spanning subsystems, or every path a workspace-root file, → `workspace`. `pnpm-lock.yaml` never counts. One exception keeps atomic cross-project commits honest: a touched project's own scope is also allowed when every other touched project transitively depends on it (per the Nx graph) — an API change in `core-ui` may adapt its consumers in the same commit as `fix(core-ui): …`. A commit that mixes workspace-root files (e.g. adding a dependency in root `package.json`) with project- or subsystem-owned paths has no honest scope and is rejected outright — split it into one commit scoped `workspace` for the root files and one per project/subsystem for the rest.
   - Messages git generates itself (merges, `Revert "…"`, `fixup!`) are ignored, matching commitlint's defaults.

   ```
   feat(core-ui): add drag handles for element resizing
   fix(core-ui): correct slider keyboard step
   docs(shared): clarify sandbox runner boundary
   chore(workspace): bump nx
   ```

4. **Run checks** — Before pushing:

   ```bash
   pnpm nx affected -t lint test typecheck build e2e
   ```

   This is the definition of done for a code change (`CLAUDE.md` > Workspace
   Execution), and the same five targets CI runs — skipping one locally only
   moves the red to the PR. CI splits them across two jobs (`e2e` on its own so
   the browser download never blocks the rest), but neither is what branch
   protection watches: the one required status check is **`ci-gate`**, which
   passes only when every other job succeeded. Name a job directly and it has to
   be re-pointed the moment that job grows a runner matrix.

   The same workflow also runs nightly on `main` (and on demand via
   `workflow_dispatch`), where it drops the diff selection and runs every
   target on every project. A PR only ever sees what `nx affected` can reach,
   so an undeclared dependency edge hides a real break from the change that
   caused it; the nightly run is where that surfaces.

5. **Open a Pull Request** — Reference the issue (if applicable) and describe:
   - What problem this solves
   - How you tested it
   - Any breaking changes

## Types of Contributions

### 🎨 Design & UX

- Design refinements (see [`Design System/Introduction`](./shared/libs/core-ui/docs/design/Introduction.mdx) for the design system)
- Component improvements
- Accessibility enhancements
- Submit a design review issue or discussion

### 🐛 Bug Fixes

- Reproduce the bug clearly
- Add a test that fails without your fix
- Ensure the fix passes all tests

### ✨ Features

- Open a discussion first if it's a major feature
- Add tests for new behavior
- Update documentation if user-facing

### 📚 Documentation

- Fix typos and clarify explanations
- Add examples
- Keep `CLAUDE.md`, nested `CLAUDE.md` files, and this guide in sync with the codebase

## Testing

All changes must pass:

```bash
# Run all tests and lint
pnpm nx affected -t lint test typecheck build e2e
```

Tests verify the behavior that matters, not just line coverage. Read more in the project philosophy (Rule 8, [`CLAUDE.md`](./CLAUDE.md)).

## Review Process

- Your PR will be reviewed by maintainers
- Changes may be requested
- Once approved, a maintainer will merge your PR
- Only the latest major version receives maintenance and security support (see [`SECURITY.md`](./SECURITY.md))

## Code of Conduct

This project adheres to the [Contributor Covenant](./CODE_OF_CONDUCT.md).
By participating, you are expected to uphold it.

## Security

Found a security vulnerability? **Do not** open a public issue. Please report it to **john.itvn@gmail.com**. See [`SECURITY.md`](./SECURITY.md) for details.

## Questions?

- **Decisions & Strategy:** [`CLAUDE.md`](./CLAUDE.md)
- **Design System:** [`Design System/Introduction`](./shared/libs/core-ui/docs/design/Introduction.mdx)

## Thank You

Contributors make Ecoma better. Thank you for helping! 🙏
