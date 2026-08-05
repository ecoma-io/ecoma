# `src/conformance/` — the differential against ESLint

[`src/rules/`](../rules/README.md) reimplements the fifteen violation types and
eight options of `@nx/enforce-module-boundaries` by reading upstream's source.
Reimplementations diverge, and they diverge silently. This directory is the only
thing in the repository that puts the two verdicts side by side.

The dangerous direction is the **false negative**: this tool reporting clean
where ESLint would have caught something. That is worse than the state it
replaces. Today ESLint is right about JavaScript and TypeScript and silent about
Go, Rust and Python — and silence you know about beats a green light you cannot
trust.

**39 fixture workspaces, 77 probes, 78 projects.** Every one of upstream's
fifteen message ids is triggered by at least one probe, and 43 of the 77 probes
are near-misses that must report nothing.

## How it runs

`conformance.integration.test.mjs` materialises every case into one throwaway
workspace under the OS temp dir, then runs both engines over the same files, the
same graph object and the same option values:

- **upstream** — the real rule, through ESLint's programmatic API, with the real
  `@nx/eslint-plugin` out of `node_modules`;
- **this tool** — the real `src/analysis/` analyzers feeding the real
  `evaluate(sites, graph, config)`.

Nothing is stubbed on either side. The eight option values and the fifteen
message ids come off the installed rule's own `defaultOptions` and
`meta.messages`, so a case states only what it overrides and an Nx upgrade moves
both engines' input at once.

```
pnpm nx test nx-polyglot-graph
```

Fixtures exist only while the suite runs, which is what keeps them out of the
workspace's own lint, typecheck and build — the same containment
`src/graph/create-dependencies.integration.test.mjs` uses.

### Two mechanics worth knowing before changing anything here

**One workspace root per process.** `@nx/devkit` resolves its workspace root
once, on first load, and never again. So every case lives in a directory under
one root, import aliases and fake package names are workspace-wide and must be
globally unique, and `createFixtureRoot()` has to run before anything imports
nx. `assertNxRootIsFixture` fails loudly if that ordering ever breaks — without
it, upstream would read this repository's files while judging fixture paths and
every result would be an artefact of that.

**Same site, not same column.** ESLint reports the whole statement; this engine
reports the specifier, because that is what an editor should underline. A pair
matches when this engine's position falls inside the range ESLint reported.
Requiring equal columns would mark every pair as a disagreement about nothing;
requiring only the same file would let a diagnostic pointing at the wrong
statement pass as agreement.

## The differential table

| messageId                                    | agree | stricter | weaker | verdict          |
| -------------------------------------------- | ----: | -------: | -----: | ---------------- |
| `noRelativeOrAbsoluteImportsAcrossLibraries` |     2 |        0 |      0 | agree            |
| `noRelativeOrAbsoluteExternals`              |     3 |        0 |  **1** | **WEAKER**       |
| `noCircularDependencies`                     |     1 |        0 |      0 | agree            |
| `noSelfCircularDependencies`                 |     2 |        1 |      0 | agree + stricter |
| `noImportsOfApps`                            |     1 |        1 |      0 | agree + stricter |
| `noImportsOfE2e`                             |     1 |        0 |      0 | agree            |
| `noImportOfNonBuildableLibraries`            |     1 |        0 |      0 | agree            |
| `noImportsOfLazyLoadedLibraries`             |     1 |        1 |      0 | agree + stricter |
| `projectWithoutTagsCannotHaveDependencies`   |     1 |        0 |      0 | agree            |
| `bannedExternalImportsViolation`             |     4 |        2 |      0 | agree + stricter |
| `nestedBannedExternalImportsViolation`       |     1 |        0 |      0 | agree            |
| `noTransitiveDependencies`                   |     2 |        1 |      0 | agree + stricter |
| `onlyTagsConstraintViolation`                |     9 |        2 |  **1** | **WEAKER**       |
| `emptyOnlyTagsConstraintViolation`           |     1 |        0 |      0 | agree            |
| `notTagsConstraintViolation`                 |     2 |        0 |      0 | agree            |

The suite prints this table, and every divergence beneath it with its reason, on
every run. The table above is a transcription; the run is the authority.

## Defects — where this engine is WEAKER than ESLint

Two, both found by this suite, neither known before it existed. Each is recorded
in the catalogue by name, so the suite fails if a third appears **and** fails if
one of these is fixed without the ledger being updated.

### 1. A relative path that resolves outside every project

`noRelativeOrAbsoluteExternals` · `external-resources-reached-by-path`

`import { there } from "../../../outside/present"`, where `outside/present.ts`
exists but belongs to no project. ESLint reports. This engine reports nothing.

The cause is the synthesized-external mechanism firing on a specifier that is a
path. The analyzer resolves the file, sees no owning project, and marks the
record `external: true` with `packageName: null`. `externalNodeFor` then falls
back to `getPackageNameFromImportPath("../../../outside/present")`, which returns
`".."`, and synthesizes `npm:..`. Having a target — however synthetic — makes
`evaluateSite` skip the `if (!targetProject)` branch, and that branch is the only
place `noRelativeOrAbsoluteExternals` is reported.

