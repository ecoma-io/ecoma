/**
 * Go resolver — static analysis only, no `go` binary required (the same
 * property gonx gets from tree-sitter, achieved here with two regexes over a
 * format that `gofmt` keeps canonical for the whole ecosystem).
 *
 * Model: one Go module per Nx project (`<projectRoot>/go.mod`); the module
 * path is the project's identity. An import of another project's module path
 * (exact or `<modulePath>/...`) is a static edge.
 *
 * Known parse limits, deliberate and pinned by tests: an `import (…)` block
 * is read up to the first `)`, and a commented-out import inside the block
 * still counts. Both misread only hand-mangled sources gofmt would rewrite,
 * and the worst case is a spurious graph edge — never a missed project.
 *
 * Two layers read those regexes. `resolveGoDependencies` reduces them to Nx
 * graph edges; `analyzeGo` returns the fuller import-site record
 * `analysis/contract.md` fixes — same parse, same limits, more of the answer
 * kept. `parseGoImportSites` is the single parse both go through, so the two
 * layers can never disagree about what a file imports.
 *
 * What the richer record adds, and what it deliberately leaves null:
 *
 * - `file` is always `null`. A Go import names a **package directory**, not a
 *   file, and which files that directory contributes is a build-constraint
 *   question needing the toolchain this resolver exists to avoid. That is the
 *   "resolution stops at a package rather than a file" case the contract
 *   allows, not a gap.
 * - `packageName` for an external import is the whole import path. Where a
 *   module path ends and a package path begins inside `example.com/a/b/c` is
 *   not statically knowable — only the module proxy knows — so the full path
 *   stands in, and a `bannedExternalImports` glob matches it the same way it
 *   would match a module prefix.
 * - `kind` is always `static`. Go has no dynamic import, no type-only import,
 *   and no re-export form; a blank (`_`) or dot (`.`) import is still an
 *   ordinary compile-time dependency.
 * - `spelling` is `{ path: false, relative: false }`, always. Go has no
 *   relative import form inside a module — every import is the full package
 *   path — so there is no spelling for this bit to be true for. **Known
 *   exposure, surfaced rather than fixed here:** a `.go` file importing
 *   another package of its OWN module resolves to its own project and is
 *   therefore reported as `noSelfCircularDependencies`, asking for a relative
 *   form Go does not have. No file in this workspace does it, so there is no
 *   evidence to fix it against; whether Go should instead say "an import that
 *   lands in my own project is internal" is a judgement about a language whose
 *   package graph cannot cycle at all, and it belongs in the change that has a
 *   real case to argue from.
 */
import {
  emptyResult,
  fileFailure,
  perWorkspace,
  positionAt,
  projectOwning,
  trackedManifests,
} from "./source-util.mjs";

/** Module path declared in a go.mod, or null. */
export function parseGoModulePath(goModText) {
  const match = goModText.match(/^module\s+(\S+)/m);
  return match ? match[1] : null;
}

/**
 * Every import in a .go file with the offset of its quoted path, in source
 * order and WITHOUT deduplication — one entry per written import, which is
 * what an import-site record is (`analysis/contract.md`).
 *
 * @param {string} goText
 * @returns {{ specifier: string, offset: number }[]}
 */
export function parseGoImportSites(goText) {
  const sites = [];
  // import "p" | import alias "p" | import _ "p" | import . "p"
  for (const m of goText.matchAll(/^\s*import\s+(?:[A-Za-z_.][\w.]*\s+)?"([^"]+)"/gm)) {
    sites.push({ specifier: m[1], offset: m.index + m[0].indexOf('"') });
  }
  for (const block of goText.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    const contentOffset = block.index + block[0].indexOf("(") + 1;
    for (const m of block[1].matchAll(/^\s*(?:[A-Za-z_.][\w.]*\s+)?"([^"]+)"/gm)) {
      sites.push({ specifier: m[1], offset: contentOffset + m.index + m[0].indexOf('"') });
    }
  }
  return sites.sort((a, b) => a.offset - b.offset);
}

/** Every import path in a .go file (single-form and block-form), deduped. */
export function parseGoImports(goText) {
  return [...new Set(parseGoImportSites(goText).map((site) => site.specifier))];
}

/**
 * Static edges between Go projects.
 *
 * `projects`: [{ name, root }]; `filesOf(name)`: workspace-relative paths of
 * a project's tracked files; `readFile(path)`: contents or null. Returns raw
 * Nx dependencies ({ source, target, sourceFile, type: "static" }).
 */
