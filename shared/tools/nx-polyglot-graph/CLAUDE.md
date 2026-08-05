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
src/workspace.mjs      which projects and files a run covers, and their analysis
src/rules/             the boundary rules — `evaluate(sites, graph, config)`
src/report/            rendering violations as text and as SARIF
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
- **`src/workspace.mjs` is the only layer allowed to answer "which files".**
  An analyzer is handed one file and a rule is handed records, so the question
  lands here — with the two spawns that come with it. Projects and tags come
  from `nx graph --file=` (never a second walk of `project.json` files, which
  would disagree with Nx wherever a plugin contributes an edge); files come
  from `git ls-files`, because the graph JSON carries no file map and a tree
  walk would need ignore rules that drift from `.gitignore`. Both are
  injectable, which is what lets a test drive the whole pipeline with neither
  Nx nor git present.
- **`src/report/` renders, and decides nothing.** A formatter that filtered
  would be a rule wearing a formatter's name.

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

Two things that resolver structurally cannot answer, and what `typescript.mjs`
does instead of pretending. A **Node built-in** (`node:fs`, `fs`) has no
package to find, so it is classified by `node:module`'s own `isBuiltin` —
checked after TypeScript, never before, and never against a hand-kept list.
A **relative specifier TypeScript declines** because the extension is not one
it compiles (`.vue`, `.css`, `.svg`) is already a path: it is normalised and
tested for existence, with no extension probing, no `index` lookup and no
`paths` mapping. Anything beyond those two is the second resolver this project
must not grow — including an aliased asset (`@ecoma-io/ui/styles/global.css`),
which stays unresolved on purpose because resolving it would mean applying
`paths` here.

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
  built-ins, `typescript`, and `vue/compiler-sfc` only. Nothing enforces this
  today, which is exactly why it is written down: self-contained is what keeps
  a later extraction cheap. `vue/compiler-sfc` is reached through the root
  `vue` dependency's own public subpath — the `@vue/compiler-sfc` package is
  NOT declared at the root, so importing it by that name would be a phantom
  dependency that pnpm's strict layout does not resolve. It is also loaded
  lazily via `createRequire` rather than at module scope: this tool runs over
  trees with no Vue at all (the private control-plane workspace has none), and
  a top-level import would make a missing `vue` break Go, Rust and Python
  analysis in a workspace with no `.vue` file to analyze.
- **Never assume this repository's project names, areas, or tag values.** The
  tool also runs inside the private control-plane workspace through a pinned
  harness clone, over a different tree. Everything comes from the graph and
  from the config — which is why `loadBoundaryConfig` takes a workspace root
  rather than walking up from its own location.
- **One module/crate/package per project root** is the modeling assumption for
  `src/graph/`: identity is `<projectRoot>/go.mod` · `Cargo.toml [package]` ·
  `pyproject.toml [project]`. A nested second manifest inside one project
  yields no edge — split it into its own project instead. **`src/analysis/` is
  deliberately broader**, because it attributes a FILE rather than a manifest:
  a crate or module nested inside a project still belongs to the project whose
  directory contains it, and this workspace has one — `rba-desktop` keeps its
  crate in `src-tauri/`, the layout Tauri prescribes, so the graph draws no
  Rust edge for it while analysis reads its sources. The two disagreeing there
  is the documented modeling limit surfacing, not a bug in either.
- Known, pinned parse limits (see each analyzer's header + tests): Go block
  imports are read to the first `)` and commented-out imports inside a block
  still count; Rust reads `use` only at the start of a line and resolves a
  uniform path toward the crate, and a renamed `package = "…"` dependency is
  followed by the manifest resolver alone; Python matches per line, so a
  continued line or a triple-quoted string that looks like an import is
  misread. The worst case of every one is a spurious record naming text the
  file really contains — never a missed project.
- **Graph edges and source records answer different questions, and both stay.**
  A Python manifest edge follows uv semantics strictly — no
  `[tool.uv.sources]` entry, no edge, even when the name matches a sibling
  package — while `analyzePython` reads the `.py` sources, where an undeclared
  `import other_project.thing` imports fine at runtime and crosses the boundary
  anyway. Neither replaces the other; a declared-but-unused dependency and an
  undeclared-but-imported one are both findings.
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

- `analyzeFile` dispatches through two tables — extension → language, language
  → analyzer — and **throws** for a language the first table claims and the
  second does not, naming it. That is how the next language stays loud before
  its analyzer lands. An unrecognised extension is a no-op returning the empty
  envelope: the dispatcher is pointed at every tracked file, and `README.md`
  is not an error.
- `cli.mjs check` keeps four distinct exit codes, and the distinction that
  matters is **3** (the run could not complete — no workspace, malformed
  config, `nx graph` or `git` failed) against **1** (violations found) and
  **0** (clean). A checker that could not look must never be mistaken for one
  that looked and found nothing; **2** stays a usage error. Exit 0 was the bug.
  `check` also states what it inspected — imports, files, projects — beside
  every verdict, because "no violations" is a claim about coverage too.
- `lsp.mjs` advertises an **empty capability set**, so no editor asks it for
  diagnostics, and answers every other request with `MethodNotFound` (-32601).
  Advertising `textDocumentSync` and replying with an empty diagnostic array
  would paint every file green while no rule had run.

## Tests

- **An analyzer test that would pass against a hard-coded name→project map is
  not a test.** Resolution is driven over an in-memory workspace whose
  `readFile` backs a real fixture tree, so `ts.resolveModuleName` runs for
  real; `typescript.test.mjs` repoints a `tsconfig.base.json` alias without
  changing the specifier and requires the answer to move with it.
- **The Vue analyzer's positions carry two tiers, and it needs both.**
  `vue.test.mjs` mocks the TypeScript analyzer to pin the text handed over —
  the whole file with everything outside the script block blanked, so no
  arithmetic can be wrong. `vue.integration.test.mjs` drives the real pair and
  checks the line a reader finally sees, against positions computed from the
  fixture rather than written as literals. A diagnostic naming the wrong line
  is worse than none, so it is pinned from both sides.
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
  `cli.integration.test.mjs` therefore does both: it spawns the real binary for
  the exit-code and usage contract, and calls `check()`/`runCli()` in-process
  over a fixture Go workspace — real analyzer, real rules, real report, with
  only Nx and git injected — so the exact `file:line:column` a developer acts
  on is pinned rather than assumed.
- **A SARIF test that only checks the file parses is not a test.** The failure
  guarded against is an upload GitHub silently rejects, so
  `report/sarif.integration.test.mjs` builds one result per `messageId` from
  the real message table and asserts the fields a rejection turns on: a
  `ruleId` that resolves in the catalogue, a non-empty message, and a
  repository-relative `uri` with a 1-based `startLine`/`startColumn`.
