import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const DOCTRINE_OUTPUT = JSON.stringify({
  status: "v0.1",
  systemShape: "3 domains: Platform | RPA | Hub",
  endState: {
    vision: "Ecoma is a fair-code system",
    principles: ["First principle", "Second principle"],
    invariants: ["Invariant one", "Invariant two"],
    primitives: [{ name: "Role", purpose: "A capability slot" }],
    layers: [{ layer: 1, name: "Core engine", contents: "Primitives" }],
  },
  milestones: [{ id: "M0", name: "Backbone", condition: "ICP-independent" }],
  gaps: [{ item: "ICP", kind: "Commercial", reason: "Unconfirmed" }],
  glossary: [{ term: "Role", definition: "a position" }],
});

const NX_OUTPUT = JSON.stringify({
  source: "nx-graph",
  nodes: [{ name: "core-ui", scope: "shared", type: "lib", layer: "view" }],
  groups: { shared: [{ name: "core-ui", scope: "shared" }] },
  groupKeys: ["shared"],
});

const GIT_OUTPUT = JSON.stringify({
  window: { label: "week", focus: "1 week ago" },
  allTime: { totalCommits: 100, firstCommit: "2026-01-01 init", topAuthors: ["John"] },
  contextSpan: { totalCommits: 30, churn: [{ dir: "src", count: 5 }] },
  focusSpan: {
    totalCommits: 10,
    commits: [{ hash: "abc", date: "2026-07-30", subject: "feat", files: ["src/a.mjs"] }],
  },
});

describe("run", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed JSON when the script succeeds", async () => {
    const { run } = await import("./report-builder.mjs");

    vi.mocked(execFileSync).mockReturnValue('{"ok": true}');

    const result = run("test.mjs");
    expect(result).toEqual({ ok: true });
  });

  it("throws with the last line of stderr when the script fails with stderr", async () => {
    const { run } = await import("./report-builder.mjs");

    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error("command failed");
      err.stderr = "line1\nline2\nreal error";
      err.status = 1;
      throw err;
    });

    expect(() => run("failing.mjs")).toThrow("failing.mjs failed: real error");
  });

  it("throws with the exit status when the script fails without stderr", async () => {
    const { run } = await import("./report-builder.mjs");

    vi.mocked(execFileSync).mockImplementation(() => {
      const err = new Error("command failed");
      err.stderr = "";
      err.status = 2;
      throw err;
    });

    expect(() => run("failing.mjs")).toThrow(/failed with status 2/);
  });
});

describe("main report assembly", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("assembles a unified report from all three readers", async () => {
    const { main } = await import("./report-builder.mjs");

    vi.mocked(execFileSync)
      .mockReturnValueOnce(DOCTRINE_OUTPUT)
      .mockReturnValueOnce(NX_OUTPUT)
      .mockReturnValueOnce(GIT_OUTPUT);

    const writes = [];
    vi.spyOn(process.stdout, "write").mockImplementation((data) => {
      writes.push(data);
      return true;
    });

    main();

    expect(writes).toHaveLength(1);
    const report = JSON.parse(writes[0]);

    expect(report.window.label).toBe("week");
    expect(report.targetArchitecture.vision).toBe("Ecoma is a fair-code system");
    expect(report.targetArchitecture.principles).toHaveLength(2);
    expect(report.currentArchitecture.source).toBe("nx-graph");
    expect(report.currentArchitecture.totalProjects).toBe(1);
    expect(report.roadmapProgress.milestones).toHaveLength(1);
    expect(report.roadmapProgress.git.totalCommits).toBe(100);
  });

  it("passes --window arg to git-reader", async () => {
    const { main } = await import("./report-builder.mjs");

    vi.mocked(execFileSync)
      .mockReturnValueOnce(DOCTRINE_OUTPUT)
      .mockReturnValueOnce(NX_OUTPUT)
      .mockReturnValueOnce(GIT_OUTPUT);

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const fakeArgs = ["--window=day"];

    const origArgv = process.argv;
    process.argv = [...origArgv.slice(0, 2), ...fakeArgs];
    try {
      main();
      const gitCall = vi
        .mocked(execFileSync)
        .mock.calls.find(([cmd, args]) => cmd === "node" && args.join(" ").includes("git-reader"));
      expect(gitCall).toBeDefined();
      expect(gitCall[1].join(" ")).toContain("--window=day");
    } finally {
      process.argv = origArgv;
    }
  });

  it("reports empty target architecture when doctrine has no end state", async () => {
    const { main } = await import("./report-builder.mjs");

    vi.mocked(execFileSync)
      .mockReturnValueOnce(JSON.stringify({}))
      .mockReturnValueOnce(NX_OUTPUT)
      .mockReturnValueOnce(GIT_OUTPUT);

    const writes = [];
    vi.spyOn(process.stdout, "write").mockImplementation((data) => {
      writes.push(data);
      return true;
    });

    main();

    const report = JSON.parse(writes[0]);
    expect(report.targetArchitecture.vision).toBe("");
    expect(report.targetArchitecture.principles).toEqual([]);
    expect(report.targetArchitecture.invariants).toEqual([]);
  });
});
