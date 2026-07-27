---
name: eslint-local-rules
subsystem: shared
lang: en
description: Repo-specific ESLint rules that enforce this workspace's own doctrine, not generic syntax.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# eslint-local-rules

<!-- readme:why -->

Off-the-shelf ESLint plugins check syntax and common patterns, but they have
no notion of this repo's own doctrine. They cannot know that `v2`/`wip`/
`phase-3` are banned journey markers (Rule 13), that a unit test
(`*.test.ts`) must `vi.mock` every internal collaborator it imports, that a
committed `.only`/`.skip` is a violation, or that every `project.json` must
declare exactly one `type:*` and one `scope:*` tag. Each rule here plugs
directly into the AST to enforce one such repo-specific invariant, under the
`local/` plugin namespace: `no-journey-markers`, `no-journey-marker-names`,
`no-focused-or-skipped-tests`, `no-unmocked-internal-imports`, and
`require-project-tags`. `test-call-chain.mjs` is not a rule — it is a shared
resolver that lets `no-journey-markers` and `no-focused-or-skipped-tests`
recognize the same test-chain shapes (`it.each(...)`, `it.only.each(...)`, …).

<!-- readme:consumers -->

Every rule module is wired into the root `eslint.config.mjs` under the
`local/` plugin namespace, so it runs as an ordinary ESLint rule through each
project's own `lint` target — transitively, every project in the workspace is
a consumer. There is no separate invocation path: `pnpm nx affected -t lint`
/ `pnpm nx run-many -t lint` runs it, lefthook's pre-commit hook runs it on
staged files, and CI runs it across the whole tree.

<!-- readme:ecosystem -->

This project is the AST half of enforcing Rule 13 (journey markers); the
other half is `dev-cli`'s `check-journey-markers`, which scans what ESLint
never touches — non-JS/TS/Vue file contents, file/directory names, and Nx
target names. Both read the same pattern source, `journey-markers.config.json`
at the repo root, so a pattern change is a single edit. It sits as a peer to
`dev-cli` and `repo-care` inside `shared/tools` — tooling that the rest of
the workspace depends on, but that depends on no product domain itself.

<!-- readme:boundary -->

This is not a place to reconfigure standard ESLint rules — that belongs in
the root `eslint.config.mjs`. Every rule module here is dependency-free by
design, and so are its tests: they are plain `node` scripts (`<name>.test.mjs`),
not Vitest, run directly by the `test` target's explicit command list. There
is no build or typecheck step for this project.

<!-- readme:status -->

All five rules are enabled for real in the root `eslint.config.mjs` — none
were written and left unwired. See [`./CLAUDE.md`](./CLAUDE.md) for the
mechanics of adding a new rule and other footguns.
