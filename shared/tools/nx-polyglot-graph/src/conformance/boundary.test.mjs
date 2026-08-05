/**
 * The constraint that lets this directory exist at all, made checkable.
 *
 * `src/conformance/` imports ESLint and `@nx/eslint-plugin` on purpose — a
 * differential test that stubbed the thing it compares against would prove
 * nothing. The shipped tool must not, and the reason is not tidiness: the whole
 * value of `src/rules/` is being pure over records, and importing the plugin
 * would pull `@nx/devkit` and a project-graph read into it. The project's
 * `CLAUDE.md` states the rule ("Node built-ins, `typescript`, and
 * `vue/compiler-sfc` only") and until now nothing enforced it — which is the
 * shape of rule that gets broken by the next person in a hurry.
 *
 * So this reads the tree and checks it. The file list is derived by walking the
 * project rather than written down, so a module added tomorrow is covered
 * without anyone remembering to add it here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Directories a walk never descends into: installed packages and build output. */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "coverage", "dist"]);

/** Bare specifiers only this directory may name, each because a test needs the real thing. */
const TEST_ONLY_PACKAGES = [
  "eslint",
  "@nx/eslint-plugin",
  "@nx/devkit",
  "@nx/js",
  "nx/",
  "typescript-eslint",
  "vue-eslint-parser",
  "vitest",
  "@fast-check/vitest",
];

/** Every `.mjs` file the project owns, workspace-relative to the project root. */
function projectSources(directory = PROJECT_ROOT) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...projectSources(absolute));
      continue;
    }
    if (entry.endsWith(".mjs")) found.push(relative(PROJECT_ROOT, absolute));
  }
  return found;
}

/** Every module specifier a file imports, whether by `import` or by `require`. */
function specifiersIn(file) {
  const text = readFileSync(join(PROJECT_ROOT, file), "utf8");
  const specifiers = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/gu,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/gu,
    /(?:^|\n)\s*export\s[^;]*?from\s*["']([^"']+)["']/gu,
    /\brequire(?:_)?\(\s*["']([^"']+)["']\s*\)/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

const isTestFile = (file) => file.endsWith(".test.mjs");
const isConformance = (file) => file.startsWith(`src${"/"}conformance/`);
/**
 * The test runner's own configuration is part of the test tier, not of what the
 * tool ships — `package.json`'s `bin` entries are `cli.mjs` and `lsp.mjs`, and
 * neither can reach it.
 */
const isRunnerConfig = (file) => file === "vitest.config.mjs";

describe("what the shipped tool is allowed to depend on", () => {
  const sources = projectSources();

  it("finds the modules it is meant to be checking", () => {
    // A walk that silently returned nothing would make every check below pass.
    expect(sources).toContain("index.mjs");
    expect(sources).toContain(join("src", "rules", "index.mjs"));
    expect(sources.filter(isConformance).length).toBeGreaterThan(3);
  });

  it("keeps ESLint and the Nx plugin out of every module that is not a test", () => {
    const offenders = [];
    for (const file of sources) {
      if (isConformance(file) || isTestFile(file) || isRunnerConfig(file)) continue;
      for (const specifier of specifiersIn(file)) {
        if (TEST_ONLY_PACKAGES.some((name) => specifier === name || specifier.startsWith(name))) {
          offenders.push(`${file} imports '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the conformance suite unreachable from anything the tool ships", () => {
    // The suite is reachable only from its own tests. A shipped module that
    // imported it would drag ESLint into the plugin Nx loads on every graph
    // computation — which is the cost `index.mjs` exists to avoid.
    const offenders = [];
    for (const file of sources) {
      if (isConformance(file)) continue;
      for (const specifier of specifiersIn(file)) {
        if (specifier.includes("conformance")) offenders.push(`${file} imports '${specifier}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports no other project in the workspace, from any module including its tests", () => {
    // Self-contained is what keeps a later extraction cheap, and it is the one
    // constraint that has to hold for the test tier too: a fixture reaching
    // into `dev-cli` would make this project's suite unrunnable outside this
    // repository, which is where the tool also has to work.
    const offenders = [];
    for (const file of sources) {
      for (const specifier of specifiersIn(file)) {
        if (!specifier.startsWith(".")) continue;
        const resolved = join(dirname(file), specifier);
        if (resolved.startsWith("..")) offenders.push(`${file} imports '${specifier}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
