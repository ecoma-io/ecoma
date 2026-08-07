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

The same gap has a second half. `@nx/enforce-module-boundaries` reads only
JavaScript and TypeScript, so in a Go or Rust project the `layer:`, `scope:`
and `license:` tags are a declaration with no mechanism behind them: a `.go`
file given an import that violates the layer axis shows the edge in the graph
and still passes `lint`. This project is where that mechanism is being built,
which is why it now carries an analysis layer and its own entry points
alongside the graph plugin.

<!-- readme:consumers -->

## Who consumes it

Nx itself. It is registered under `nx.json` → `plugins` as
`./shared/tools/nx-polyglot-graph/index.mjs` and runs wherever Nx builds its
own project graph — `nx affected`, `nx graph`, `nx run-many`. No product or
tooling code imports it directly.

It also declares two executables as `bin` entries in its own `package.json`:
`cli.mjs` for a terminal run and `lsp.mjs` for an editor. `cli.mjs check` is a
real checker and is wired as a gate — `lefthook.yml`'s pre-push list runs it
over the whole workspace, and `.github/workflows/ci.yml` runs it in a job of
its own that uploads its SARIF to GitHub code scanning.

### Running it in an editor

`lsp.mjs` speaks the Language Server Protocol over stdio and publishes one
diagnostic per boundary violation, carrying the same `messageId`
`@nx/enforce-module-boundaries` reports for that import. A file it could not
analyze gets a diagnostic saying exactly that — so an empty diagnostic list
from this server always means "no violation", never "not checked".

An editor rather than an ESLint plugin because an ESLint plugin only runs where
ESLint has a parser. In this workspace that is JS, TS **and Vue** — measured, a
`.vue` file importing a banned package draws the same
`@nx/enforce-module-boundaries` message from ESLint and from this tool,
differing only in the column each underlines. Go, Rust and Python have no parser
at all, and that is the half an ESLint plugin could never reach.

**Claude Code** loads it from this repository's own plugin catalogue, under
`.claude/plugins`. `.claude/settings.json` registers that directory and enables
the plugin, so there is nothing to add by hand. Both keys are read only after you
trust this folder — the trust prompt is the gate, not a missing config. Enabling
a plugin does not install it, so a first session prints the one command that
does:

```shell
claude plugin install nx-polyglot-graph@ecoma --scope project
```

After that a session gets boundary diagnostics on every edit to a Go, Rust,
Python or Vue file. The server entry is `lspServers` in that plugin's
`plugin.json`, and it claims every extension the analyzers handle except the
JS/TS family: an editor gives one server per file extension, so claiming those
would displace the language server a developer actually needs there. `.vue`
falls on the claimed side of that line and ESLint reads it too, which makes Vue
the one extension both enforcers cover.

**Any other LSP client** launches the same executable:

```text
command                node <workspace>/shared/tools/nx-polyglot-graph/lsp.mjs
transport              stdio
initializationOptions  { "workspaceRoot": "<workspace>" }
                       — only when the editor's root is not the workspace root
watched files          **/module-boundaries.config.mjs and **/project.json
```

The workspace root is taken from `initializationOptions`, then
`workspaceFolders`, then `rootUri`, then `rootPath`, then the working
directory. Only full text synchronisation is advertised. A client that
supports dynamic registration is asked to watch the two files above, so a
constraint change re-diagnoses every open file. One that cannot is told so on
stderr, and then only sees a constraint change when that file is saved through
the editor itself — never when it changes beside it.

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

It also does not restate the boundary rules. The constraint table lives once
at the workspace root in `module-boundaries.config.mjs`, which ESLint reads
too; `src/config.mjs` is the only thing here that loads it. And nothing here
assumes this repository's project names, areas, or tag values — the tool has
to run over the private control-plane workspace as well, so everything comes
from the graph and that config.

<!-- readme:status -->

## Status

The graph half is active and load-bearing: it is the only source of
Go/Rust/Python cross-project edges in the workspace graph, covered by a unit
test per resolver plus an integration test that drives the real Nx entry point
over a tmpdir fixture.

The analysis half is real. `src/analysis/` reads TypeScript, JavaScript, Vue,
Go, Rust and Python sources into resolved import records — which import was
written, on which line and column, in which form, and what it points at —
against the record shape frozen in `src/analysis/contract.md`. TypeScript
resolution is TypeScript's own `ts.resolveModuleName` and Vue's `<script>`
extraction is Vue's own SFC parser; neither is reimplemented here.

Both halves run. `src/rules/` reproduces all fifteen
`@nx/enforce-module-boundaries` violation types under its eight options, over
analysis records rather than an ESLint AST. `cli.mjs check` reads the Nx graph,
analyzes every tracked source file a project owns, and exits 1 on any
violation, with a `file:line:column` report or SARIF 2.1.0. `lsp.mjs` serves
the same engine to an editor, publishing a diagnostic per violation — or a
diagnostic saying it could not look, never an empty list it did not earn.

Both enforcers run side by side on purpose. ESLint stays authoritative for
JavaScript, TypeScript and Vue; this tool covers Go, Rust and Python, which
ESLint cannot read at all. `src/conformance/` measures where the two agree and
where they do not, and it is what a decision to retire either one would rest
on. Mechanics, per-language parse limits, and the one-manifest-per-project
modeling assumption are in [`./CLAUDE.md`](./CLAUDE.md).
