import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkProjectConventions, findConventionViolations } from "./check-project-conventions.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));

/** In-memory repo: path → content. Tracked set = the map's keys. */
const judge = (files) => findConventionViolations(Object.keys(files), (p) => files[p]);

const project = (tags) => JSON.stringify({ tags });
const pkg = (fields) => JSON.stringify({ private: true, ...fields });
const tsconfig = (paths) => JSON.stringify({ compilerOptions: { paths } });

/** A minimal healthy workspace every case below starts from. */
const HEALTHY = {
  "vider/libs/vider-ui/project.json": project(["type:lib", "scope:vider", "layer:view"]),
  "vider/libs/vider-ui/package.json": pkg({ name: "@ecoma-io/vider-ui" }),
  "vider/libs/vider-ui/src/index.ts": "export {};",
  "vider/apps/vider-e2e/project.json": project(["type:e2e", "scope:vider"]),
  "vider/apps/vider-e2e/src/app.e2e.test.ts": "test",
  "tsconfig.base.json": tsconfig({ "@ecoma-io/vider-ui": ["vider/libs/vider-ui/src/index.ts"] }),
};

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

  it("passes a unit or integration test whose name merely contains the e2e tier's neighbours", () => {
    const files = {
      ...HEALTHY,
      "vider/libs/vider-ui/src/thing_test.go": "test",
      "vider/libs/vider-ui/src/thing_integration_test.go": "test",
      "vider/libs/vider-ui/src/thing_test.py": "test",
    };
    expect(judge(files)).toEqual([]);
  });

  it("flags an alias whose target file is not tracked", () => {
    const files = { ...HEALTHY };
    delete files["vider/libs/vider-ui/src/index.ts"];
    expect(judge(files)).toEqual([
      expect.stringContaining("alias '@ecoma-io/vider-ui' points at missing file"),
    ]);
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
