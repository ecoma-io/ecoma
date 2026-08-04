import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkProjectConventions, findConventionViolations } from "./check-project-conventions.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

/**
 * In-memory repo: path → content. Tracked set = the map's keys. A path with no
 * entry reads back as `null`, matching the production reader's contract for an
 * unreadable path (never `undefined`), so an omitted key exercises the same
 * "missing from disk" state a real deleted file produces.
 */
const judge = (files) => findConventionViolations(Object.keys(files), (p) => files[p] ?? null);

// Both helpers default to the SUL terms every non-carve-out path implies, so a
// case that is not about licensing stays about the one thing it names.
const project = (tags, targets) =>
  JSON.stringify({
    tags: tags.some((t) => t.startsWith("license:")) ? tags : [...tags, "license:sul"],
    ...(targets ? { targets } : {}),
  });
const pkg = (fields) =>
  JSON.stringify({ private: true, license: "LicenseRef-Ecoma-SustainableUse-1.0", ...fields });
const tsconfig = (paths) => JSON.stringify({ compilerOptions: { paths } });

/**
 * A vitest config in the shape every project's carries: the floor read from the
 * repo-root config, coverage on, no per-metric number of its own. Each option
 * reopens exactly one of the seams the gate closes, so a case names the single
 * state it is about.
 */
const vitestConfig = ({
  passWithNoTests = false,
  coverageEnabled = true,
  overrideBranchesTo,
} = {}) =>
  [
    'const { thresholds } = createRequire(import.meta.url)("../../../coverage.config.json");',
    "export default defineConfig({",
    "  test: {",
    ...(passWithNoTests ? ["    passWithNoTests: true,"] : []),
    "    coverage: {",
    `      enabled: ${coverageEnabled},`,
    overrideBranchesTo === undefined
      ? "      thresholds,"
      : `      thresholds: { ...thresholds, branches: ${overrideBranchesTo} },`,
    "    },",
    "  },",
    "});",
  ].join("\n");

/**
 * A `test` target in the shape a project on Node's built-in runner carries.
 * The command is spelled out per case, because what the gate judges IS the
 * command — the delegation to dev-cli's floor-reading runner, or its absence.
 */
const nodeTestTarget = (command) => ({
  test: { executor: "nx:run-commands", options: { command } },
});

/** A minimal healthy workspace every case below starts from. */
const HEALTHY = {
  "package.json": pkg({ name: "@ecoma-io/ecoma" }),
  LICENSE: "Sustainable Use License, version 1.0, Ecoma edition",
  "vider/libs/vider-ui/project.json": project(["type:lib", "scope:vider", "layer:view"]),
  "vider/libs/vider-ui/package.json": pkg({ name: "@ecoma-io/vider-ui" }),
  "vider/libs/vider-ui/src/index.ts": "export {};",
  "vider/apps/vider-e2e/project.json": project(["type:e2e", "scope:vider"]),
  "vider/apps/vider-e2e/src/app.e2e.test.ts": "test",
  "tsconfig.base.json": tsconfig({ "@ecoma-io/vider-ui": ["vider/libs/vider-ui/src/index.ts"] }),
};

/**
 * `HEALTHY` re-declared as a tree whose LICENSE grants nothing: root manifest,
 * nested manifests AND project tags all move together. They have to — the tree's
 * licence is now the first question every one of those rules asks, so a fixture
 * that moved only the root would be describing a workspace that cannot exist.
 */
const closedTree = (license) => ({
  ...HEALTHY,
  LICENSE: license,
  "package.json": pkg({ name: "@ecoma-io/ecoma-cloud", license: "UNLICENSED" }),
  "vider/libs/vider-ui/package.json": pkg({ name: "@ecoma-io/vider-ui", license: "UNLICENSED" }),
  "vider/libs/vider-ui/project.json": project([
    "type:lib",
    "scope:vider",
    "layer:view",
    "license:proprietary",
  ]),
  "vider/apps/vider-e2e/project.json": project(["type:e2e", "scope:vider", "license:proprietary"]),
});

