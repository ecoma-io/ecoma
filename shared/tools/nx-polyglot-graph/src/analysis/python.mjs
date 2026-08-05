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
 *
 * ## Two resolutions, kept side by side, because they answer different things
 *
 * `resolvePythonDependencies` above is **manifest-level**: it reports what a
 * project DECLARED, which is what an Nx edge should carry. `analyzePython`
 * below is **source-level**: it reports what a file actually IMPORTS.
 *
 * They are not the same question, and the gap between them is a real false
 * negative rather than a theoretical one. A `.py` file that writes
 * `import other_project.thing` without any `[tool.uv.sources]` entry imports
 * perfectly at runtime — in a uv workspace both packages are installed and
 * both are on `sys.path` — while the manifest says nothing at all. The
 * manifest-level view sees no dependency; the boundary was still crossed.
 *
 * Neither replaces the other. A declared-but-unused dependency and an
 * undeclared-but-imported one are both findings, and the two views disagreeing
 * is itself the information.
 *
 * ## Import roots come from the filesystem, because that is what Python reads
 *
 * Python has no `ts.resolveModuleName` to delegate to, and it does not need
 * one: an import name is a directory or file name on `sys.path`. Every build
 * backend declares packages differently — setuptools has `packages`,
 * hatchling has `[tool.hatch.build.targets.wheel] packages`, poetry has
 * `[tool.poetry] packages`, pdm and flit have their own — and reading five
 * dialects to learn what the tree already states would be five ways to be
 * wrong. So the layout itself is read:
 *
 * ```
 * src/<pkg>/__init__.py   -> import name <pkg>   (src layout)
 * <pkg>/__init__.py       -> import name <pkg>   (flat layout)
 * <mod>.py                -> import name <mod>   (single module)
 * ```
 *
 * Both bases — `<projectRoot>/src` and `<projectRoot>` — are read for every
 * project, in that order, because a src-layout project routinely still has a
 * root-level `conftest.py` that pytest makes importable as `conftest`. A file
 * is attributed to the first base that contains it, so a src-layout package is
 * never also indexed as `src.<pkg>`.
 *
 * **PEP 420 namespace packages are the one case the filesystem cannot settle,
 * and here is what this does about it.** A directory with no `__init__.py` is
 * still importable, and worse, two projects may each contribute a different
 * subpackage to the SAME top-level namespace — which is the point of the
 * feature. A top-level name alone therefore cannot say which project an import
 * reached. So the index is not a list of top-level roots but a map of every
 * importable dotted path, and resolution matches the LONGEST dotted prefix:
 * `import ns.alpha.thing` resolves through `ns.alpha` to the project that owns
 * it, never through the shared `ns`. When the longest matching prefix is
 * genuinely owned by more than one project, that is reported as an ambiguity
 * with `resolved: null` — Python itself resolves it by `sys.path` order, which
 * no static reader can know, and guessing is what the contract forbids.
 *
 * Known parse limits, deliberate and pinned by tests. As with the Go and Rust
 * headers, the worst case of each is a spurious record naming text the file
 * really contains — never a missed project:
 *
 * - **Imports are matched per line**, with any indentation allowed. That is
 *   deliberate, not sloppy: it is what catches a function-local import and an
 *   import under `if TYPE_CHECKING:`, both of which cross a boundary. A line
 *   continued with `\` or a second statement after `;` is not followed.
 * - **A triple-quoted string containing a line that looks like an import** is
 *   read as one. `#` comments are not, since the `#` precedes the keyword.
 * - **`if TYPE_CHECKING:` imports stay `kind: "static"`.** They are erased at
 *   runtime, so `type-only` is tempting, but a TYPE_CHECKING guard is a
 *   runtime conditional rather than a declaration that the dependency is
 *   absent — the module is still named, and the boundary is still crossed.
 *   Marking them `type-only` would let a rule that exempts erased imports
 *   exempt them, which is the bypass this tool exists to close.
 * - **`packageName` for an external import is the top-level import name**, not
 *   the PyPI distribution name. The two differ (`import PIL` ships as
 *   `pillow`) and only the import name is knowable from a source file.
 */
import { normalizePath, parseManifest } from "./manifest-util.mjs";
import {
  emptyResult,
  fileFailure,
  perWorkspace,
  positionAt,
  projectOwning,
} from "./source-util.mjs";

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

/** A name Python can spell in an import statement. */
const isImportableName = (name) => /^[A-Za-z_]\w*$/.test(name);

/** The two directories a project puts on `sys.path`, src layout first. */
const importBasesOf = (projectRoot) =>
  projectRoot === "" ? ["src", ""] : [`${projectRoot}/src`, projectRoot];

/** `file` relative to `base`, or null when it is not under it. */
function relativeTo(base, file) {
  if (base === "") return file;
  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : null;
}

