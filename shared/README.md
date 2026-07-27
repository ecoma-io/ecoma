---
name: shared
lang: en
description: Shared libraries (design system, desktop-shell webview plumbing), workspace-owned app shells (design-system Storybook and its e2e gate), and workspace tooling (dev-cli, ESLint rules, repo-care)
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# Shared

The substrate every product in the workspace stands on. This is the only
directory tree in the repo importable from every scope, which is exactly why
the bar to add something to `shared/` is high: something belongs here only
once more than one product genuinely needs it, not because it merely _looks_
generic. A lib proposed here with only one real consumer is a claim under
review, not a settled fact — a few libs below say so plainly.

`shared/libs` may never import a product domain, and domains are always
independent of each other; both constraints are enforced by Nx
(`@nx/enforce-module-boundaries`, via tags in each `project.json`). The
mechanics of that boundary and the tooling registry live in
[`shared/CLAUDE.md`](./CLAUDE.md) — this file is the map for a human reader,
that one is the machine-checked contract.

## Three sub-trees

**[`shared/apps`](./apps)** — workspace-owned app shells that serve shared
infrastructure rather than any one product. They exist because an artifact
with its own build and deploy lifecycle cannot live in a buildless lib:

| App                                                       | What it is                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| [`design-system`](./apps/design-system/README.md)         | The Storybook host that renders `core-ui`'s stories and design docs. |
| [`design-system-e2e`](./apps/design-system-e2e/README.md) | The blocking Playwright gate over that Storybook's built output.     |

**[`shared/libs`](./libs)** — runtime code shared across products, consumed by
other shells and libs at build time:

| Lib                                         | What it is                                                            |
| ------------------------------------------- | --------------------------------------------------------------------- |
| [`core-tauri`](./libs/core-tauri/README.md) | Shared Tauri webview plumbing (window chrome) for the desktop shells. |
| [`core-ui`](./libs/core-ui/README.md)       | Alloy — the design system every product UI composes from.             |

**[`shared/tools`](./tools)** — a workshop, not a product. These tools never
ship inside any app; they exist so that rules which would otherwise erode into
prose stay machine-enforced instead: [`dev-cli`](./tools/dev-cli/) (local dev
commands, some of them CI gates), [`eslint-local-rules`](./tools/eslint-local-rules/)
(local ESLint rules machine-enforcing the parts of doctrine no off-the-shelf
rule covers), [`repo-care`](./tools/repo-care/) (repository-surface
automation — issue triage, advisory PR doctrine review — run from GitHub
Actions).

## Reading order

Start from the repo root [`CLAUDE.md`](../CLAUDE.md) to get the doctrine
(Rules 1–13) everything below must follow. Each entry above points to its
subproject's README for the "why", and to its `CLAUDE.md` for the mechanics —
the two kinds of document are kept separate on purpose, neither repeats the
other's content.
