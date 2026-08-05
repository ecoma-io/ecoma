import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { loadBoundaryConfig, MODULE_BOUNDARIES_CONFIG_FILE } from "./config.mjs";

/**
 * Drives the loader against the real workspace root, which is the whole point
 * of the module: the config it reads is the same file `eslint.config.mjs`
 * imports, so this is the tripwire for the two drifting apart. A constraint row
 * that gains a misspelt field passes ESLint's own schema check only because
 * ESLint would have rejected it — this fails first, here, naming the row.
 */
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("loadBoundaryConfig over the real workspace", () => {
  it("loads the boundary table ESLint reads, and finds it well-formed", async () => {
    const { depConstraints, options } = await loadBoundaryConfig(workspaceRoot);

    expect(depConstraints.length).toBeGreaterThan(0);
    // Every row names a source, or it constrains nothing while reading as a rule.
    for (const row of depConstraints) {
      expect(typeof row.sourceTag === "string" || Array.isArray(row.allSourceTags)).toBe(true);
    }
    // All eight options stated, none guessed — the reason the file exports them
    // at all is that an implicit option is one only ESLint knows the value of.
    expect(Object.keys(options).sort()).toEqual([
      "allow",
      "allowCircularSelfDependency",
      "banTransitiveDependencies",
      "buildTargets",
      "checkDynamicDependenciesExceptions",
      "checkNestedExternalImports",
      "enforceBuildableLibDependency",
      "ignoredCircularDependencies",
    ]);
  });

  it("resolves the config against the tree it is judging, not against its own location", async () => {
    // The tool also runs from a pinned harness clone inside another workspace,
    // where its own directory and the config it must read are in different
    // trees. A loader that walked up from `import.meta.url` would read the
    // harness's copy — the wrong tree's rules — and report green on rules
    // nobody there wrote.
    const elsewhere = mkdtempSync(join(tmpdir(), "polyglot-boundaries-"));
    afterAll(() => rmSync(elsewhere, { recursive: true, force: true }));

    await expect(loadBoundaryConfig(elsewhere)).rejects.toThrow(
      new RegExp(`cannot load ${elsewhere}/${MODULE_BOUNDARIES_CONFIG_FILE}`),
    );
  });
});
