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
- **`repoRoot()` derives the repository root from `git rev-parse --show-toplevel`,**
  never from this file's own location. This script has already moved once
  (repo root → here); a path derived from `import.meta.url` would silently
  resolve to the wrong directory after a move like that. Keep deriving it
  from git, matching `dev-cli`'s `check-journey-markers.mjs`.
- Tests (`src/setup.test.mjs`) run on Vitest (`vitest run` via the `test`
  target). They mock `node:child_process` (`spawnSync`) and `node:fs`
  wholesale — the same convention `dev-cli` uses for scripts with real
  side effects (see e.g. `check-project-conventions.test.mjs`,
  `run-e2e.test.mjs`) — and stub `process.chdir` so no test touches the
  real filesystem, installs a real toolchain, or leaves the test process
  in a different working directory. Every installer branch is exercised
  against those mocks, so an assertion that an installer _ran_ is not
  enough: the fixture's `onSpawn` hook makes a tool appear only when its
  install command is spawned, which is what separates "the installer was
  invoked" from "the installer worked" — two outcomes `setup.mjs` reports
  differently, and the second is the one a contributor feels.
- **The `test` target declares its own `inputs`, and that list is the only
  thing standing between a repo-root edit and a replayed cached green.**
  `src/node-version-pin.integration.test.mjs` reads the real `.node-version`
  and the real root `package.json`; neither is inside `{projectRoot}`, so
  under the default inputs Nx hashed neither and served the cached pass over
  a `.node-version` that no longer satisfied `engines.node` — measured, not
  reasoned. Any further test here that reads a repo-root file must add it to
  that list in the same pass. Two mechanics make the list easy to break:
  a project-level `inputs` **replaces** `nx.json`'s `targetDefaults.test.inputs`
  rather than merging with it (also measured), which is why `default` and
  `coverageConfig` are repeated here; and a root file the suite only reads
  through a mock belongs nowhere near it — `.golangci-lint-version` is read by
  `setup.mjs` in production and by no test, so declaring it would only
  invalidate this cache for nothing.
- **`WIN32` and the ANSI colour constants are computed once at module load,
  while `process.platform` is read again at call time elsewhere** (the
  platform guard, the Linux/macOS branches, the Playwright hint). Stubbing
  `process.platform` without reloading the module therefore produces an
  impossible hybrid — the call-time reads report Windows while the six
  `WIN32`-gated branches still hold the host platform, so the run says
  `ok Windows` and still prints Linux install hints. `loadSetup()` in
  `setup.test.mjs` exists for exactly this: stub the property, then
  `vi.resetModules()` and re-import, so those constants are recomputed. Any
  new platform- or TTY-dependent test must go through it, or it pins nothing.
