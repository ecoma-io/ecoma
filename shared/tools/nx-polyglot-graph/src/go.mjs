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
 */

/** Module path declared in a go.mod, or null. */
export function parseGoModulePath(goModText) {
  const match = goModText.match(/^module\s+(\S+)/m);
  return match ? match[1] : null;
}

/** Every import path in a .go file (single-form and block-form). */
export function parseGoImports(goText) {
  const imports = new Set();
  // import "p" | import alias "p" | import _ "p" | import . "p"
  for (const m of goText.matchAll(/^\s*import\s+(?:[A-Za-z_.][\w.]*\s+)?"([^"]+)"/gm)) {
    imports.add(m[1]);
  }
  for (const block of goText.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1].matchAll(/^\s*(?:[A-Za-z_.][\w.]*\s+)?"([^"]+)"/gm)) {
      imports.add(m[1]);
    }
  }
  return [...imports];
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
