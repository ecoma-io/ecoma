/**
 * Rust resolver — reads Cargo manifests with a real TOML parser (smol-toml),
 * no `cargo` binary required.
 *
 * Model: one crate per Nx project (`<projectRoot>/Cargo.toml`). Edges come
 * from dependency entries that resolve to another project's directory:
 *   - `{ path = "…" }` entries, relative to the declaring manifest;
 *   - `{ workspace = true }` entries, resolved through the nearest ancestor
 *     manifest carrying `[workspace]` (its `[workspace.dependencies]` entry
 *     must itself be a `path` dependency to point at a project).
 * Registry (crates.io) dependencies are ignored — external nodes are out of
 * scope for this plugin; only project↔project edges matter to `nx affected`.
 */
import { normalizePath, parseManifest } from "./manifest-util.mjs";

const DEP_SECTIONS = ["dependencies", "dev-dependencies", "build-dependencies"];

/** All dependency tables in a manifest: top-level plus per-target ones. */
function* depTables(manifest) {
  for (const section of DEP_SECTIONS) {
    if (manifest[section]) yield manifest[section];
  }
  for (const targetCfg of Object.values(manifest.target ?? {})) {
    for (const section of DEP_SECTIONS) {
      if (targetCfg?.[section]) yield targetCfg[section];
    }
  }
}

/**
 * Nearest ancestor dir (starting at the parent of `startDir`) whose
 * Cargo.toml declares `[workspace]`; `{ dir, manifest }` or null.
 */
function findWorkspaceManifest(startDir, readFile) {
  let dir = startDir;
  while (dir.includes("/")) {
    dir = dir.slice(0, dir.lastIndexOf("/"));
    const manifest = parseManifest(readFile(`${dir}/Cargo.toml`) ?? "");
    if (manifest?.workspace) return { dir, manifest };
  }
  const manifest = parseManifest(readFile("Cargo.toml") ?? "");
  return manifest?.workspace ? { dir: "", manifest } : null;
}

/**
 * Static edges between Rust projects. Same contract as the Go resolver:
 * `projects` [{ name, root }], `filesOf(name)`, `readFile(path)` → raw deps.
 */
export function resolveRustDependencies(projects, filesOf, readFile) {
  const projectByRoot = new Map();
  const crates = [];
  for (const project of projects) {
    const manifestPath = `${project.root}/Cargo.toml`;
    if (!filesOf(project.name).includes(manifestPath)) continue;
    const manifest = parseManifest(readFile(manifestPath) ?? "");
    if (!manifest?.package?.name) continue; // workspace-only manifests are not crates
    projectByRoot.set(project.root, project.name);
    crates.push({ project, manifest, manifestPath });
  }

  const dependencies = [];
  for (const { project, manifest, manifestPath } of crates) {
    const workspace = { resolved: false, value: null }; // lazy per-crate lookup
    for (const table of depTables(manifest)) {
      for (const [depName, spec] of Object.entries(table)) {
        if (typeof spec !== "object" || spec === null) continue;
        let pathDir = null;
        if (typeof spec.path === "string") {
          pathDir = normalizePath(project.root, spec.path);
        } else if (spec.workspace === true) {
          if (!workspace.resolved) {
            workspace.resolved = true;
            workspace.value = findWorkspaceManifest(project.root, readFile);
          }
          const wsSpec = workspace.value?.manifest.workspace?.dependencies?.[depName];
          if (typeof wsSpec?.path === "string") {
            pathDir = normalizePath(workspace.value.dir, wsSpec.path);
          }
        }
        if (!pathDir) continue;
        const target = projectByRoot.get(pathDir);
        if (target && target !== project.name) {
          dependencies.push({
            source: project.name,
            target,
            sourceFile: manifestPath,
            type: "static",
          });
        }
      }
    }
  }
  return dependencies;
}