/** A `.py` file's path components below its import base, or null. */
function componentsOf(file, projectRoot) {
  for (const base of importBasesOf(projectRoot)) {
    const relative = relativeTo(base, file);
    if (relative === null) continue;
    return relative.slice(0, -".py".length).split("/");
  }
  return null;
}

/** The dotted path a `.py` file is importable as, relative to its base. */
function dottedNameOf(file, projectRoot) {
  const parts = componentsOf(file, projectRoot);
  if (parts === null) return null;
  if (parts[parts.length - 1] === "__init__") parts.pop();
  return parts.every(isImportableName) ? parts : null;
}

/**
 * The package a `.py` file lives IN, which is what a relative import is
 * resolved against. This is not the file's own dotted name: `pkg/__init__.py`
 * IS the package `pkg`, so `from . import x` inside it means `pkg`, while
 * `pkg/mod.py` sits in `pkg` and means the same thing from a different name.
 * Dropping the last path component answers both, which dropping `__init__`
 * first would not.
 */
function ownPackageOf(file, projectRoot) {
  const parts = componentsOf(file, projectRoot);
  if (parts === null) return null;
  parts.pop();
  return parts.every(isImportableName) ? parts : null;
}

/**
 * Every dotted name a project's tracked `.py` files make importable.
 *
 * Regular packages and modules map to the file that defines them. Every
 * directory prefix along the way is also recorded, with a null file, because
 * PEP 420 makes a directory importable whether or not it carries an
 * `__init__.py` — a prefix that DOES have one overwrites the null entry, so
 * the result does not depend on the order files arrive in.
 *
 * @param {string} projectRoot Workspace-relative.
 * @param {string[]} files The project's tracked files, workspace-relative.
 * @returns {Map<string, { file: string|null, namespace: boolean }>}
 */
export function pythonModuleIndex(projectRoot, files) {
  const index = new Map();
  for (const file of files) {
    if (!file.endsWith(".py")) continue;
    const parts = dottedNameOf(file, projectRoot);
    if (parts === null || parts.length === 0) continue;
    index.set(parts.join("."), { file, namespace: false });
    for (let depth = 1; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth).join(".");
      if (!index.has(prefix)) index.set(prefix, { file: null, namespace: true });
    }
  }
  return index;
}

/**
 * A project's top-level import names — the `src/<pkg>` · `<pkg>` · `<mod>.py`
 * model stated in the header, derived from the same scan rather than from a
 * second one, so the two can never disagree.
 *
 * @param {string} projectRoot
 * @param {string[]} files
 * @returns {string[]}
 */
export function pythonImportRoots(projectRoot, files) {
  return [...pythonModuleIndex(projectRoot, files).keys()]
    .filter((name) => !name.includes("."))
    .sort();
}

/** Every Python project's module index, plus the global dotted-name map. */
const pythonModulesOf = perWorkspace((workspace) => {
  const byModule = new Map(); // dotted name -> [{ project, file }]
  for (const project of workspace.projects) {
    const files = workspace.filesOf(project.name);
    if (!files.some((file) => file.endsWith(".py"))) continue;
    for (const [dotted, entry] of pythonModuleIndex(project.root, files)) {
      const owners = byModule.get(dotted) ?? [];
      owners.push({ project: project.name, file: entry.file });
      byModule.set(dotted, owners);
    }
  }
  return byModule;
});

/**
 * The project a dotted module name reaches, by longest matching prefix.
 *
 * @returns {{ owner: object }|{ ambiguous: string[], prefix: string }|null}
 *   `null` when no project claims any prefix — the module is external.
 */
function resolveModuleName(dotted, byModule) {
  const parts = dotted.split(".");
  for (let depth = parts.length; depth >= 1; depth--) {
    const prefix = parts.slice(0, depth).join(".");
    const owners = byModule.get(prefix);
    if (!owners) continue;
    const projects = [...new Set(owners.map((owner) => owner.project))];
    if (projects.length > 1) return { ambiguous: projects, prefix };
    return { owner: owners[0] };
  }
  return null;
}

/**
 * The absolute module a relative specifier names, or `null` when it climbs
 * past the top-level package — which Python rejects too, and which is how an
 * import escapes the project it was written in.
 *
 * @param {string} specifier As written: `.`, `..`, `.mod`, `..pkg.sub`.
 * @param {string[]} ownPackage The importing file's own package, dotted-split.
 */
function resolveRelativeModule(specifier, ownPackage) {
  const dots = /^\.+/.exec(specifier)[0].length;
  const climb = dots - 1;
  if (ownPackage.length - climb <= 0) return null;
  const rest = specifier.slice(dots);
  const parts = [
    ...ownPackage.slice(0, ownPackage.length - climb),
    ...(rest === "" ? [] : rest.split(".")),
  ];
  return parts.join(".");
}

