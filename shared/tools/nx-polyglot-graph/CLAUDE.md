# nx-polyglot-graph (`shared/tools/nx-polyglot-graph`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`.
Nx project name `nx-polyglot-graph` (tags `type:lib`, `scope:shared`).
Plain-ESM `.mjs`, no build/typecheck; loaded by Nx itself via
`nx.json → plugins`, never imported by product code.

- **Edges only, never nodes or targets.** This plugin exists so `nx affected`
  sees dependencies between Go/Rust/Python projects. Projects are still
  declared by hand-written `project.json` (root `CLAUDE.md` → Workspace
  Execution), and targets are never inferred — resist upstreaming the
  inferred-target model from gonx/@nxlv/python; rejecting it is this
  plugin's reason to exist.
- **Static analysis by design.** Resolvers read tracked files only (regex
  over gofmt-canonical Go imports; smol-toml for Cargo/pyproject manifests),
  so the graph computes on machines without the language toolchains — CI's
  doc-gate steps and TS-only contributors never need Go/cargo/uv installed.
  Do not shell out to `go list`/`cargo metadata`/`uv` here; the moment a
  resolver needs the real toolchain, graph computation starts failing on
  machines that never touch that language.
- **One module/crate/package per project root** is the modeling assumption:
  identity is `<projectRoot>/go.mod` · `Cargo.toml [package]` ·
  `pyproject.toml [project]`. A nested second manifest inside one project is
  not resolved — split it into its own project instead.
- Known, pinned parse limits (see each resolver's header + tests): Go block
  imports are read to the first `)` and commented-out imports inside a block
  still count (worst case: a spurious edge, never a missed one); Python
  edges follow uv semantics strictly — no `[tool.uv.sources]` entry, no
  edge, even when the name matches a sibling package.
- External packages (crates.io, PyPI, Go module proxy) are deliberately NOT
  added as `externalNodes` — only project↔project edges matter to
  `nx affected`, and external-node bookkeeping is where the community
  plugins grow their complexity.
- The resolver contract is shared and injectable:
  `resolve(projects, filesOf, readFile)`. Unit tests inject in-memory files;
  `create-dependencies.integration.test.mjs` drives the real entry point
  over a tmpdir fixture with the Nx context shape. When Nx changes that
  shape (watch `CreateDependenciesContext` in nx's `public-api.d.ts` on
  upgrades), the integration test is the tripwire.
