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

You will notice a `cloud/` directory (see `.gitmodules`): it is a private git
submodule pointing at a proprietary control-plane repository. Without access
to that repository it just stays an empty directory, which is expected —
nothing in this public workspace depends on `cloud/` existing, so there is
nothing to configure or troubleshoot.

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

Claude Code cloud sessions provision themselves with the same script
(`shared/tools/onboard/src/setup.mjs`): a SessionStart hook
(`.claude/hooks/session-start-remote.mjs`, registered in
`.claude/settings.json`) imports its `runSetup` export and calls it with
`--yes` in remote sandboxes only, so there is exactly one setup path to
maintain.

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

   Commit with `-s` so each commit carries a `Signed-off-by` trailer — see
   [License & contributor agreement](#license--contributor-agreement) below.

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

   One state `ci-gate` cannot report on is a conflict. A pull request that no
   longer merges into its base has no merge commit for GitHub to build, and
   without one the `pull_request` event never fires — so `ci.yml` never starts
   and `ci-gate` sits at _"Expected — Waiting for status to be reported"_ for as
   long as the conflict lasts. It reads as a hung CI and is not one. The
   `mergeable` check (`.github/workflows/pr-mergeable.yml`) exists to say so out
   loud: it runs on `pull_request_target`, which needs no merge commit, and goes
   red naming the conflicting files. It is deliberately **not** a required
   check — GitHub already refuses to merge a conflicting pull request, so
   gating on it would add nothing, and explaining the silence is its whole job.
   Merge `main` into the branch, resolve, push; CI starts on its own once the
   merge commit can be built again.

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

## License & contributor agreement

Ecoma is **fair-code**: source-available, not open source, and not closed
either. Which terms apply to a file is decided by where the file lives, and
[`LICENSE`](./LICENSE) is the source of truth for that mapping — the
Sustainable Use License for the implementations, Apache 2.0 for the
`packages` directories third parties build against, a commercial Enterprise
License for `enterprise` directories, proprietary for the operator control
plane. Every `.md` file under `shared/libs/doctrine/` is licensed separately,
under [CC BY-SA 4.0](./shared/libs/doctrine/LICENSE.docs) — the boundary is the
file extension, not the word "prose", because a category is not something a
reader or a compliance tool can evaluate.

The build checks that declaration, so you do not have to memorise it: each
project declares a `license:*` tag, and `check-project-conventions` fails when
a tag disagrees with its directory. That is a lint over what the tree declares,
not a legal control — `LICENSE` is what governs.

Because the project offers its code under more than one set of terms, we need
the right to do that for your contribution too. That is what
[`CLA.md`](./CLA.md) grants — a licence, not ownership; you keep the copyright
in your work. You agree once, on your first pull request, by committing a
contributor record at `contributors/<your-github-handle>.md`; a maintainer
confirms it before merging, and nothing is granted until that record exists.
`check-contributor-record` holds that rule in CI: it audits every record
against the template `CLA.md` publishes, and fails a pull request whose author
has none.
The record carries your name and address because the law governing the
agreement requires a licence contract to identify both parties.

Sign off each commit with `git commit -s`: that trailer is the
[Developer Certificate of Origin](https://developercertificate.org/), which is
a separate thing from the CLA and deliberately kept separate — it is what you
type reflexively everywhere else, so it must not double as assent to a
commercial sublicensing grant.

`LICENSE` grants no rights in the name "Ecoma" — no source-available licence
does. A published trademark policy will follow registration; until then, ask if
you want to use the name for anything beyond describing a true relationship
with the project.

## Review Process

Ecoma currently has exactly one maintainer, so review turnaround depends on
their availability — expect it to take longer than a project with a larger
review team, especially for non-trivial changes. This is a deliberate model,
not a gap: [`shared/libs/doctrine/method/review-rubric.md`](./shared/libs/doctrine/method/review-rubric.md)
names the maintainer's own review as the single most effective error-catching
channel by design (its "Kênh owner" section). If your PR sits without a
response for a while, a friendly ping is welcome.

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
- **Licensing & the CLA:** [`LICENSE`](./LICENSE), [`CLA.md`](./CLA.md)

## Thank You

Contributors make Ecoma better. Thank you for helping! 🙏
