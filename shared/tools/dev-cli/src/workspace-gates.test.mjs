import { describe, expect, it, vi } from "vitest";

vi.mock("./check-claude-md.mjs", () => ({ checkClaudeMd: vi.fn(() => 0) }));
vi.mock("./check-command-refs.mjs", () => ({ checkCommandRefs: vi.fn(() => 0) }));
vi.mock("./check-doc-links.mjs", () => ({ checkDocLinks: vi.fn(() => 0) }));
vi.mock("./check-doctrine.mjs", () => ({ checkDoctrine: vi.fn(() => 0) }));
vi.mock("./check-journey-markers.mjs", () => ({ checkWorkspaceDocs: vi.fn(() => 0) }));
vi.mock("./check-practice-index.mjs", () => ({ checkPracticeIndex: vi.fn(() => 0) }));
vi.mock("./check-project-conventions.mjs", () => ({ checkProjectConventions: vi.fn(() => 0) }));
vi.mock("./check-roadmap-ids.mjs", () => ({ checkRoadmapIds: vi.fn(() => 0) }));
vi.mock("./check-subproject-readmes.mjs", () => ({ checkSubprojectReadmes: vi.fn(() => 0) }));
vi.mock("./check-subsystem-readmes.mjs", () => ({ checkSubsystemReadmes: vi.fn(() => 0) }));
vi.mock("./conformance.mjs", () => ({ conformance: vi.fn(() => 0) }));

import { checkClaudeMd } from "./check-claude-md.mjs";
import { checkCommandRefs } from "./check-command-refs.mjs";
import { checkDocLinks } from "./check-doc-links.mjs";
import { checkDoctrine } from "./check-doctrine.mjs";
import { checkWorkspaceDocs } from "./check-journey-markers.mjs";
import { checkPracticeIndex } from "./check-practice-index.mjs";
import { checkProjectConventions } from "./check-project-conventions.mjs";
import { checkRoadmapIds } from "./check-roadmap-ids.mjs";
import { checkSubprojectReadmes } from "./check-subproject-readmes.mjs";
import { checkSubsystemReadmes } from "./check-subsystem-readmes.mjs";
import { conformance } from "./conformance.mjs";
import { WORKSPACE_GATES, workspaceGates } from "./workspace-gates.mjs";

function harness(gates) {
  const lines = [];
  const groups = [];
  const code = workspaceGates({
    gates,
    log: (line) => lines.push(line),
    group: { open: (name) => groups.push(`open:${name}`), close: () => groups.push("close") },
  });
  return { code, lines, groups };
}

describe("running the gate list", () => {
  it("returns 0 only when every gate did", () => {
    const { code, lines } = harness([
      ["a", () => 0],
      ["b", () => 0],
    ]);
    expect(code).toBe(0);
    expect(lines.at(-1)).toContain("all 2 gates green");
  });

  it("keeps running after a red gate, so one run names the whole bill", () => {
    const later = vi.fn(() => 0);
    const { code, lines } = harness([
      ["red", () => 1],
      ["later", later],
    ]);
    expect(code).toBe(1);
    expect(later).toHaveBeenCalled();
    expect(lines.at(-1)).toContain("1 of 2 gates failed: red");
  });

  it("treats a gate that returns nothing as green, matching the CLI's own exit contract", () => {
    expect(harness([["quiet", () => undefined]]).code).toBe(0);
  });

  it("counts a throwing gate as failed rather than crashing the run, and still reports the rest", () => {
    const { code, lines } = harness([
      [
        "thrower",
        () => {
          throw new Error("gate exploded");
        },
      ],
      ["fine", () => 0],
    ]);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("gate exploded");
    expect(lines.at(-1)).toContain("failed: thrower");
  });

  it("names every failing gate in the summary, not just the first", () => {
    const { lines } = harness([
      ["one", () => 1],
      ["two", () => 1],
    ]);
    expect(lines.at(-1)).toContain("failed: one, two");
  });

  it("opens and closes a group around each gate, so a CI log folds per gate", () => {
    const { groups } = harness([
      ["a", () => 0],
      ["b", () => 1],
    ]);
    expect(groups).toEqual(["open:a", "close", "open:b", "close"]);
  });
});

describe("the default output seam", () => {
  it("emits GitHub Actions folding directives only under Actions, plain headers elsewhere", () => {
    const run = (inActions) => {
      const previous = process.env.GITHUB_ACTIONS;
      process.env.GITHUB_ACTIONS = inActions ? "true" : "";
      const lines = [];
      workspaceGates({ gates: [["a", () => 0]], log: (line) => lines.push(line) });
      if (previous === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = previous;
      return lines;
    };
    expect(run(true)).toContain("::group::a");
    expect(run(true)).toContain("::endgroup::");
    expect(run(false).join("\n")).not.toContain("::group::");
  });
});

describe("the list itself", () => {
  it("pairs every entry as a re-runnable command name and a thunk", () => {
    for (const entry of WORKSPACE_GATES) {
      expect(entry).toHaveLength(2);
      expect(entry[0]).toMatch(/^[a-z][a-z-]*$/);
      expect(typeof entry[1]).toBe("function");
    }
  });

  it("keeps conformance in the list, the gate a name-shaped derivation once lost", () => {
    expect(WORKSPACE_GATES.map(([name]) => name)).toContain("conformance");
  });

  it("pairs each name with the gate that name means, so a red line can be re-run by it", () => {
    const expected = {
      conformance: conformance,
      "check-journey-markers-workspace": checkWorkspaceDocs,
      "check-doc-links": checkDocLinks,
      "check-command-refs": checkCommandRefs,
      "check-claude-md": checkClaudeMd,
      "check-doctrine": checkDoctrine,
      "check-roadmap-ids": checkRoadmapIds,
      "check-practice-index": checkPracticeIndex,
      "check-subsystem-readmes": checkSubsystemReadmes,
      "check-subproject-readmes": checkSubprojectReadmes,
      "check-project-conventions": checkProjectConventions,
    };
    expect(WORKSPACE_GATES.map(([name]) => name).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, run] of WORKSPACE_GATES) {
      expected[name].mockClear();
      expect(run()).toBe(0);
      expect(expected[name], `'${name}' did not invoke its own gate`).toHaveBeenCalledTimes(1);
    }
  });

  it("hands conformance an empty argument list, the report-only mode CI runs", () => {
    conformance.mockClear();
    WORKSPACE_GATES.find(([name]) => name === "conformance")[1]();
    expect(conformance).toHaveBeenCalledWith([]);
  });
});
