/**
 * The workspace's module-boundary law, in one place, as data.
 *
 * It used to live inline in `eslint.config.mjs`, which was correct while
 * ESLint was the only thing that could enforce it. It no longer is: ESLint
 * reads only JavaScript and TypeScript, so for a Go, Rust, or Python project
 * the `layer:`/`scope:`/`license:` tags below are a declaration with no
 * mechanism behind them. `shared/tools/nx-polyglot-graph` is growing that
 * mechanism, which makes this table's second reader real — and a rule table
 * with two readers must be authored once and imported, never restated (root
 * `CLAUDE.md`, Rule 14 rung 2). A second copy would not fail loudly; it would
 * drift, and the half of the workspace reading the stale copy would report
 * green against a boundary nobody still holds.
 *
 * Shape is `@nx/enforce-module-boundaries`' own option object, deliberately:
 * ESLint spreads it straight into the rule, so the vocabulary a reader has to
 * learn is the plugin's documented one rather than a local dialect. Any
 * consumer that is not ESLint is therefore also committing to that semantics —
 * it must apply these constraints the way the plugin does, not the way it finds
 * convenient. `shared/tools/nx-polyglot-graph/src/config.mjs` validates the
 * shape on load so a malformed table fails where it is read.
 *
 * Root-owned, at the root, because the boundary spans every subsystem: no one
 * project can own the rule that says which projects may import which.
 */

/**
 * The constraint table. A dependency must satisfy EVERY constraint whose
 * `sourceTag` its source project carries, so the axes below compose rather
 * than override — a `scope:shared` `layer:domain` lib is held to both lines.
 */
