/**
 * The workspace as the rule engine needs to see it: an Nx-shaped project graph,
 * and the `Workspace` object every analyzer resolves against.
 *
 * `evaluate(sites, graph, config)` is pure and takes a graph it does not build
 * (`../rules/README.md`). Under Nx that graph arrives from Nx. A language
 * server has no Nx — it is spawned by an editor, in a directory, with nothing
 * else — so this module builds the same shape from the same source of truth Nx
 * reads: the tracked `project.json` files.
 *
 * ## What it may assume about the tree, which is nothing
 *
 * No project name, no directory layout, no tag vocabulary (project CLAUDE.md —
 * the tool also runs over the private control-plane workspace through a pinned
 * harness clone). Everything below is derived: projects from the `project.json`
 * files that exist, node types from `projectType` by Nx's own rule, tags from
 * each project's own list, edges from the imports the analyzers actually find.
 *
 * ## Why the file list comes from git
 *
 * The analysis contract's `filesOf` means "the project's tracked files", and
 * git is the one component that already answers that exactly. The alternative
 * is a directory walk with a skip list — `node_modules`, `dist`, `target`,
 * `.venv` — which is a config nobody maintains until the day it swallows a real
 * source directory and the boundary quietly stops being enforced there
 * (Rule 14: derive before you configure). `--others --exclude-standard` adds
 * files that exist but are not committed yet, because a file a developer
 * created five seconds ago is exactly the one they are about to import.
 *
 * A workspace git cannot answer for is a LOUD failure, never a silent empty
 * index: `buildWorkspaceIndex` throws, and the server turns that into a
 * diagnostic on every open document rather than a clean bill of health.
 *
 * ## What the index could not read is data the caller must publish
 *
 * The two failures below are recorded rather than thrown, because one project
 * being edited must not blank the graph for the other nineteen. Recording them
 * is only half an answer: an index missing a project or an edge produces a
 * verdict that is not the verdict, and a caller that reads neither list
 * publishes that verdict as if the tree had been read whole. `indexGaps` turns
 * both lists into sentences, and `./diagnose.mjs` refuses to call a document
 * analyzed while either is non-empty.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { analyzeFile, languageOf } from "../analysis/analyze.mjs";
import { findMatchingProjects } from "../rules/match.mjs";

/** The file Nx reads to learn a project exists — and so does this. */
export const PROJECT_CONFIG_FILE = "project.json";

/**
 * Where Nx keeps the parser behind `readJsonFile`. Pinned with `nx` itself,
 * which the workspace root declares at an exact version.
 */
const NX_JSON_PARSER = "nx/src/utils/json.js";

/** Resolved once, success or failure, and remembered either way. */
let nxParserLoad = null;

/** Nx's `parseJson`, or the reason it could not be reached. */
function nxParseJson() {
  if (nxParserLoad === null) {
    try {
      nxParserLoad = {
        parse: createRequire(import.meta.url)(NX_JSON_PARSER).parseJson,
        error: null,
      };
    } catch (cause) {
      nxParserLoad = { parse: null, error: cause?.message ?? String(cause) };
    }
  }
  return nxParserLoad;
}

/**
 * One `project.json` — or the `package.json` beside it — read the way Nx reads
 * it, which is NOT `JSON.parse`.
 *
 * Nx goes `readJsonFile` → `parseJson` → jsonc-parser with
 * `allowTrailingComma: true`, so a config carrying a trailing comma, a `//`
 * line comment or a block comment is a project Nx HAS: it appears in
 * `nx graph`, ESLint sees it, `../../cli.mjs` sees it. Measured against the
 * installed nx, all three forms parse there and all three throw from
 * `JSON.parse`.
 *
 * Losing such a project here is the worst failure this server can have. The
 * project leaves the graph; an import into it then resolves as external rather
 * than cross-project; the rule engine's npm branch returns before the tag
 * checks run; and the editor paints a real violation clean. So the parser is
 * REACHED rather than reproduced — a second JSONC implementation would be a
 * second answer to a question Nx already answers, and it would drift first on
 * exactly the inputs that motivate it.
 *
 * Two shapes are deliberate:
 *
 * - **`JSON.parse` runs first**, exactly as `parseJson` itself runs it first.
 *   A tree of plain JSON — nearly every tree, nearly always — loads no module
 *   at all, and the whole cost of this arrives only on a file that needed it.
 * - **`nx` is loaded on first need through `createRequire`**, the arrangement
 *   `../analysis/vue.mjs` uses and for the same reason: this tool runs over
 *   trees that do not depend on Nx, and a top-level import would take Go, Rust
 *   and Python analysis down in a workspace that has no Nx to disagree with.
 *   When the parser cannot be reached the reader gets the original
 *   `JSON.parse` failure with the absent parser named in it — the project is
 *   still skipped, and `indexGaps` is what keeps that skip from being silence.
 *
 * @param {string} text
 * @returns {object} Whatever the JSON describes.
 * @throws {Error} when neither parser can read it.
 */