Upstream has no such node, so it falls into the branch and reports. The
near-misses beside this one agree: the same spelling pointing at a file that does
**not** exist, and the absolute `/outside/present`, both resolve to nothing and
both engines report.

The fix belongs in `src/rules/index.mjs`: a specifier that `isRelativePath` or
starts with `/` must not be given a synthesized external node, because upstream
never has one for a path either.

### 2. `require.resolve()` is invisible to the analyzer

`onlyTagsConstraintViolation` (and, by construction, all fifteen) ·
`import-forms-a-boundary-check-must-see`

Upstream's `getImportFromRequireCall` accepts both `require(...)` and
`require.resolve(...)` — the latter has a `MemberExpression` callee. The
TypeScript analyzer matches only `ts.isIdentifier(node.expression) &&
node.expression.text === "require"`, so a `require.resolve("@x/y")` call produces
no import record at all.

This is worse than one missing message. No record means no rule runs, so **every
one of the fifteen checks is unenforced on that call**, not just the one the
fixture happens to trigger. The fix belongs in
`src/analysis/typescript.mjs`'s `importSitesIn`.

## Decisions — where this engine is deliberately stricter

Every one is declared by the case that produces it, with its reason; the suite
fails on a stricter verdict that carries no declaration.

| divergence                                                                     | direction | verified how                                                                                                  |
| ------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------- |
| `data.mfeRemote` absent ⇒ the Module Federation exemption does not apply       | stricter  | `module-federation.config.js` on disk, field off the node: upstream exempts, this reports                     |
| `data.entryPoints` absent ⇒ the secondary-entry-point exemption does not apply | stricter  | `package.json` `exports` on disk, field off the node: upstream exempts, this reports                          |
| `data.declaredPackages` absent ⇒ the dependency is not shown to be direct      | stricter  | package in the root manifest, field off the node: upstream is silent, this reports `noTransitiveDependencies` |
| `require()` of a lazy-loaded library is reported                               | stricter  | upstream's lazy check requires `node.type === ImportDeclaration`; a call expression never reaches it          |
| `import x = require(...)` is judged                                            | stricter  | `TSImportEqualsDeclaration` is in none of upstream's five visitors; the analyzer records it as static         |
| an external record with no external node is still checked                      | stricter  | the three polyglot cases below — and see the correction, its reach is narrower than stated                    |

The three fail-closed rows are the same decision applied three times: upstream
reads a fact off the filesystem that a rule here may not, so the fact arrives as
an optional graph field and its absence means "the exemption does not apply". An
adapter that supplies the field gets upstream's answer exactly; one that does not
gets a false alarm a maintainer can see, rather than a boundary that quietly
stopped being enforced.

## The languages ESLint cannot read

Measured, not assumed. Asked to lint a `.go` file, ESLint answers:

> File ignored because no matching configuration was supplied.

That is the whole reason this tool exists, and it is pinned as a test. Three
cases show the tool enforcing where ESLint cannot:

| language | case                                      | this tool reports                |
| -------- | ----------------------------------------- | -------------------------------- |
| Rust     | `banned-external-crate-import-in-rust`    | `bannedExternalImportsViolation` |
| Python   | `banned-external-module-import-in-python` | `bannedExternalImportsViolation` |
| Go       | `layer-constraint-violation-in-go`        | `onlyTagsConstraintViolation`    |

**Vue is not on that list, and that is a finding.** A `.vue` file gets
`vue-eslint-parser` in [`eslint.config.mjs`](../../../../../eslint.config.mjs),
and the boundary rule block there carries no `files` filter, so the rule already
runs inside single-file components. The `banned-external-import-in-a-vue-single-file-component`
case confirms it: ESLint reports the banned import, and the two engines agree.
Vue was never a blind spot.

## Corrections — three claims that did not survive verification

Each of these was recorded in `src/rules/README.md` or its call sites as
settled. Each is wrong as stated, in a way that matters.

### "Upstream bails when it cannot find an external node"

Too strong. Nx's `TargetProjectLocator` finds an npm target from the graph's
`externalNodes` **or** by resolving `node_modules` on disk. With the external
nodes emptied entirely, an installed package still resolves to
`npm:@present/pkg`. Upstream comes up empty only when the package is on neither
— and there the TypeScript analyzer also records the import as unresolvable, so
this engine synthesizes nothing and is silent too
(`banned-external-import-of-a-package-that-is-not-installed`, both silent).

So the synthesis changes a verdict **only for Go, Rust and Python**, whose
analyzers name a package without needing it installed. It is not a general
mechanism, and the reach claimed for it in `src/rules/README.md` — "which would
leave `bannedExternalImports` unenforceable outside JavaScript" — is right about
those three and wrong about Vue.