export function resolveGoDependencies(projects, filesOf, readFile) {
  const moduleOf = new Map(); // module path -> project name
  const goProjects = [];
  for (const project of projects) {
    const goModPath = `${project.root}/go.mod`;
    if (!filesOf(project.name).includes(goModPath)) continue;
    const modulePath = parseGoModulePath(readFile(goModPath) ?? "");
    if (!modulePath) continue;
    moduleOf.set(modulePath, project.name);
    goProjects.push(project);
  }

  const dependencies = [];
  for (const project of goProjects) {
    for (const file of filesOf(project.name)) {
      if (!file.endsWith(".go")) continue;
      const text = readFile(file);
      if (text === null) continue;
      for (const importPath of parseGoImports(text)) {
        for (const [modulePath, target] of moduleOf) {
          if (target === project.name) continue;
          if (importPath === modulePath || importPath.startsWith(`${modulePath}/`)) {
            dependencies.push({ source: project.name, target, sourceFile: file, type: "static" });
          }
        }
      }
    }
  }
  return dependencies;
}

/**
 * Every project's Go module paths, read once per workspace rather than once
 * per `.go` file. Every tracked `go.mod` in a project counts, not only the one
 * at its root — see `trackedManifests` for why analysis is broader here than
 * the edge resolver above.
 */
const goModulesOf = perWorkspace((workspace) => {
  const byModulePath = new Map(); // module path -> project name
  const byProject = new Map(); // project name -> [module path]
  for (const project of workspace.projects) {
    for (const goModPath of trackedManifests(workspace, project.name, "go.mod")) {
      const modulePath = parseGoModulePath(workspace.readFile(goModPath) ?? "");
      if (!modulePath) continue;
      byModulePath.set(modulePath, project.name);
      byProject.set(project.name, [...(byProject.get(project.name) ?? []), modulePath]);
    }
  }
  return { byModulePath, byProject };
});

/** True when `importPath` is inside the module rooted at `modulePath`. */
const isUnderModule = (importPath, modulePath) =>
  importPath === modulePath || importPath.startsWith(`${modulePath}/`);

/**
 * Analyzes one `.go` file.
 *
 * An import of the file's own module resolves to its own project rather than
 * being dropped: `contract.md` keeps intra-project imports because a rule
 * about a project reaching itself through its public path cannot be written
 * without them.
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzeGo({ sourceFile, text, workspace }) {
  const result = emptyResult();
  try {
    const { byModulePath, byProject } = goModulesOf(workspace);
    const owner = projectOwning(workspace.projects, sourceFile);
    const ownModules = owner ? (byProject.get(owner.name) ?? []) : [];

    for (const site of parseGoImportSites(text)) {
      const { line, column } = positionAt(text, site.offset);
      // Longest module path wins, for the reason `projectOwning` matches the
      // longest project root: a module nested under another module's path is
      // a different project, and a first-match answer would name its parent.
      let target = null;
      let matched = "";
      for (const ownModule of ownModules) {
        if (!isUnderModule(site.specifier, ownModule)) continue;
        if (ownModule.length <= matched.length) continue;
        target = owner.name;
        matched = ownModule;
      }
      for (const [modulePath, project] of byModulePath) {
        if (!isUnderModule(site.specifier, modulePath)) continue;
        if (modulePath.length <= matched.length) continue;
        target = project;
        matched = modulePath;
      }
      result.imports.push({
        sourceFile,
        line,
        column,
        specifier: site.specifier,
        kind: "static",
        // Neither bit is ever set for Go, and both answers are the language's
        // rather than a default. A Go import path is a PACKAGE path resolved
        // through the module graph, never a filesystem path resolved against
        // the importing file — modules mode rejects `import "./sub"` outright —
        // so `path` is false. And Go has no relative import form at all inside
        // a module: `spelling.relative` has nothing it could be true for. See
        // the header's known limits for what that costs.
        spelling: { path: false, relative: false },
        resolved: {
          target,
          file: null,
          external: target === null,
          packageName: target === null ? site.specifier : null,
        },
      });
    }
  } catch (cause) {
    result.failures.push(fileFailure(sourceFile, `Go analysis failed: ${cause?.message ?? cause}`));
  }
  return result;
}