export function parseProjectJson(text) {
  try {
    return JSON.parse(text);
  } catch (plain) {
    const nx = nxParseJson();
    if (nx.parse === null) {
      throw new Error(
        `${plain.message}. The JSONC forms Nx accepts — a trailing comma, a line or block ` +
          `comment — could not be tried, because '${NX_JSON_PARSER}' is not resolvable from ` +
          `here: ${nx.error}`,
        { cause: plain },
      );
    }
    // `expectComments` only tells `parseJson` to skip the `JSON.parse` attempt
    // that already failed above; the jsonc options it applies are the same
    // ones `readJsonFile` gets.
    return nx.parse(text, { expectComments: true });
  }
}

/**
 * Every file git considers part of the working tree, workspace-relative and
 * `/`-separated.
 *
 * `-z` because a path may legitimately contain a newline, and splitting on one
 * would invent two files that do not exist.
 *
 * @param {string} root Absolute workspace root.
 * @returns {string[]}
 * @throws {Error} when git cannot answer — not a git tree, git not installed.
 */
export function listWorkspaceFiles(root) {
  let stdout;
  try {
    stdout = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (cause) {
    throw new Error(
      `nx-polyglot-graph: cannot list the files of ${root}: ${cause?.message ?? cause}. ` +
        `The language server reads the workspace's file list from git; without it there is ` +
        `no project list, and every file would be reported as having no boundary to cross.`,
      { cause },
    );
  }
  return stdout.split("\0").filter((file) => file !== "");
}

/**
 * Nx's own `getProjectType`, reproduced over the same inputs.
 *
 * Reproduced rather than reached, unlike `parseProjectJson` above, and not by
 * preference: Nx keeps this one as a module-private function of
 * `normalize-project-nodes`, which exports two other names and not this. What
 * makes reproducing it safe is that the rule is Nx's own convention — the
 * `-e2e` suffix is a naming Nx defines, never one this workspace supplies — so
 * nothing here assumes anything about the tree it runs over.
 *
 * The filesystem fallbacks Nx applies when `projectType` is absent are NOT
 * reproduced. Nx probes for `tsconfig.lib.json`, `tsconfig.app.json` and a
 * `package.json` entry point; a project that states no `projectType` lands on
 * `lib` here. That direction is the safe one: `lib` is the only type with no
 * blanket import ban, so a mis-typed project is judged by its tags rather than
 * refused outright by a rule that never should have fired.
 *
 * @param {string} name
 * @param {string|undefined} projectType From `project.json`.
 * @returns {"app"|"e2e"|"lib"}
 */
export function nodeTypeOf(name, projectType) {
  if (projectType === "application") {
    return name.endsWith("-e2e") || name === "e2e" ? "e2e" : "app";
  }
  return "lib";
}

/** The directory part of a workspace-relative path; `""` at the tree root. */
const directoryOf = (file) => {
  const slash = file.lastIndexOf("/");
  return slash === -1 ? "" : file.slice(0, slash);
};

/**
 * The projects declared in a tree, from its `project.json` files.
 *
 * A `project.json` that will not parse is SKIPPED and reported, not thrown on:
 * one project being edited must not blank the graph for the other nineteen. The
 * caller decides how loud to be about the ones that were skipped.
 *
 * @param {{files: string[], readFile: (path: string) => string|null}} tree
 * @returns {{projects: {name: string, root: string, config: object}[], skipped: {file: string, reason: string}[]}}
 */
export function discoverProjects({ files, readFile }) {
  const projects = [];
  const skipped = [];
  for (const file of files) {
    if (file !== PROJECT_CONFIG_FILE && !file.endsWith(`/${PROJECT_CONFIG_FILE}`)) continue;
    const text = readFile(file);
    if (text === null) {
      skipped.push({ file, reason: "could not be read" });
      continue;
    }
    let config;
    try {
      config = parseProjectJson(text);
    } catch (cause) {
      skipped.push({ file, reason: `is not valid JSON: ${cause?.message ?? cause}` });
      continue;
    }
    const root = directoryOf(file);
    // Nx's own precedence: the name a project states, then the one its
    // `package.json` states, then the directory it lives in.
    const packageName = (() => {
      const manifest = readFile(root === "" ? "package.json" : `${root}/package.json`);
      if (manifest === null) return undefined;
      try {
        // The same parser, because Nx reads this file with the same
        // `readJsonFile` — a `package.json` Nx can name a project from must
        // not become a project named after its directory here.
        return parseProjectJson(manifest).name;
      } catch {
        return undefined;
      }
    })();
    const name =
      config.name ?? packageName ?? (root === "" ? "" : root.slice(root.lastIndexOf("/") + 1));
    if (typeof name !== "string" || name === "") {
      skipped.push({ file, reason: "declares no usable project name" });
      continue;
    }
    projects.push({ name, root, config });
  }
  return { projects, skipped };
}

/**
 * The graph nodes for a project list, in Nx's shape: `data` is the project's
 * own configuration with `tags` guaranteed present, because `../rules/tags.mjs`
 * reads it unguarded and an absent list is not the same fact as an empty one.
 *
 * @param {{name: string, root: string, config: object}[]} projects
 * @returns {Record<string, object>}
 */
export function buildNodes(projects) {
  const nodes = {};
  for (const { name, root, config } of projects) {
    nodes[name] = {
      name,
      type: nodeTypeOf(name, config.projectType),
      data: { ...config, root, tags: config.tags ?? [] },
    };
  }
  return nodes;
}

/**
 * The dependency map, keyed by source project as Nx keys it.
 *
 * Two kinds of edge, and both are Nx's:
 *
 * - **Import edges**, from the analysis records. A `dynamic` import site
 *   becomes a `dynamic` edge, because `noImportsOfLazyLoadedLibraries` is
 *   decided on exactly that distinction (`../rules/topology.mjs`).
 * - **Implicit edges**, from each project's `implicitDependencies`, expanded
 *   with the SAME matcher Nx uses — reached through `../rules/match.mjs` rather
 *   than reimplemented, so a pattern that resolves one way for a constraint
 *   cannot resolve another way here.
 *
 * @param {{importSites: object[], nodes: Record<string, object>, projectOf: (file: string) => string|undefined}} input
 * @returns {Record<string, {source: string, target: string, type: string}[]>}
 */
export function buildDependencies({ importSites, nodes, projectOf }) {
  const dependencies = {};
  const seen = new Set();
  const add = (source, target, type) => {
    if (!source || !target || source === target) return;
    if (!nodes[target]) return;
    const key = `${source} ${target} ${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    (dependencies[source] ??= []).push({ source, target, type });
  };

  for (const site of importSites) {
    add(
      projectOf(site.sourceFile),
      site.resolved?.target,
      site.kind === "dynamic" ? "dynamic" : "static",
    );
  }
  for (const [name, node] of Object.entries(nodes)) {
    const declared = node.data.implicitDependencies;
    if (!Array.isArray(declared) || declared.length === 0) continue;
    let expanded;
    try {
      expanded = findMatchingProjects(declared, nodes);
    } catch {
      // A pattern the matcher rejects is a project.json problem, and it is the
      // linter's to report. Dropping the edge only ever loses a cycle this
      // server would have found; inventing one would report a cycle that is not
      // there, and a false alarm in an editor is what teaches people to ignore it.
      continue;
    }
    for (const target of expanded) add(name, target, "implicit");
  }
  return dependencies;
}

/**
 * Everything a diagnosis needs about the tree, computed once.
 *
 * The `workspace` object is built ONCE and reused for every analysis, on
 * purpose: `../analysis/source-util.mjs`'s `perWorkspace` cache is keyed on
 * that object's identity, so a fresh object per file would re-read every Go,
 * Cargo and uv manifest in the tree per file analyzed.
 *
 * @param {{root: string, listFiles?: (root: string) => string[], readFileAt?: (root: string, path: string) => string|null}} options
 * @returns {{root: string, files: string[], workspace: object, graph: object, skippedProjects: object[], fileFailures: object[]}}
 * @throws {Error} when the file list cannot be obtained. Loud on purpose: an
 *   index built from no files would put every file in no project, and a file in
 *   no project has no boundary to cross — a clean report, produced by not
 *   looking.
 */
export function buildWorkspaceIndex({
  root,
  listFiles = listWorkspaceFiles,
  readFileAt = readWorkspaceFile,
}) {
  const files = listFiles(root);
  const readFile = (path) => readFileAt(root, path);
  const { projects, skipped } = discoverProjects({ files, readFile });
  const nodes = buildNodes(projects);

  // Longest root wins, for the reason `../analysis/source-util.mjs` gives: a
  // project nested inside another's directory matches both roots, and a
  // first-match answer would attribute every one of its files to its parent.
  const byLongestRoot = [...projects].sort((a, b) => b.root.length - a.root.length);
  const projectOf = (file) =>
    byLongestRoot.find(({ root: r }) => r === "" || file === r || file.startsWith(`${r}/`))?.name;

  const filesByProject = new Map(projects.map(({ name }) => [name, []]));
  for (const file of files) {
    const owner = projectOf(file);
    if (owner !== undefined) filesByProject.get(owner).push(file);
  }

  const workspace = {
    root,
    projects: projects.map(({ name, root: projectRoot }) => ({ name, root: projectRoot })),
    filesOf: (name) => filesByProject.get(name) ?? [],
    readFile,
  };

  const importSites = [];
  const fileFailures = [];
  for (const file of files) {
    if (languageOf(file) === null) continue;
    const text = readFile(file);
    if (text === null) {
      fileFailures.push({ sourceFile: file, reason: "could not be read" });
      continue;
    }
    try {
      importSites.push(...analyzeFile({ sourceFile: file, text, workspace }).imports);
    } catch (cause) {
      // `analyzeFile` throws for a language whose analyzer is not written yet.
      // Recorded rather than rethrown: one unimplemented language must not cost
      // the whole graph, and the document-level diagnosis re-analyzes the open
      // file itself, where the same throw becomes a diagnostic the reader sees.
      fileFailures.push({ sourceFile: file, reason: cause?.message ?? String(cause) });
    }
  }

  return {
    root,
    files,
    workspace,
    graph: { nodes, dependencies: buildDependencies({ importSites, nodes, projectOf }) },
    skippedProjects: skipped,
    fileFailures,
  };
}

/**
 * What the index could not read, as sentences a reader can act on — empty when
 * the tree was read whole.
 *
 * ## Why a gap is reported to EVERY document and not to a chosen few
 *
 * The obvious economy is to tell only the documents a gap can plausibly reach:
 * the files inside the project that vanished, the imports that pointed at it.
 * It is not sound. Two of the fifteen rules are decided on the transitive
 * closure of the graph — `noCircularDependencies`, and the upstream half of
 * `notDependOnLibsWithTags` — and `../rules/reachability.mjs` builds that
 * closure over every node. A project missing from `nodes` also silently drops
 * every edge that pointed at it (`buildDependencies` refuses an edge to a node
 * it does not have), and a file recorded in `fileFailures` was never analyzed,
 * so it contributed none. Either one moves the closure for projects that are
 * nowhere near the file that broke. Deciding a document is unaffected would
 * mean recomputing its verdict against the complete graph — which is the thing
 * that could not be built.
 *
 * ## Why saying it everywhere is still not noise
 *
 * Not because the audience is narrow, but because of what is said and when:
 *
 * - **One diagnostic, never one per gap.** Every gap folds into a single
 *   warning with a bounded list (`./diagnostics.mjs`), so the marker count does
 *   not scale with the breakage.
 * - **It exists only while Nx is broken too.** `project.json` is parsed the way
 *   Nx parses it, so a skipped project is a file `nx graph` also refuses — a
 *   state a developer is walking out of, not one they work in.
 * - **It clears itself.** `project.json` is already a watched file
 *   (`./server.mjs`), so the fix republishes every open document without any
 *   editor action.
 *
 * Each sentence names a path, so the diagnostic says which file to open.
 *
 * @param {{skippedProjects?: {file: string, reason: string}[], fileFailures?: {sourceFile: string, reason: string}[]}} index
 * @returns {string[]}
 */
export function indexGaps({ skippedProjects = [], fileFailures = [] } = {}) {
  return [
    ...skippedProjects.map(
      ({ file, reason }) =>
        `${file} ${firstLine(reason)}, so that project is missing from the graph entirely`,
    ),
    ...fileFailures.map(
      ({ sourceFile, reason }) =>
        `${sourceFile} could not be analyzed (${firstLine(reason)}), so the imports it makes are ` +
        `missing from the graph`,
    ),
  ];
}

/**
 * The first line of a recorded reason.
 *
 * Nx's parse errors carry a multi-line code frame after their first line, and
 * that frame is decoration around a fact the first line already states — the
 * `line:column` of the offending character. A diagnostic message that opens an
 * ASCII drawing mid-sentence is read as noise, which is the one thing this
 * report cannot afford to be. The full text stays in the index's own records.
 */
const firstLine = (reason) => String(reason).split("\n")[0].trimEnd();

/**
 * Workspace-relative read; `null` for a file that is absent or unreadable.
 *
 * The contract's own reader shape (`../analysis/contract.md`): `null` rather
 * than a throw, because an analyzer treats a file it cannot read as a failure
 * record and one such file must not blank a whole run.
 *
 * @param {string} root Absolute workspace root.
 * @param {string} path Workspace-relative.
 * @returns {string|null}
 */
export function readWorkspaceFile(root, path) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}
