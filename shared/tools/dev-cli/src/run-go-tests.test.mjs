import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { profileHasStatements, runGoTests, totalStatementCoverage } from "./run-go-tests.mjs";

const FLOOR = { statements: 80 };

/**
 * An injected `go` that behaves like the real one: the `test` call writes
 * `profileLines` into the requested profile path, the `tool cover -func` call
 * returns `funcOutput`.
 */
function fakeGo({ profileLines = [], funcOutput = "", testThrows = false } = {}) {
  return vi.fn((cmd, argv) => {
    if (argv[0] === "test") {
      if (testThrows) throw new Error("go test failed");
      const profilePath = argv.find((a) => a.startsWith("-coverprofile=")).split("=")[1];
      writeFileSync(profilePath, ["mode: set", ...profileLines, ""].join("\n"));
      return "";
    }
    return funcOutput;
  });
}

describe("profile parsing", () => {
  it("sees statements only past the mode header", () => {
    expect(profileHasStatements("mode: set\n")).toBe(false);
    expect(profileHasStatements("mode: set\npkg/a.go:1.1,2.2 1 1\n")).toBe(true);
    expect(profileHasStatements("")).toBe(false);
  });

  it("reads the total off `go tool cover -func` output, and only the total", () => {
    const out = "pkg/a.go:3:\tHelper\t50.0%\ntotal:\t(statements)\t72.5%\n";
    expect(totalStatementCoverage(out)).toBe(72.5);
    expect(totalStatementCoverage("no total here")).toBe(null);
  });
});

describe("the floor judgment", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("propagates a red suite without touching the floor", () => {
    const exec = fakeGo({ testThrows: true });
    expect(runGoTests([], { thresholds: FLOOR, exec })).toBe(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("passes an empty profile — a type-free skeleton's honest state", () => {
    const exec = fakeGo();
    expect(runGoTests([], { thresholds: FLOOR, exec })).toBe(0);
    expect(exec).toHaveBeenCalledTimes(1); // never reaches `go tool cover`
  });

  it("fails a measured total below the shared statements floor", () => {
    const exec = fakeGo({
      profileLines: ["pkg/a.go:1.1,2.2 1 1"],
      funcOutput: "total:\t(statements)\t61.9%\n",
    });
    expect(runGoTests([], { thresholds: FLOOR, exec })).toBe(1);
  });

  it("passes a measured total at the floor", () => {
    const exec = fakeGo({
      profileLines: ["pkg/a.go:1.1,2.2 1 1"],
      funcOutput: "total:\t(statements)\t80.0%\n",
    });
    expect(runGoTests([], { thresholds: FLOOR, exec })).toBe(0);
  });

  it("refuses to run against a floor that names no statements number", () => {
    const exec = fakeGo();
    expect(runGoTests([], { thresholds: {}, exec })).toBe(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails loud when the cover tool prints no total to judge", () => {
    const exec = fakeGo({ profileLines: ["pkg/a.go:1.1,2.2 1 1"], funcOutput: "garbled" });
    expect(runGoTests([], { thresholds: FLOOR, exec })).toBe(1);
  });
});
