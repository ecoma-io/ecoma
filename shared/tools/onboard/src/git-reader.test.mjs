import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";

import { resolveWindow } from "./git-reader.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

describe("resolveWindow", () => {
  it("returns day focus and context for 'day'", () => {
    expect(resolveWindow("day")).toEqual({
      focus: "1 day ago",
      context: "1 week ago",
      label: "day",
    });
  });

  it("returns week focus and context for 'week'", () => {
    expect(resolveWindow("week")).toEqual({
      focus: "1 week ago",
      context: "1 month ago",
      label: "week",
    });
  });

  it("returns month focus and context for 'month'", () => {
    expect(resolveWindow("month")).toEqual({
      focus: "1 month ago",
      context: "3 months ago",
      label: "month",
    });
  });

  it("parses since=<expr> and sets context to 3 months ago", () => {
    expect(resolveWindow("since=2026-06-01")).toEqual({
      focus: "2026-06-01",
      context: "3 months ago",
      label: "since=2026-06-01",
    });
  });

  it("defaults to week when called without argument", () => {
    expect(resolveWindow()).toEqual({
      focus: "1 week ago",
      context: "1 month ago",
      label: "week",
    });
  });

  it("defaults to week for empty string", () => {
    expect(resolveWindow("")).toEqual({
      focus: "1 week ago",
      context: "1 month ago",
      label: "week",
    });
  });

  it("throws for an invalid window value", () => {
    expect(() => resolveWindow("invalid")).toThrow(/Invalid --window value 'invalid'/);
  });

  it("throws for a numeric value", () => {
    expect(() => resolveWindow("42")).toThrow(/Invalid --window value '42'/);
  });
});

describe("bandA (all-time)", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns total commits, first commit, and top authors", async () => {
    const { bandA } = await import("./git-reader.mjs");

    vi.mocked(execFileSync)
      .mockReturnValueOnce("abc123\nabc124\nabc125\n")
      .mockReturnValueOnce("2026-01-15 Initial commit")
      .mockReturnValueOnce(" 5\tJohn Martin\n 3\tJane Doe\n");

    const result = bandA();

    expect(result.totalCommits).toBe(3);
    expect(result.firstCommit).toBe("2026-01-15 Initial commit");
    expect(result.topAuthors).toHaveLength(2);
  });

  it("reports 'none' when there are no commits", async () => {
    const { bandA } = await import("./git-reader.mjs");

    vi.mocked(execFileSync).mockReturnValueOnce("").mockReturnValueOnce("").mockReturnValueOnce("");

    const result = bandA();

    expect(result.totalCommits).toBe(1);
    expect(result.firstCommit).toBe("none");
    expect(result.topAuthors).toEqual([]);
  });
});

describe("bandB (context span)", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses git log output and computes churn", async () => {
    const { bandB } = await import("./git-reader.mjs");

    vi.mocked(execFileSync)
      .mockReturnValueOnce("2026-07-01 feat: add foo\n2026-07-02 fix: bar\n")
      .mockReturnValueOnce("src/foo.mjs\nsrc/foo.mjs\nsrc/bar.mjs\n");

    const result = bandB("1 month ago");

    expect(result.totalCommits).toBe(2);
    expect(result.subjects).toHaveLength(2);
    expect(result.churn).toHaveLength(1);
    expect(result.churn[0]).toEqual({ dir: "src", count: 3 });
  });

  it("returns empty churn when no files changed", async () => {
    const { bandB } = await import("./git-reader.mjs");

    vi.mocked(execFileSync).mockReturnValueOnce("").mockReturnValueOnce("");

    const result = bandB("1 month ago");

    expect(result.totalCommits).toBe(0);
    expect(result.subjects).toHaveLength(1);
    expect(result.churn).toEqual([]);
  });

  it("limits subjects to 50", async () => {
    const { bandB } = await import("./git-reader.mjs");

    const manyLines = Array.from(
      { length: 60 },
      (_, i) => `2026-07-${String(i + 1).padStart(2, "0")} commit ${i}`,
    ).join("\n");
    vi.mocked(execFileSync).mockReturnValueOnce(manyLines).mockReturnValueOnce("");

    const result = bandB("1 month ago");

    expect(result.subjects).toHaveLength(50);
  });
});

describe("bandC (focus span)", () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses stat-format git log into commit objects with files", async () => {
    const { bandC } = await import("./git-reader.mjs");

    const log =
      "abc1234 2026-07-30 feat: add foo\n" +
      " src/foo.mjs | 5 +++++\n" +
      "def5678 2026-07-29 fix: bar\n" +
      " src/bar.mjs | 3 +--\n";

    vi.mocked(execFileSync).mockReturnValueOnce(log);

    const result = bandC("1 week ago");

    expect(result.totalCommits).toBe(2);
    expect(result.commits[0].hash).toBe("abc1234");
    expect(result.commits[0].date).toBe("2026-07-30");
    expect(result.commits[0].subject).toBe("feat: add foo");
    expect(result.commits[0].files).toContain("src/foo.mjs");
    expect(result.commits[1].files).toContain("src/bar.mjs");
  });

  it("handles empty git log", async () => {
    const { bandC } = await import("./git-reader.mjs");

    vi.mocked(execFileSync).mockReturnValueOnce("");

    const result = bandC("1 week ago");

    expect(result.totalCommits).toBe(0);
    expect(result.commits).toEqual([]);
  });

  it("limits to 100 commits", async () => {
    const { bandC } = await import("./git-reader.mjs");

    const commitLines = Array.from(
      { length: 120 },
      (_, i) => `abc${String(i).padStart(4, "0")} 2026-07-30 commit ${i}`,
    );
    vi.mocked(execFileSync).mockReturnValueOnce(commitLines.join("\n"));

    const result = bandC("1 week ago");

    expect(result.totalCommits).toBe(120);
    expect(result.commits).toHaveLength(100);
  });

  it("handles lines that do not match commit or stat patterns", async () => {
    const { bandC } = await import("./git-reader.mjs");

    const log =
      "abc1234 2026-07-30 feat: add foo\n" +
      " src/foo.mjs | 5 +++++\n" +
      "unrelated output line\n" +
      "  \n";

    vi.mocked(execFileSync).mockReturnValueOnce(log);

    const result = bandC("1 week ago");

    expect(result.totalCommits).toBe(1);
    expect(result.commits[0].files).toContain("src/foo.mjs");
  });
});