export const depConstraints = [
  // Layer axis: apps consume libs; libs never import apps.
  { sourceTag: "type:app", onlyDependOnLibsWithTags: ["type:lib"] },
  { sourceTag: "type:lib", onlyDependOnLibsWithTags: ["type:lib"] },
  // An e2e project drives a built artifact from the outside; it may
  // name a lib's public API (shared a11y scope, fixture types) but
  // never another e2e suite, and never an app's internals.
  { sourceTag: "type:e2e", onlyDependOnLibsWithTags: ["type:lib"] },
  // Scope axis: a product domain gets its own scope tag when it takes
  // root, constrained to its own libs plus shared ones; shared libs
  // never reach into a product domain. Only the scope that has a
  // project today appears here — a scope is added in the change that
  // lands its first project, never in anticipation of one.
  { sourceTag: "scope:shared", onlyDependOnLibsWithTags: ["scope:shared"] },
  {
    sourceTag: "scope:website",
    onlyDependOnLibsWithTags: ["scope:website", "scope:shared"],
  },
  {
    sourceTag: "scope:platform",
    onlyDependOnLibsWithTags: ["scope:platform", "scope:shared"],
  },
  {
    sourceTag: "scope:rba",
    onlyDependOnLibsWithTags: ["scope:rba", "scope:shared"],
  },
  // Hex layer axis (domain/port/adapter/view + util), enforced from the
  // first brick so an import flowing the wrong way fails lint at once.
  // A dep must satisfy every one of its source's tag constraints, so
  // these compose with the scope/type axes above.
  //   util    → cross-cutting pure helpers (hashing…), leaf-agnostic
  //   domain  → pure types/logic; depends only on domain + util
  //   port    → an interface a domain exposes; may name domain types
  //   adapter → implements a port; may use port + domain
  //   view    → presentational; may use domain, never adapter, and never
  //             the desktop host runtime (it emits intents, the shell wires them)
  //   app     → application-service (agent-runtime, tool-proxy): orchestrates
  //             over ports; may use port + domain + util + peer app, but
  //             NEVER an adapter directly — reaching an engine/store means
  //             going through its port, so the engine stays swappable
  { sourceTag: "layer:util", onlyDependOnLibsWithTags: ["layer:util"] },
  { sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:domain", "layer:util"] },
  {
    sourceTag: "layer:port",
    onlyDependOnLibsWithTags: ["layer:domain", "layer:port", "layer:util"],
  },
  {
    sourceTag: "layer:adapter",
    onlyDependOnLibsWithTags: ["layer:domain", "layer:port", "layer:adapter", "layer:util"],
  },
  {
    sourceTag: "layer:view",
    onlyDependOnLibsWithTags: ["layer:view", "layer:domain", "layer:util"],
    // A view lib emits intents and lets the shell wire them, so it must
    // not reach the desktop host runtime directly. Named for the shell
    // this workspace actually ships (Tauri) — a banned import for a
    // package no longer installed enforces nothing. Adding a second
    // shell means adding its runtime here in the same pass.
    bannedExternalImports: ["@tauri-apps/*"],
  },
  {
    sourceTag: "layer:app",
    onlyDependOnLibsWithTags: ["layer:app", "layer:port", "layer:domain", "layer:util"],
  },
  // Licence axis — the carve-out in the root LICENSE, made executable.
  // A tree's own LICENSE decides the terms it grants;
  // `check-project-conventions` makes each project's `license:*` tag
  // agree with what its tree and path imply; these three constraints
  // make the import graph respect the result. Without them the
  // boundary is a sentence in a legal document that the build has no
  // way to hold anyone to.
  //
  //   sul   → may use SUL and Apache code.
  //   apache→ Apache only, and this direction is the load-bearing one.
  //           A `packages/` unit is what third parties receive under
  //           Apache 2.0; importing SUL code would hand them SUL code
  //           under Apache terms, which we cannot grant and cannot undo.
  //   proprietary → the operator control plane calls public mechanisms
  //           and patches none, so it may depend on them, and nothing
  //           public may depend on it (it is absent from a contributor's
  //           clone, so such an import would not even resolve).
  //
  // There was a fourth, `license:ee`, forbidden to SUL code so that an
  // Enterprise module could never ship to every self-hoster through a
  // one-line import. The tier is retired, and the constraint goes with
  // it rather than lingering over a tag nothing can carry — a rule
  // whose source tag no project can hold is a rule that proves nothing
  // while reading as protection.
  {
    sourceTag: "license:sul",
    onlyDependOnLibsWithTags: ["license:sul", "license:apache"],
  },
  { sourceTag: "license:apache", onlyDependOnLibsWithTags: ["license:apache"] },
  {
    sourceTag: "license:proprietary",
    onlyDependOnLibsWithTags: ["license:proprietary", "license:sul", "license:apache"],
  },
];

/**
 * The eight non-table options of `@nx/enforce-module-boundaries`, stated at the
 * values this workspace runs on.
 *
 * Every value here equals the plugin's own `defaultOptions`, so ESLint behaves
 * exactly as it did when `eslint.config.mjs` passed `depConstraints` alone.
 * They are written out anyway, and that is the point of the file: an option
 * left implicit is an option only ESLint knows the value of, and a second
 * enforcer would have to guess it. Guessing `banTransitiveDependencies` wrong
 * makes two tools disagree about the same import while both report confidently.
 *
 * Changing a value here changes it for every reader at once — which is the
 * only way a boundary rule can be changed without splitting the workspace's
 * answer in two.
 *
 *   allow — import specifiers exempt from every check below, matched with
 *     wildcards. Empty: no import in this workspace is above the boundary.
 *   buildTargets — the target names that make a project "buildable", read only
 *     by `enforceBuildableLibDependency`. Nx's own default name.
 *   enforceBuildableLibDependency — off, and it follows from the library model
 *     rather than from taste: libs here are buildless (`main → src/index.ts`,
 *     bundled into each consumer), so no lib has a `build` target and the check
 *     would have nothing true to say.
 *   allowCircularSelfDependency — off: a file reaching its own project through
 *     the project's public alias instead of a relative path is a cycle through
 *     the barrel, and it stays an error.
 *   checkDynamicDependenciesExceptions — empty: a `import()` is held to the
 *     same constraints as a static import. A lazy boundary violation is still a
 *     boundary violation; it just fails later.
 *   ignoredCircularDependencies — empty: no project pair is excused from the
 *     cycle check.
 *   banTransitiveDependencies — off. A project may use what it reaches
 *     transitively, because this is a single-package monorepo: third-party deps
 *     are declared once in the root `package.json` and no per-lib manifest
 *     declares dependencies, so "declare what you import" has no manifest to be
 *     declared in and the rule would only be able to fire on internal libs.
 *   checkNestedExternalImports — off: `bannedExternalImports` is judged against
 *     what a project imports directly, not against what its dependencies drag
 *     in. The one ban in the table above (`@tauri-apps/*` out of `layer:view`)
 *     is about what view code writes, and a nested check would fail a view lib
 *     for a shell dependency of a lib it uses.
 */
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
