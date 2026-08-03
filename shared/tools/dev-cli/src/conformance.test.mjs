import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildLedger, conformance, findFrozenDocuments, findSuites } from "./conformance.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
import { execFileSync } from "node:child_process";

const GATES = new Set(["◆G0", "◆G1", "◆G2"]);

function reader(files) {
  return (path) => {
    if (!(path in files)) throw new Error(`ENOENT ${path}`);
    return files[path];
  };
}

describe("reading a freeze off the tree", () => {
  const files = {
    "a.md": "---\ntitle: A\nstatus: frozen\ngate: G0\n---\n\n# A\n",
    "b.md": "---\ntitle: B\nstatus: design-end-state\n---\n\n# B\n",
    "c.md": "---\ntitle: C\nstatus: frozen\n---\n\n# C\n",
    "d.md": "no frontmatter at all\n",
  };

  it("finds only the documents that declare themselves frozen", () => {
    const frozen = findFrozenDocuments(Object.keys(files), reader(files));
    expect(frozen.map((f) => f.file)).toEqual(["a.md", "c.md"]);
  });

  it("carries a freeze that names no gate through as ungated, rather than dropping it", () => {
    const frozen = findFrozenDocuments(Object.keys(files), reader(files));
    expect(frozen).toContainEqual({ file: "c.md", gate: null });
  });
});

describe("reading a suite off the project graph", () => {
  const files = {
    "p/project.json": JSON.stringify({
      name: "p",
      tags: ["gate:G0"],
      targets: { conformance: {} },
    }),
    "q/project.json": JSON.stringify({ name: "q", tags: ["type:lib"], targets: { test: {} } }),
    "r/project.json": JSON.stringify({
      name: "r",
      tags: ["type:lib"],
      targets: { conformance: {} },
    }),
    "s/project.json": "{ not json",
  };

  it("counts a project only when it declares the conformance target", () => {
    expect(findSuites(Object.keys(files), reader(files)).map((s) => s.project)).toEqual(["p", "r"]);
  });

  it("carries a suite with no gate tag through as ungated", () => {
    expect(findSuites(Object.keys(files), reader(files))).toContainEqual({
      project: "r",
      gate: null,
      gateTags: [],
    });
  });

  it("skips an unparsable project.json rather than failing the run", () => {
    expect(findSuites(["s/project.json"], reader(files))).toEqual([]);
  });

  it("carries every matching tag through as ungated, rather than serving only the first", () => {
    const multiGateFiles = {
      "t/project.json": JSON.stringify({
        name: "t",
        tags: ["gate:G0", "gate:G1"],
        targets: { conformance: {} },
      }),
    };
    expect(findSuites(Object.keys(multiGateFiles), reader(multiGateFiles))).toContainEqual({
      project: "t",
      gate: null,
      gateTags: ["gate:G0", "gate:G1"],
    });
  });
});

describe("the judgment rule #7 actually makes", () => {
  it("does not fault a gate nobody has started, since nothing has been promised", () => {
    const { rows, faults } = buildLedger(GATES, [], []);
    expect(faults).toEqual([]);
    expect(rows).toHaveLength(3);
  });

  it("faults a frozen gate with no suite, which is the paper gate the rule names", () => {
    const { faults } = buildLedger(GATES, [{ file: "spec/event-log.md", gate: "◆G0" }], []);
    expect(faults).toEqual([
      "◆G0: frozen (spec/event-log.md) with no conformance suite — rule #7: a gate with no suite is a paper gate",
    ]);
  });

  it("passes a frozen gate once a suite arbitrates it", () => {
    const { faults } = buildLedger(
      GATES,
      [{ file: "spec/event-log.md", gate: "◆G0" }],
      [{ project: "event-log-conformance", gate: "◆G0" }],
    );
    expect(faults).toEqual([]);
  });

  it("does not let a suite for one gate cover a freeze on another", () => {
    const { faults } = buildLedger(
      GATES,
      [{ file: "spec/event-log.md", gate: "◆G0" }],
      [{ project: "hub-conformance", gate: "◆G2" }],
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("◆G0");
  });

  it("faults a freeze that names no gate, because it closes nothing", () => {
    const { faults } = buildLedger(GATES, [{ file: "spec/x.md", gate: null }], []);
    expect(faults).toEqual([
      "spec/x.md: declares status: frozen without a gate: — a freeze closes a gate or closes nothing",
    ]);
  });

  it("faults a suite that names no gate, because it arbitrates nothing", () => {
    const { faults } = buildLedger(GATES, [], [{ project: "stray", gate: null }]);
    expect(faults).toEqual([
      "stray: has a 'conformance' target without a gate:G<n> tag — a suite arbitrates a named gate or nothing",
    ]);
  });

  it("faults a suite carrying more than one gate tag, instead of silently serving the first", () => {
    const { faults } = buildLedger(
      GATES,
      [],
      [{ project: "double-gated", gate: null, gateTags: ["gate:G0", "gate:G1"] }],
    );
    expect(faults).toEqual([
      "double-gated: carries 2 gate tags (gate:G0, gate:G1) — a suite arbitrates exactly one gate",
    ]);
  });

  it("orders the ledger by gate, so the report reads in build order", () => {
    const { rows } = buildLedger(new Set(["◆G2", "◆G0", "◆G1"]), [], []);
    expect(rows.map((r) => r.gate)).toEqual(["◆G0", "◆G1", "◆G2"]);
  });
});

describe("the --run branch — the executor half Track R.5 names", () => {
  // conformance() reads the roadmap and the tree through its injected
  // read/list; only the suite execution reaches the real world, so that spawn
  // is the one thing mocked. The reader dispatches on path shape: any .md read
  // is the roadmap's gate table, any project.json read is the suite below.
  const read = (path) =>
    path.endsWith(".md")
      ? "| **G0** | freeze | opens | cost |\n"
      : JSON.stringify({ name: "s", tags: ["gate:G0"], targets: { conformance: {} } });
  const list = (patterns) => (patterns?.[0]?.includes("project.json") ? ["s/project.json"] : []);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    execFileSync.mockReset();
  });

  it("executes every suite in the ledger through Nx's own runner", () => {
    expect(conformance(["--run"], read, list)).toBe(0);
    expect(execFileSync).toHaveBeenCalledWith(
      "pnpm",
      ["nx", "run-many", "-t", "conformance", "-p", "s"],
      { stdio: "inherit" },
    );
  });

  it("returns the failure when a suite run goes red, rather than swallowing it", () => {
    execFileSync.mockImplementation(() => {
      throw new Error("suite failed");
    });
    expect(conformance(["--run"], read, list)).toBe(1);
  });

  it("stays a pure read without --run — no suite is executed", () => {
    expect(conformance([], read, list)).toBe(0);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("does not reach the runner when the ledger itself is faulted", () => {
    const ungatedRead = (path) =>
      path.endsWith(".md")
        ? "| **G0** | freeze | opens | cost |\n"
        : JSON.stringify({ name: "s", targets: { conformance: {} } });
    expect(conformance(["--run"], ungatedRead, list)).toBe(1);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
