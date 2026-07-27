---
name: nx-polyglot-graph
subsystem: shared
lang: en
description: Local Nx graph plugin that adds Go/Rust/Python cross-project edges by reading manifests statically.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# nx-polyglot-graph

<!-- readme:why -->

## Why it exists

`pnpm nx affected` only knows about a dependency if it shows up as an edge in
the Nx project graph, and Nx's own graph inference has no notion of a Go
import, a Cargo path dependency, or a `[tool.uv.sources]` entry. Without this
plugin, changing a Go library would never mark a sibling Go project affected,
silently defeating `pnpm nx affected -t lint test typecheck build e2e` for every
polyglot project in the workspace. Community plugins for this problem (gonx,
`@nxlv/python`) solve it by also inferring targets from the toolchain — but
this repo deliberately keeps targets hand-written in each `project.json`
(root `CLAUDE.md` → Workspace Execution), so `nx.json` `targetDefaults` and
each project's own polyglot `nx:run-commands` stay the single source of
truth for what a target does. This plugin exists to add the missing edges
only, without smuggling target inference back in.

<!-- readme:consumers -->

## Who consumes it

Nx itself. It is registered under `nx.json` → `plugins` as
`./shared/tools/nx-polyglot-graph/index.mjs` and runs wherever Nx builds its
own project graph — `nx affected`, `nx graph`, `nx run-many`. No product or
tooling code imports it directly; it has no other consumer.

<!-- readme:ecosystem -->

## Where it sits

It is a peer to `dev-cli`, `eslint-local-rules`, and `repo-care` under
`shared/tools` — workspace tooling, not a runtime dependency of any product.
It complements rather than replaces each polyglot project's hand-written
`project.json`: those declare the project and its `build`/`test`/`lint`
targets (Go/Rust/Python via `nx:run-commands` over `go`/`cargo`/`uv`), while
this plugin only adds the edges between them so `nx affected` can see across
language boundaries.

<!-- readme:boundary -->

## What it deliberately does not do

It never creates project nodes and never infers or attaches targets — nodes
and targets stay entirely hand-written in each project's `project.json`.
Resolvers never shell out to `go`, `cargo`, or `uv`; they read only tracked
manifest and source files (regex over gofmt-canonical Go imports, `smol-toml`
for `Cargo.toml`/`pyproject.toml`), so the graph computes on machines that
have never installed those toolchains, including CI's doc-gate steps and
TS-only contributors. It also never records external packages (crates.io,
PyPI, the Go module proxy) as `externalNodes` — only project-to-project
edges matter to `nx affected`.

<!-- readme:status -->

## Status

Active and load-bearing: it is the only source of Go/Rust/Python
cross-project edges in the workspace graph, covered by a unit test per
resolver plus an integration test that drives the real Nx entry point over a
tmpdir fixture. Mechanics, parse limits, and the one-manifest-per-project
modeling assumption are in [`./CLAUDE.md`](./CLAUDE.md).
