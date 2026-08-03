# onboard (`shared/tools/onboard`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`.
Nx project name `onboard` (tags `type:lib`, `scope:shared`). Plain-ESM
`.mjs`, no build/typecheck — the same pattern as `dev-cli` and
`eslint-local-rules`.

- **Two halves under one project.** `src/setup.mjs` handles developer
  toolchain setup (the existing role). The new `src/doctrine-reader.mjs`,
  `src/nx-reader.mjs`, `src/git-reader.mjs`, and `src/report-builder.mjs`
  are deterministic data-gathering scripts used by the `.claude/skills/onboard`
  skill — they output JSON to stdout, never mutate the filesystem.
- **`src/doctrine-reader.mjs` reads `shared/libs/doctrine/`** — the published
  doctrine tree. It extracts end-state architecture (north stars, system shape,
  principles, invariants, primitives, layers), roadmap milestones, and known
  gaps. Pure function of files on disk.
- **`src/nx-reader.mjs` reads the live Nx graph** via `pnpm nx graph --file`,
  falling back to parsing `project.json` files directly if `nx` is unavailable.
  Outputs nodes grouped by scope/type/layer tags, plus dependency edges.
- **`src/git-reader.mjs` reads git log** with temporal LOD. Accepts
  `--window=<day|week|month|since=<expr>>`. Outputs three bands: all-time
  (compressed), context (medium), focus (detailed).
- **`src/report-builder.mjs` orchestrates the three readers** above and
  assembles a unified onboarding report JSON. The skill calls this to get
  all data in one pass.
- **The scripts are all deterministic — Rule 5 pure extraction.** The model's
  only creative work happens in the skill itself: reading doctrine prose for
  narrative, reading CLAUDE.md for reserved seams, and rendering the final
  output (prose summary or HTML artifact).
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
- **Name an installer through `INSTALL_COMMANDS`, never by a substring of
  its URL.** `setup.mjs` exports that table so a test matches whole commands
  — the `onSpawn` key and `spawnedCommands()` share one string shape — rather
  than restating a command that is then free to drift from the one actually
  spawned. Substring-matching a host is both what CodeQL's
  `js/incomplete-url-substring-sanitization` rule rejects and genuinely
  imprecise here: `rustup.rs` sits inside `sh.rustup.rs`, `win.rustup.rs` and
  the `https://rustup.rs` hint alike, so it cannot tell the POSIX installer
  from the Windows one — and a negative assertion that matches the wrong
  thing, or nothing, passes without proving anything.
- **golangci-lint is the one installer that builds from source, and both
  halves of its command are derived from pins rather than written down.** The
  module path takes its `/vN` suffix from the major of `.golangci-lint-version`
  (Go's semantic import versioning), so a hardcoded path means v1 forever and
  every v2+ pin fails to resolve at all. `GOTOOLCHAIN` takes go.work's own `go`
  directive as a floor (`go<pin>+auto`), because `go install pkg@version`
  deliberately ignores the surrounding workspace and would otherwise build with
  whatever minimum golangci-lint's own go.mod names — and a golangci-lint built
  by a Go older than the checked code targets refuses to load the config at
  runtime. That runtime refusal is also why the readiness check compares the
  binary's reported build Go against go.work, not just its version against the
  pin: a version-only check calls a machine ready whose every Go lint target
  fails, which is how a sandbox carrying an older prebuilt binary reported
  green. **CI never exercises this path** — `ci.yml` installs the official
  release binary through `golangci-lint-action`, so the `go install` branch is
  covered by `setup.test.mjs` alone; changing it means proving it by hand.
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