### "The `@tauri-apps/*` ban works from `.rs` and `.py`"

Only for the bare form. `isConstraintBanningProject` opens with
`imp !== packageName && !imp.startsWith(`${packageName}/`)`, a test written for
npm's `/` separator. A Rust `use rustshell::window::Manager` has specifier
`rustshell::window::Manager` and package name `rustshell`; neither branch
matches, so the ban is silent. Same for Python's `import pyshell.window`.

Measured both ways in the Rust and Python cases: `use rustshell;` and
`import pyshell` are reported; the deep forms are not. A ban on a shell crate is
therefore close to unenforceable in Rust, where the bare `use` form is unusual.

### "`getEntryPoint`'s directory branch is dead upstream"

Dead for one key shape, alive for another, and the difference is a single
character. `joinPathFragments(file, '../')` keeps its trailing slash, and an
entry point's `path` is `joinPathFragments(projectRoot, basePath)` where
`basePath` is the `exports` **key**:

| `exports` key  | entry `path`      | can the walked `parent` match it? |
| -------------- | ----------------- | --------------------------------- |
| `"./sub"`      | `libs/a/sub`      | no                                |
| `"./src/sub"`  | `libs/a/src/sub`  | no                                |
| `"./src/sub/"` | `libs/a/src/sub/` | **yes**                           |

Two cases prove both halves. With `"./src/sub"`, a file inside the entry point's
directory importing that entry point is **not** reported — the walk finds
nothing, the two entry points differ, the exemption applies
(`self-import-from-inside-a-secondary-entry-point-directory`). With `"./src/sub/"`,
the walk matches, the two entry points are equal, and
`noSelfCircularDependencies` **is** reported by both engines
(`secondary-entry-point-declared-with-a-trailing-slash`).

This engine reproduces both, so parity holds either way. The claim should read
"dead for every `exports` key without a trailing slash", which is the modern
form and so nearly all of them.

### `nestedBannedExternalImportsViolation` really is near-unreachable

This one survived. The check is passed the specifier of the import being judged,
which by that point in the pipeline resolves to a **project**, while
`isConstraintBanningProject` demands that specifier be a nested **package**'s
name. It can only fire where a project's import alias and a transitively
reachable package name are the same string. The case builds exactly that
collision and both engines report; change the alias so it no longer collides and
both go silent.

Reproduced rather than repaired, deliberately: fixing it here would report what
ESLint does not, and parity is what makes this comparison mean anything.

## What the suite does not cover

- **Message text.** Verdicts are compared by id and site. Two messages carry
  file lists built from different indexes — upstream reads Nx's cached
  `projectFileMap`, this engine derives one from the records it was handed — so
  `noCircularDependencies` and `noImportsOfLazyLoadedLibraries` agree on the
  verdict and print different chains. The run reports which pairs those are.
- **Columns.** See "same site, not same column" above.
- **Scale.** Every fixture is minimal. Nothing here says how either engine
  behaves on a graph with hundreds of projects.
- **`ignoredCircularDependencies` glob patterns.** `src/config.mjs` rejects the
  patterns it cannot reproduce, so there is nothing to compare; only exact
  project names are exercised.
- **The real workspace.** These are synthetic trees. That is deliberate — this
  tool also runs over the private control-plane workspace, and a fixture built
  on this repository's project names would test a coincidence.

## What this licenses

**`@nx/enforce-module-boundaries` cannot be removed from `eslint.config.mjs`
today.** Not because the reimplementation is far off — thirteen of fifteen
message types agree wherever both engines can see the code — but because the two
false negatives above are exactly the failure mode that makes removal
irreversible. Delete the ESLint rule now and `require.resolve()` becomes an
unchecked hole in every one of the fifteen rules, with nothing left to notice.

Three things have to become true first.

1. **Both defects fixed, and this suite green with an empty defect ledger.** The
   `carries exactly the false negatives its own ledger records` test turns that
   into a gate rather than a memory: it fails on a new false negative and it
   fails when a recorded one is fixed and the ledger is not updated.
2. **The stricter list stays a decision, not a surprise.** Every fail-closed row
   fires on a graph field this repository's `src/graph/` does not populate today.
   Removing ESLint would put those false alarms in front of contributors on real
   code, so either the adapter supplies `mfeRemote`, `entryPoints` and
   `declaredPackages`, or each absence is accepted with its noise understood.
3. **The differential runs on real trees, not only on fixtures.** A suite of
   minimal fixtures proves the rules agree about the situations someone thought
   to build. Pointing both engines at this workspace and at the private
   control-plane workspace, and requiring the same verdict set, is what would
   prove they agree about the situations nobody thought of.

Until then the honest position is the one the tool already takes: run **both**.
ESLint stays authoritative for JavaScript, TypeScript and Vue, where it is
correct and where this engine is currently weaker in two known places. This tool
covers Go, Rust and Python, where ESLint reports nothing at all and any
enforcement is a strict improvement over the silence it replaces.