describe("findConventionViolations", () => {
  it("passes a workspace that honors every convention", () => {
    expect(judge(HEALTHY)).toEqual([]);
  });

  it("flags a scope tag that contradicts the project's top-level directory", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/rogue/project.json": project(["type:lib", "scope:shared"]),
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("'scope:shared' does not match top-level directory 'vider'"),
    ]);
  });

  it("flags a project.json with no scope tag at all", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/unscoped/project.json": project(["type:lib"]),
    };
    expect(judge(files)).toEqual([
      expect.stringContaining(
        "vider/libs/unscoped/project.json: no 'scope:*' tag — expected 'scope:vider'",
      ),
    ]);
  });

  it("flags a project.json with no type tag at all", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/untyped/project.json": project(["scope:vider"]),
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("vider/libs/untyped/project.json: no 'type:*' tag"),
    ]);
  });

  it("flags an e2e test co-located outside a type:e2e project", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/src/thing.e2e.test.ts": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("vider/libs/vider-ui/src/thing.e2e.test.ts: e2e tests live only"),
    ]);
  });

  it("flags a co-located e2e test named the Go/Python way", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/src/thing_e2e_test.go": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("vider/libs/vider-ui/src/thing_e2e_test.go: e2e tests live only"),
    ]);
  });

  it("flags a co-located e2e test whose whole suite is one bare e2e_test file", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/src/e2e_test.go": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("vider/libs/vider-ui/src/e2e_test.go: e2e tests live only"),
    ]);
  });

  it("flags a pytest empty-suite mask left in place after the project grew real tests", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/conftest.py": "if exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED:",
      "vider/libs/vider-ui/src/thing_test.py": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("vider/libs/vider-ui/conftest.py: masks pytest's"),
    ]);
  });

  it("leaves the pytest empty-suite mask alone while the project still has no tests", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/conftest.py": "if exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED:",
    };
    expect(judge(files)).toEqual([]);
  });

  it("flags a vitest empty-suite flag left in place after the project grew real tests", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/vitest.config.ts": vitestConfig({ passWithNoTests: true }),
      "vider/libs/vider-ui/src/thing.test.ts": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining(
        "vider/libs/vider-ui/vitest.config.ts: keeps 'passWithNoTests: true'",
      ),
    ]);
  });

  it("flags a vitest config that never reads the workspace coverage floor", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/vitest.config.ts": 'export default { test: { environment: "node" } };',
      "vider/libs/vider-ui/src/thing.test.ts": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining(
        "vider/libs/vider-ui/vitest.config.ts: vider/libs/vider-ui has tests but this config " +
          "does not hold the workspace coverage floor",
      ),
    ]);
  });

  it("flags a vitest config that reads the shared floor and then overrides a metric downward", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/vitest.config.ts": vitestConfig({ overrideBranchesTo: 10 }),
      "vider/libs/vider-ui/src/thing.test.ts": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("does not hold the workspace coverage floor"),
    ]);
  });

  it("flags a vitest config that reads the shared floor with coverage still switched off", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/vitest.config.ts": vitestConfig({ coverageEnabled: false }),
      "vider/libs/vider-ui/src/thing.test.ts": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("does not hold the workspace coverage floor"),
    ]);
  });

  it("leaves both vitest seam halves alone while the project still has no tests", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/vitest.config.ts": vitestConfig({
        passWithNoTests: true,
        coverageEnabled: false,
      }),
    };
    expect(judge(files)).toEqual([]);
  });

  it("reads the vitest seam from a config in either module spelling", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/vitest.config.mjs": vitestConfig({ passWithNoTests: true }),
      "vider/libs/vider-ui/src/thing.integration.test.mjs": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("vider/libs/vider-ui/vitest.config.mjs: keeps 'passWithNoTests"),
    ]);
  });

  it("flags a project whose Node test runner is not held to the workspace coverage floor", () => {
    const files = {
      ...HEALTHY,
      "vider/tools/rules/project.json": project(
        ["type:lib", "scope:vider"],
        nodeTestTarget("node --test *.test.mjs"),
      ),
      "vider/tools/rules/thing.test.mjs": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining(
        "vider/tools/rules/project.json: vider/tools/rules has tests but nothing holds them " +
          "to the workspace coverage floor",
      ),
    ]);
  });

  it("flags coverage thresholds restated in a target instead of read from the shared floor", () => {
    // The failure this rule is really about: the numbers are enforced, so the
    // suite is red at the right bar today — and the floor now lives in two
    // places, so the next edit to the shared one silently misses this project.
    const files = {
      ...HEALTHY,
      "vider/tools/rules/project.json": project(
        ["type:lib", "scope:vider"],
        nodeTestTarget(
          "node --test --experimental-test-coverage --test-coverage-lines=80 " +
            "--test-coverage-branches=80 --test-coverage-functions=80 *.test.mjs",
        ),
      ),
      "vider/tools/rules/thing.test.mjs": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("nothing holds them to the workspace coverage floor"),
    ]);
  });

  it("flags a project whose tests no target runs at all", () => {
    const files = {
      ...HEALTHY,
      "vider/tools/rules/project.json": project(["type:lib", "scope:vider"]),
      "vider/tools/rules/thing.test.mjs": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("nothing holds them to the workspace coverage floor"),
    ]);
  });

  it("passes a target that delegates its Node test run to the shared floor runner", () => {
    const files = {
      ...HEALTHY,
      "vider/tools/rules/project.json": project(
        ["type:lib", "scope:vider"],
        nodeTestTarget(
          "node ../../../shared/tools/dev-cli/src/main.mjs run-node-tests " +
            "--test-coverage-exclude=*.test.mjs *.test.mjs",
        ),
      ),
      "vider/tools/rules/thing.test.mjs": "test",
    };
    expect(judge(files)).toEqual([]);
  });

  it("reads the delegation from either run-commands shape", () => {
    // `options.commands` — as bare strings and as `{ command }` records — is as
    // valid a spelling as `options.command`, so a rule keyed on one of them
    // would fail a compliant project for its author's formatting choice.
    const delegation = "node ../../../shared/tools/dev-cli/src/main.mjs run-node-tests *.test.mjs";
    for (const commands of [[delegation], [{ command: delegation }]]) {
      const files = {
        ...HEALTHY,
        "vider/tools/rules/project.json": project(["type:lib", "scope:vider"], {
          test: { executor: "nx:run-commands", options: { commands } },
        }),
        "vider/tools/rules/thing.test.mjs": "test",
      };
      expect(judge(files)).toEqual([]);
    }
  });

  it("leaves an e2e project out of the coverage floor it has no module graph to measure", () => {
    // Playwright specs match the same `.test.ts` suffix, but an e2e suite drives
    // a built app in a browser — demanding a coverage runner here would be a
    // floor over nothing.
    const files = {
      ...HEALTHY,
      "vider/apps/vider-e2e/src/second.e2e.test.ts": "test",
    };
    expect(judge(files)).toEqual([]);
  });

  it("passes a unit or integration test whose name merely contains the e2e tier's neighbours", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/project.json": project(
        ["type:lib", "scope:vider", "layer:view"],
        nodeTestTarget("node ../../../shared/tools/dev-cli/src/main.mjs run-go-tests"),
      ),
      "vider/libs/vider-ui/src/thing_test.go": "test",
      "vider/libs/vider-ui/src/thing_integration_test.go": "test",
      "vider/libs/vider-ui/src/thing_test.py": "test",
    };
    expect(judge(files)).toEqual([]);
  });

  it("flags a project with Go tests whose test target never reads the coverage floor", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/project.json": project(
        ["type:lib", "scope:vider", "layer:view"],
        nodeTestTarget("go test ./..."),
      ),
      "vider/libs/vider-ui/src/thing_test.go": "test",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining(
        "has Go tests but nothing holds them to the workspace coverage floor",
      ),
    ]);
  });

  it("leaves the e2e Go tier out of the coverage floor, like the JS tier", () => {
    const files = {
      ...HEALTHY,
      "vider/apps/vider-e2e/src/flow_e2e_test.go": "test",
    };
    expect(judge(files)).toEqual([]);
  });

  it("flags an alias whose target file does not exist at all", () => {
    const files = { ...HEALTHY };
    delete files["vider/libs/vider-ui/src/index.ts"];
    expect(judge(files)).toEqual([
      expect.stringContaining("alias '@ecoma-io/vider-ui' points at missing file"),
    ]);
  });

  it("flags an alias whose target is tracked in git but deleted from the working tree", () => {
    // The index still lists the path, but the reader can no longer read it —
    // the exact state deleting a tracked file leaves behind.
    const files = { ...HEALTHY, "vider/libs/vider-ui/src/index.ts": null };
    expect(judge(files)).toEqual([
      expect.stringContaining("alias '@ecoma-io/vider-ui' points at missing file"),
    ]);
  });

  it("passes an alias whose target exists on disk but is not yet tracked (freshly scaffolded)", () => {
    const trackedFiles = Object.keys(HEALTHY).filter(
      (p) => p !== "vider/libs/vider-ui/src/index.ts",
    );
    const readFile = (p) => HEALTHY[p] ?? null;
    expect(findConventionViolations(trackedFiles, readFile)).toEqual([]);
  });

  it("flags an aliased lib whose manifest name, privacy, or dep fields break the contract", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/package.json": JSON.stringify({
        name: "@ecoma-io/other",
        private: false,
        dependencies: { left: "1.0.0" },
      }),
    };
    const violations = judge(files);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("name '@ecoma-io/other' does not match its alias"),
        expect.stringContaining('must declare "private": true'),
        expect.stringContaining("declares 'dependencies'"),
      ]),
    );
  });

  it("flags a type:lib manifest with an @ecoma-io name but no base alias", () => {
    const files = {
      ...HEALTHY,
      "shared/libs/hash/project.json": project(["type:lib", "scope:shared", "layer:util"]),
      "shared/libs/hash/package.json": pkg({ name: "@ecoma-io/hash" }),
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("'@ecoma-io/hash' has no @ecoma-io base alias"),
    ]);
  });

  it("exempts a publishable manifest (private: false) from alias pairing", () => {
    // A unit declared publishable is resolved through a registry, not the
    // graph — an alias for it would be wiring nobody imports through.
    const files = {
      ...HEALTHY,
      "shared/libs/hash/project.json": project(["type:lib", "scope:shared", "layer:util"]),
      "shared/libs/hash/package.json": JSON.stringify({
        name: "@ecoma-io/hash",
        private: false,
        license: "LicenseRef-Ecoma-SustainableUse-1.0",
        bin: { hash: "src/main.mjs" },
      }),
    };
    expect(judge(files)).toEqual([]);
  });

  it("exempts path-invoked tools: a type:lib without a package.json is fine", () => {
    const files = {
      ...HEALTHY,
      "shared/tools/dev-cli/project.json": project(["type:lib", "scope:shared"]),
    };
    expect(judge(files)).toEqual([]);
  });

  it("leaves malformed JSON to lint rather than crashing or judging it", () => {
    const files = { ...HEALTHY, "vider/libs/broken/project.json": "{not json" };
    expect(judge(files)).toEqual([]);
  });

  it("flags a project.json with no license tag at all", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/unlicensed/project.json": JSON.stringify({
        tags: ["type:lib", "scope:vider"],
      }),
    };
    expect(judge(files)).toEqual([
      expect.stringContaining(
        "vider/libs/unlicensed/project.json: no 'license:*' tag — expected 'license:sul'",
      ),
    ]);
  });

  it("flags a carve-out module tagged as if it took the tree's own terms", () => {
    const files = {
      ...HEALTHY,
      "vider/packages/LICENSE": "Apache License 2.0",
      "vider/packages/driver-api/project.json": project(["type:lib", "scope:vider", "license:sul"]),
      "vider/packages/driver-api/src/index.ts": "export {};",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("'license:sul' does not match the terms its path implies"),
    ]);
  });

  it("flags a plug-in package tagged as if it ran the system", () => {
    const files = {
      ...HEALTHY,
      "vider/packages/LICENSE": "Apache License 2.0",
      "vider/packages/driver-api/project.json": project(["type:lib", "scope:vider", "license:sul"]),
      "vider/packages/driver-api/src/index.ts": "export {};",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("'license:sul' does not match the terms its path implies"),
    ]);
  });

  it("flags a carve-out directory that ships no terms of its own", () => {
    const files = {
      ...HEALTHY,
      "vider/packages/driver-api/project.json": project([
        "type:lib",
        "scope:vider",
        "license:apache",
      ]),
      "vider/packages/driver-api/src/index.ts": "export {};",
    };
    expect(judge(files)).toEqual([expect.stringContaining("vider/packages/LICENSE: missing")]);
  });

  it("accepts carve-out directories that declare their own terms throughout", () => {
    const files = {
      ...HEALTHY,
      "vider/packages/LICENSE": "Apache License 2.0",
      "vider/packages/driver-api/project.json": project([
        "type:lib",
        "scope:vider",
        "license:apache",
      ]),
      "vider/packages/driver-api/src/index.ts": "export {};",
    };
    expect(judge(files)).toEqual([]);
  });

  it("flags a manifest that states no licence at all", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/package.json": JSON.stringify({
        private: true,
        name: "@ecoma-io/vider-ui",
      }),
    };
    expect(judge(files)).toEqual([
      expect.stringContaining('"license" is null, expected "LicenseRef-Ecoma-SustainableUse-1.0"'),
    ]);
  });

  it("flags a manifest claiming OSI terms the tree does not grant", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/package.json": pkg({ name: "@ecoma-io/vider-ui", license: "MIT" }),
    };
    expect(judge(files)).toEqual([
      expect.stringContaining('"license" is "MIT", expected "LicenseRef-Ecoma-SustainableUse-1.0"'),
    ]);
  });

  it("derives the root manifest's terms from the LICENSE the tree ships", () => {
    // The downstream geometry: the private cloud workspace consumes this gate
    // with an all-rights-reserved root, so EVERY manifest in it is UNLICENSED —
    // not only the root one. Until the tree's licence became the first question
    // asked, a nested manifest here was judged by a path map that answered
    // `sul`, and this fixture passed while declaring terms the tree does not
    // grant.
    expect(
      judge(closedTree("Copyright (c) 2026 the ecoma project owner. All rights reserved.")),
    ).toEqual([]);
  });

  it("a LICENSE that merely mentions the SUL by name does not reclassify the tree", () => {
    const license =
      "Copyright (c) 2026. All rights reserved.\n" +
      "This is not the Sustainable Use License; no licence is granted.";
    expect(judge(closedTree(license))).toEqual([]);
  });

  it("flags a root manifest hiding behind UNLICENSED in a tree whose LICENSE grants SUL", () => {
    const files = {
      ...HEALTHY,
      "package.json": pkg({ name: "@ecoma-io/ecoma", license: "UNLICENSED" }),
    };
    expect(judge(files)).toEqual([
      expect.stringContaining(
        '"license" is "UNLICENSED", expected "LicenseRef-Ecoma-SustainableUse-1.0"',
      ),
    ]);
  });

  it("flags a workspace whose root licence is gone", () => {
    const files = { ...HEALTHY };
    delete files.LICENSE;
    expect(judge(files)).toEqual([expect.stringContaining("LICENSE: missing or empty")]);
  });

  it("flags a root licence that exists but says nothing", () => {
    expect(judge({ ...HEALTHY, LICENSE: "   \n" })).toEqual([
      expect.stringContaining("LICENSE: missing or empty"),
    ]);
  });

  it("flags a carve-out whose licence file does not name the terms promised there", () => {
    // Existence alone let a zero-byte file pass — and, worse, let the SUL text
    // itself sit in a directory whose entire purpose is to not be under it.
    const files = {
      ...HEALTHY,
      "vider/packages/LICENSE": "Sustainable Use License, version 1.0, Ecoma edition",
      "vider/packages/driver-api/project.json": project([
        "type:lib",
        "scope:vider",
        "license:apache",
      ]),
      "vider/packages/driver-api/src/index.ts": "export {};",
    };
    expect(judge(files)).toEqual([
      expect.stringContaining(
        "does not name the 'Apache License' the root LICENSE says ships here",
      ),
    ]);
  });

  it("flags an empty carve-out licence file", () => {
    const files = {
      ...HEALTHY,
      "vider/packages/LICENSE": "",
      "vider/packages/driver-api/project.json": project([
        "type:lib",
        "scope:vider",
        "license:apache",
      ]),
      "vider/packages/driver-api/src/index.ts": "export {};",
    };
    expect(judge(files)).toEqual([expect.stringContaining("does not name the 'Apache License'")]);
  });

  it("carves nothing out of a tree that grants nothing, whatever a directory is called", () => {
    // The precedence that let the licence map stop hard-coding one directory
    // name as proprietary. A `packages` directory in an unpublished tree is not
    // an Apache grant — that tree has published no source to grant — so the gate
    // must neither expect an Apache LICENSE beside it nor an `apache` tag on it.
    const files = {
      ...closedTree("Copyright (c) 2026. All rights reserved."),
      "vider/packages/driver-api/project.json": project([
        "type:lib",
        "scope:vider",
        "license:proprietary",
      ]),
      "vider/packages/driver-api/package.json": pkg({
        name: "@ecoma-io/driver-api",
        license: "UNLICENSED",
      }),
      "vider/packages/driver-api/src/index.ts": "export {};",
      "tsconfig.base.json": tsconfig({
        "@ecoma-io/vider-ui": ["vider/libs/vider-ui/src/index.ts"],
        "@ecoma-io/driver-api": ["vider/packages/driver-api/src/index.ts"],
      }),
    };
    expect(judge(files)).toEqual([]);
  });

  it("accepts a package's copy of the root LICENSE when it matches byte for byte", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/LICENSE": HEALTHY.LICENSE,
    };
    expect(judge(files)).toEqual([]);
  });

  it("flags a package's copy of the root LICENSE once it has drifted", () => {
    // The real failure this covers: retiring a tier from the root LICENSE left
    // a publishable package shipping the old text, so its tarball granted terms
    // the project had withdrawn — to everyone who installed it. npm resolves
    // nothing across package boundaries, so the copy must exist; what it must
    // not be is unchecked.
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/LICENSE": `${HEALTHY.LICENSE}\n\nAlso: an enterprise directory is unlicensed.`,
    };
    expect(judge(files)).toEqual([
      expect.stringContaining("vider/libs/vider-ui/LICENSE: differs from the root LICENSE"),
    ]);
  });

  it("leaves a carve-out's own LICENSE to the rule that judges its terms", () => {
    // A `packages` directory ships the Apache text, which is SUPPOSED to differ
    // from the root. Judging it by the copy rule would demand the two be equal
    // and make the carve-out impossible to satisfy.
    const files = {
      ...HEALTHY,
      "vider/packages/LICENSE": "Apache License 2.0",
      "vider/packages/driver-api/project.json": project([
        "type:lib",
        "scope:vider",
        "license:apache",
      ]),
      "vider/packages/driver-api/src/index.ts": "export {};",
    };
    expect(judge(files)).toEqual([]);
  });

  it("holds the workspace-root manifest to the same derivation", () => {
    const files = { ...HEALTHY, "package.json": JSON.stringify({ private: true }) };
    expect(judge(files)).toEqual([expect.stringContaining('package.json: "license" is null')]);
  });
});

describe("checkProjectConventions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails loudly against the git index, naming each violation", () => {
    const files = {
      "vider/libs/rogue/project.json": project(["type:lib", "scope:shared"]),
    };
    vi.mocked(execFileSync).mockReturnValue(`${Object.keys(files).join("\n")}\n`);
    vi.mocked(readFileSync).mockImplementation((p) => files[p]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkProjectConventions()).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("does not match top-level directory"),
    );
  });

  it("passes an empty index", () => {
    vi.mocked(execFileSync).mockReturnValue("\n");
    expect(checkProjectConventions()).toBe(0);
  });
});
