/**
 * Local Nx project-graph plugin: infers cross-project EDGES for Go, Rust,
 * and Python projects. Nothing else — nodes still come from each project's
 * hand-written `project.json`, and targets are never inferred (root
 * CLAUDE.md → Workspace Execution: project.json is the source of truth).
 *
 * Registered in `nx.json → plugins`. Each resolver reads tracked manifests
 * and sources statically (regex for Go imports, smol-toml for Cargo/uv
 * manifests) so the graph computes without any language toolchain
 * installed. A workspace with no Go/Rust/Python projects pays nothing: every
 * resolver keys off `<projectRoot>/<manifest>` existing in the project's
 * tracked files.
 *
 * Resolver contract (kept identical across languages, see `src/*.mjs`):
 *   resolve(projects, filesOf, readFile) -> [{ source, target, sourceFile, type }]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveGoDependencies } from "./src/go.mjs";
import { resolvePythonDependencies } from "./src/python.mjs";
import { resolveRustDependencies } from "./src/rust.mjs";

export const name = "nx-polyglot-graph";

/** Pure core over an abstract workspace; injectable for tests. */
export function resolvePolyglotDependencies(projects, filesOf, readFile) {
  const deps = [
    ...resolveGoDependencies(projects, filesOf, readFile),
    ...resolveRustDependencies(projects, filesOf, readFile),
    ...resolvePythonDependencies(projects, filesOf, readFile),
  ];
  // One edge per (source, target, sourceFile) — a Go project importing a
  // sibling from ten files yields ten sourceFile-attributed edges upstream
  // of us; Nx dedupes too, this just keeps the plugin's output canonical.
  const seen = new Set();
  return deps.filter((d) => {
    const key = `${d.source} ${d.target} ${d.sourceFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const createDependencies = (_options, context) => {
  const projects = Object.entries(context.projects).map(([projectName, config]) => ({
    name: projectName,
    root: config.root,
  }));
  const filesOf = (projectName) =>
    (context.fileMap?.projectFileMap?.[projectName] ?? []).map((f) => f.file);
  const readFile = (workspaceRelativePath) => {
    try {
      return readFileSync(join(context.workspaceRoot, workspaceRelativePath), "utf8");
    } catch {
      return null;
    }
  };
  return resolvePolyglotDependencies(projects, filesOf, readFile);
};
