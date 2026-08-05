/**
 * Python resolver — reads pyproject.toml with a real TOML parser (smol-toml),
 * no `uv` binary required.
 *
 * Model: one package per Nx project (`<projectRoot>/pyproject.toml`,
 * `[project].name`), wired together the uv way: a dependency string in
 * `[project].dependencies`, `[project.optional-dependencies].*`, or
 * `[dependency-groups].*` creates an edge only when `[tool.uv.sources]`
 * routes that name to the workspace (`{ workspace = true }`) or to a path
 * that is another project's directory. A name that merely coincides with a
 * PyPI package never creates an edge — uv semantics, not string matching.
 */
import { normalizePath, parseManifest } from "./manifest-util.mjs";

/** PEP 503 name normalization: case-insensitive, runs of `-_.` collapse to `-`. */
export function normalizePackageName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** The package name a PEP 508 requirement string refers to, or null. */
export function parseRequirementName(requirement) {
  const match = requirement.trim().match(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/);
  return match ? normalizePackageName(match[0]) : null;
}

/** Every dependency name a pyproject manifest declares, deduped. */
export function collectDeclaredDependencies(manifest) {
  const names = new Set();
  const groups = [
    manifest.project?.dependencies ?? [],
    ...Object.values(manifest.project?.["optional-dependencies"] ?? {}),
    ...Object.values(manifest["dependency-groups"] ?? {}),
  ];
  for (const group of groups) {
    for (const entry of group) {
      if (typeof entry !== "string") continue; // {include-group = …} tables
      const name = parseRequirementName(entry);
      if (name) names.add(name);
    }
  }
  return [...names];
}

/**
 * Static edges between Python projects. Same contract as the other
 * resolvers: `projects` [{ name, root }], `filesOf(name)`, `readFile(path)`.
 */
export function resolvePythonDependencies(projects, filesOf, readFile) {
  const projectByPackage = new Map(); // normalized package name -> project name
  const projectByRoot = new Map();
  const packages = [];
  for (const project of projects) {
    const manifestPath = `${project.root}/pyproject.toml`;
    if (!filesOf(project.name).includes(manifestPath)) continue;
    const manifest = parseManifest(readFile(manifestPath) ?? "");
    const packageName = manifest?.project?.name;
    if (!packageName) continue; // a uv workspace root without [project] is not a package
    projectByPackage.set(normalizePackageName(packageName), project.name);
    projectByRoot.set(project.root, project.name);
    packages.push({ project, manifest, manifestPath });
  }

  const dependencies = [];
  for (const { project, manifest, manifestPath } of packages) {
    const sources = manifest.tool?.uv?.sources ?? {};
    const sourceOf = new Map(
      Object.entries(sources).map(([name, spec]) => [normalizePackageName(name), spec]),
    );
    for (const depName of collectDeclaredDependencies(manifest)) {
      const spec = sourceOf.get(depName);
      if (typeof spec !== "object" || spec === null) continue;
      let target = null;
      if (spec.workspace === true) {
        target = projectByPackage.get(depName) ?? null;
      } else if (typeof spec.path === "string") {
        target = projectByRoot.get(normalizePath(project.root, spec.path)) ?? null;
      }
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
  return dependencies;
}
