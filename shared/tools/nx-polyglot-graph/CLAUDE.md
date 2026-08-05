# nx-polyglot-graph (`shared/tools/nx-polyglot-graph`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`.
Nx project name `nx-polyglot-graph` (tags `type:lib`, `scope:shared`,
`license:sul`). Plain-ESM `.mjs`, no build/typecheck; the plugin half is
loaded by Nx itself via `nx.json → plugins`, never imported by product code.

## What this project is for

Two halves of one gap, and the second is why the layering below exists.

- **Edges.** `nx affected` sees a dependency only as a graph edge, and Nx
  infers none for Go, Rust, or Python. `src/graph/` supplies them.
- **Enforcement.** `@nx/enforce-module-boundaries` reads only JS and TS, so a
  Go project's `layer:`/`scope:`/`license:` tags match no mechanism at all —
  measured: a `.go` file given an import that violates the layer axis showed
  the edge in the graph and its project's `lint` target exited 0, because that
  target runs `eslint project.json` and eslint answers "File ignored because no
  matching configuration was supplied" for `.go`. `src/analysis/` + `src/rules/`
  are where that becomes a real check.

## Layout, and what each layer may know

```
index.mjs              Nx plugin entry — re-export only, nothing else
cli.mjs, lsp.mjs       executables (bin entries in package.json)
src/analysis/          which import is written where, and what it resolves to
src/graph/             analysis reduced to Nx dependency records
src/config.mjs         loads + validates the workspace boundary config
src/rules/             the boundary rules — `evaluate(sites, graph, config)`
src/report/            rendering violations (empty — see its README)
```

- **`index.mjs` holds no logic.** Nx loads it on every graph computation, so
  what it imports is what every `nx` invocation pays for. Keep it a re-export.
- **`src/analysis/` never judges.** It reports import sites; whether an import
  is allowed is `src/rules/`' question. An analyzer that filters its own output
  has taken a decision away from the layer that owns it.
- **`src/graph/` is a lossy view of analysis, on purpose.** An Nx edge is
  `{ source, target, sourceFile, type }` and Nx drops anything else, so the two
  layers stay separate rather than one growing fields the other discards.
- **`src/rules/` reads records, never files.** It gets analysis output and the
  loaded config, nothing more. Its own README carries the three upstream
  semantics a reimplementation gets backwards, and every place it is
  deliberately stricter than ESLint — read it before touching a rule.

## The analysis contract is frozen — read it before writing an analyzer

`src/analysis/contract.md` fixes the record every language analyzer returns,
and `src/analysis/analyze.mjs` carries the same thing as JSDoc types. They are
edited together. Analyzers for different languages are meant to be written in
parallel, and that only works if none of them gets to reinterpret the shape.

The four decisions most likely to be re-litigated, each settled there with its
reason: the record is a **superset of a graph edge** (five of the fifteen rule
violations are decided on the raw specifier, which `nx graph --file=` does not
emit — 0 of 12 edges carried provenance when measured); an **intra-project
relative import is still emitted**; an analyzer **never throws on a malformed
file**, it records the failure; a **dynamic import with a non-literal argument
resolves to `null`** and is reported unresolvable rather than dropped.

TypeScript resolution is `ts.resolveModuleName` — a public API, already a root
dependency, already correct on this workspace. Call it; never reimplement path
mapping or extension probing.

## Standing constraints

- **Static analysis by design.** Resolvers read tracked files only (regex over
  gofmt-canonical Go imports, `smol-toml` for Cargo/pyproject manifests), so
  the graph computes on machines without the language toolchains — CI's
  doc-gate steps and TS-only contributors never need Go/cargo/uv installed. Do
  not shell out to `go list`/`cargo metadata`/`uv` here; the moment a resolver
  needs the real toolchain, graph computation starts failing on machines that
  never touch that language.
- **Edges only, never nodes or targets.** Projects are still declared by
  hand-written `project.json` (root `CLAUDE.md` → Workspace Execution), and
  targets are never inferred — resist upstreaming the inferred-target model
  from gonx/@nxlv/python; rejecting it is this plugin's reason to exist.
- **No workspace project may be imported from here, `dev-cli` included.** Node
  built-ins and `typescript` only. Nothing enforces this today, which is
  exactly why it is written down: self-contained is what keeps a later
  extraction cheap.
- **Never assume this repository's project names, areas, or tag values.** The
  tool also runs inside the private control-plane workspace through a pinned
  harness clone, over a different tree. Everything comes from the graph and
  from the config — which is why `loadBoundaryConfig` takes a workspace root
  rather than walking up from its own location.
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

## The boundary rules live at the workspace root

`module-boundaries.config.mjs` there is the single home of the constraint
table and the eight `@nx/enforce-module-boundaries` options; ESLint imports it
and so does `src/config.mjs`. Nothing here restates a constraint, and nothing
here defaults an option — a default would be a second copy of a value that
file already states, and the two would disagree the day one changed.

`src/config.mjs` validates shape only. Whether `layer:adapter` may reach
`layer:domain` is the workspace's decision, argued in that config's comments.

## What is a stub, and how each one says so

Nothing that cannot enforce reports success (root `CLAUDE.md` — scaffold
openly, never fake done). Concretely:

- `analyzeFile` **throws** for any extension it recognises, naming the missing
  language. An unrecognised extension is a no-op returning the empty envelope —
  the dispatcher is pointed at every tracked file, and `README.md` is not an
  error.
- `cli.mjs check` exits **3** (`not implemented`), distinct from **2**
  (usage) and the reserved **1** (violations found). Exit 0 was the bug.
- `lsp.mjs` advertises an **empty capability set**, so no editor asks it for
  diagnostics, and answers every other request with `MethodNotFound` (-32601).
  Advertising `textDocumentSync` and replying with an empty diagnostic array
  would paint every file green while no rule had run.

## Tests

- The resolver contract is shared and injectable:
  `resolve(projects, filesOf, readFile)`. Unit tests inject in-memory files;
  `src/graph/create-dependencies.integration.test.mjs` drives the real entry
  point over a tmpdir fixture with the Nx context shape. When Nx changes that
  shape (watch `CreateDependenciesContext` in nx's `public-api.d.ts` on
  upgrades), the integration test is the tripwire. It reaches through
  `index.mjs` deliberately — an entry that stopped re-exporting
  `createDependencies` would drop every polyglot edge while a test pointed at
  the implementation stayed green.
- `src/config.integration.test.mjs` loads the **real** root config, so a
  malformed constraint row fails here rather than as a rule that silently
  matches nothing.
- `cli.mjs` and `lsp.mjs` are driven as spawned subprocesses, which in-process
  V8 coverage cannot see — hence their absence from `vitest.config.mjs`'s
  coverage `include`, the same exclusion `dev-cli` makes for its `main.mjs`.