const IMPORT_STATEMENT = /^[ \t]*import[ \t]+/;
const FROM_STATEMENT =
  /^([ \t]*from[ \t]+)(\.+[A-Za-z_][\w.]*|\.+|[A-Za-z_][\w.]*)([ \t]+import\b)/;
const DOTTED_NAME = /^[ \t]*([A-Za-z_][\w.]*)/;
/** `importlib.import_module(`, a bare `import_module(`, and `__import__(`. */
const DYNAMIC_CALL = /\b(?:importlib\s*\.\s*)?import_module\s*\(\s*|\b__import__\s*\(\s*/g;
const STRING_LITERAL = /^(['"])([^'"\\]*)\1/;

/**
 * Every import site in a `.py` source, in source order and without
 * deduplication — one entry per written import.
 *
 * @param {string} pythonText
 * @returns {{ specifier: string, kind: string, offset: number, literal: boolean }[]}
 */
export function parsePythonImportSites(pythonText) {
  const sites = [];
  let lineOffset = 0;
  for (const line of pythonText.split("\n")) {
    const from = FROM_STATEMENT.exec(line);
    if (from) {
      sites.push({
        specifier: from[2],
        kind: "static",
        offset: lineOffset + from[1].length,
        literal: true,
      });
    } else {
      const statement = IMPORT_STATEMENT.exec(line);
      if (statement) {
        // `import a.b as c, x.y` is several written imports on one line, and
        // each gets its own record with its own column.
        let cursor = statement[0].length;
        for (const piece of line.slice(cursor).split(",")) {
          const name = DOTTED_NAME.exec(piece);
          if (name) {
            sites.push({
              specifier: name[1],
              kind: "static",
              offset: lineOffset + cursor + name[0].length - name[1].length,
              literal: true,
            });
          }
          cursor += piece.length + 1;
        }
      }
    }
    lineOffset += line.length + 1;
  }

  for (const call of pythonText.matchAll(DYNAMIC_CALL)) {
    const offset = call.index + call[0].length;
    const rest = pythonText.slice(offset);
    const literal = STRING_LITERAL.exec(rest);
    sites.push(
      literal
        ? { specifier: literal[2], kind: "dynamic", offset, literal: true }
        : { specifier: /^[^),\n]*/.exec(rest)[0].trim(), kind: "dynamic", offset, literal: false },
    );
  }

  return sites.sort((a, b) => a.offset - b.offset);
}

/**
 * Analyzes one `.py` file.
 *
 * @param {{ sourceFile: string, text: string, workspace: object }} request
 * @returns {{ imports: object[], failures: object[] }}
 */
export function analyzePython({ sourceFile, text, workspace }) {
  const result = emptyResult();
  try {
    const byModule = pythonModulesOf(workspace);
    const owner = projectOwning(workspace.projects, sourceFile);
    const ownPackage = owner ? ownPackageOf(sourceFile, owner.root) : null;

    for (const site of parsePythonImportSites(text)) {
      const { line, column } = positionAt(text, site.offset);
      const record = {
        sourceFile,
        line,
        column,
        specifier: site.specifier,
        kind: site.kind,
        resolved: null,
      };
      result.imports.push(record);
      const fail = (reason) => result.failures.push({ sourceFile, line, column, reason });

      if (!site.literal) {
        fail(
          `dynamic import of '${site.specifier}' has a non-literal argument, ` +
            `so its target is not knowable statically`,
        );
        continue;
      }

      let absolute = site.specifier;
      if (site.specifier.startsWith(".")) {
        if (ownPackage === null) {
          fail(
            `relative import '${site.specifier}' cannot be resolved: '${sourceFile}' is not on any import root`,
          );
          continue;
        }
        absolute = resolveRelativeModule(site.specifier, ownPackage);
        if (absolute === null) {
          fail(
            `relative import '${site.specifier}' climbs past the top-level package of '${sourceFile}', ` +
              `which leaves the project's import root — Python rejects it the same way`,
          );
          continue;
        }
      }

      const resolution = resolveModuleName(absolute, byModule);
      if (resolution === null) {
        record.resolved = {
          target: null,
          file: null,
          external: true,
          packageName: absolute.split(".")[0],
        };
      } else if (resolution.ambiguous) {
        fail(
          `'${site.specifier}' resolves through the namespace package '${resolution.prefix}', which ` +
            `${resolution.ambiguous.join(" and ")} both contribute to — Python picks by sys.path order, ` +
            `which no static reader can know`,
        );
      } else {
        record.resolved = {
          target: resolution.owner.project,
          file: resolution.owner.file,
          external: false,
          packageName: null,
        };
      }
    }
  } catch (cause) {
    result.failures.push(
      fileFailure(sourceFile, `Python analysis failed: ${cause?.message ?? cause}`),
    );
  }
  return result;
}
