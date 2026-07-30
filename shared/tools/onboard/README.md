---
name: onboard
subsystem: shared
lang: en
description: Sole onboarding entrypoint — verifies the developer toolchain and sets up the repo (dependencies, git hooks, Playwright Chromium).
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# onboard

The one script every contributor and every Claude Code cloud session runs to
go from a fresh clone to a working, definition-of-done-capable checkout.

<!-- readme:why -->

## Why this exists

A polyglot workspace (TypeScript/Go/Rust/Python) has a lot of toolchain to
get right before `pnpm nx affected -t lint test typecheck build e2e` can pass
locally: the right Node/pnpm versions, Go, Rust with `clippy`/`rustfmt`,
`uv`, `golangci-lint` once a Go project exists, the git hooks that enforce
commit conventions, and the Playwright Chromium the e2e suite drives.
`src/setup.mjs` is the single script that checks all of it against the
version pins the repo itself already owns (`package.json` `engines`/
`packageManager`, `go.work`), offers to install what has an official
user-space installer, and never silently skips a step. `runSetup(argv)` is
exported specifically so it can run in-process as well as from the CLI —
there is exactly one onboarding path, run two different ways.

<!-- readme:consumers -->

## Who consumes it

- **Contributors**: `pnpm run setup`, or `pnpm run setup -- --check` to
  verify without changing anything. The root `package.json` `setup` script
  chains `nx run onboard:setup` to `node src/setup.mjs`. Documented in full
  in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
- **Claude Code cloud sessions**: the SessionStart hook
  (`.claude/hooks/session-start-remote.mjs`, registered in
  `.claude/settings.json`) imports `runSetup` from `src/setup.mjs`
  **in-process** and calls it with `--yes`, so a fresh sandbox is
  provisioned before the session starts doing anything else.

<!-- readme:ecosystem -->

## Where it sits

`onboard` is a `shared/tools` peer of [`dev-cli`](../dev-cli/README.md) and
[`eslint-local-rules`](../eslint-local-rules/README.md), built the same way
(plain-ESM `.mjs`, no build/typecheck), but it is not a doc/convention gate —
it is the workspace's one setup script, carved out on its own so it can carry
real test coverage and a target of its own (`nx run onboard:setup`) instead
of living as an untracked file at the repo root.

<!-- readme:boundary -->

## What it deliberately does not do

Never installs a system runtime (Git, Node.js, Go) itself, and never invokes
`sudo` or an elevated prompt — for those it only prints the exact install
command for the detected platform. Only installs a missing tool that has an
official user-space installer (pnpm, rustup, uv, golangci-lint), and only
after a prompt unless `--yes` is passed. Not a general-purpose provisioning
framework — one script, one repo, one set of pins.

<!-- readme:status -->

## Status

Actively running as the real onboarding path for both local contributors and
cloud sessions, not a draft. Mechanics, invariants, and the SessionStart-hook
footgun live in [`CLAUDE.md`](./CLAUDE.md) next to this file.
