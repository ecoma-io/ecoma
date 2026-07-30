# onboard (`shared/tools/onboard`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`.
Nx project name `onboard` (tags `type:lib`, `scope:shared`). Plain-ESM
`.mjs`, no build/typecheck — the same pattern as `dev-cli` and
`eslint-local-rules`.

- **This is the sole onboarding entrypoint.** `src/setup.mjs` verifies the
  developer toolchain and sets up the repo (dependencies, git hooks via
  lefthook, Playwright Chromium). Contributors run it via `pnpm run setup`
  (root `package.json` → `nx run onboard:setup` → `node src/setup.mjs`);
  `pnpm nx run onboard:setup -- --check` verifies without changing anything.
- **`.claude/hooks/session-start-remote.mjs` imports `runSetup` from
  `src/setup.mjs` in-process** (a direct JS import, not a shell/Nx
  invocation) to provision Claude Code cloud sandboxes on session start.
  This is a footgun: moving or renaming `src/setup.mjs` again without
  updating that hook's import path silently breaks session bootstrap for
  every future cloud session — there is no test that would catch a stale
  import path in that hook, only the hook actually failing at runtime.
- **`repoRoot()` derives the repository root from `git rev-parse
--show-toplevel`, never from this file's own location.** This script has
  already moved once (repo root → here); a path derived from
  `import.meta.url` would silently resolve to the wrong directory after a
  move like that. Keep deriving it from git, matching `dev-cli`'s
  `check-journey-markers.mjs`.
- Tests (`src/setup.test.mjs`) run on Vitest (`vitest run` via the `test`
  target). They mock `node:child_process` (`spawnSync`) and `node:fs`
  wholesale — the same convention `dev-cli` uses for scripts with real
  side effects (see e.g. `check-project-conventions.test.mjs`,
  `run-e2e.test.mjs`) — and stub `process.chdir` so no test touches the
  real filesystem, installs a real toolchain, or leaves the test process
  in a different working directory. Real Playwright/git-hook installation
  is a deliberately untested boundary; only the `--check` verification path
  and the toolchain-presence branches are covered.
