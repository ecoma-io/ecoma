import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coverageThresholdFlags, runNodeTests } from "./run-node-tests.mjs";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

// The shape the repo-root `coverage.config.json` carries: the three metrics
// Node's runner enforces, plus the `statements` it has no threshold for.
const floor = (overrides = {}) => ({
  lines: 80,
  functions: 80,
  branches: 80,
  statements: 80,
  ...overrides,
});

describe("coverageThresholdFlags", () => {
  it("emits one flag per metric Node's runner can enforce", () => {
    expect(coverageThresholdFlags(floor())).toEqual([
      "--test-coverage-lines=80",
      "--test-coverage-branches=80",
      "--test-coverage-functions=80",
    ]);
  });

  it("carries each metric's own number rather than one shared value", () => {
    expect(
      coverageThresholdFlags(floor({ lines: 90, branches: 70, functions: 85, statements: 90 })),
    ).toEqual([
      "--test-coverage-lines=90",
      "--test-coverage-branches=70",
      "--test-coverage-functions=85",
    ]);
  });

  it("tolerates a metric Node cannot enforce while it sits no higher than the line floor", () => {
    // `statements` has no Node threshold, and it is a refinement of `lines`. At
    // or below the enforced line floor, enforcing lines is the closest this
    // runner can come to it, so nothing is quietly given up.
    expect(coverageThresholdFlags(floor({ statements: 80 }))).toHaveLength(3);
    expect(coverageThresholdFlags(floor({ statements: 50 }))).toHaveLength(3);
  });

  it("judges an unenforceable metric against lines, not against a lower branch floor", () => {
    // Branches sitting below the other metrics is the normal shape of a
    // coverage config, and says nothing about statements — a rule that compared
    // against the weakest metric would fail this workspace for it.
    expect(coverageThresholdFlags(floor({ branches: 60, statements: 80 }))).toContain(
      "--test-coverage-branches=60",
    );
  });

  it("refuses a floor whose unenforceable metric outranks the line floor Node does measure", () => {
    // Running anyway would report green on a bar nobody measured — the exact
    // fake-green the coverage floor exists to prevent.
    expect(() => coverageThresholdFlags(floor({ statements: 95 }))).toThrow(/statements: 95/);
    expect(() => coverageThresholdFlags(floor({ statements: 95 }))).toThrow(/never measured/);
  });

  it("rejects a floor that leaves a metric Node enforces without a number", () => {
    expect(() => coverageThresholdFlags({ lines: 80, statements: 80 })).toThrow(
      /no number for branches, functions/,
    );
    expect(() => coverageThresholdFlags(undefined)).toThrow(/no number for lines/);
  });
});

describe("runNodeTests", () => {
  beforeEach(() => {
    vi.clearAllMocks(); // vi.restoreAllMocks leaves vi.fn call history in place
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns Node's test runner with coverage on, held to the shared floor", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0 });

    expect(
      runNodeTests(["--test-coverage-exclude=*.test.mjs", "*.test.mjs"], {
        thresholds: floor(),
      }),
    ).toBe(0);

    const [command, args, opts] = vi.mocked(spawnSync).mock.calls[0];
    // An argv array under the current Node binary — never a shell string, so
    // the target works where POSIX word-splitting and globbing do not.
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      "--test",
      "--experimental-test-coverage",
      "--test-coverage-lines=80",
      "--test-coverage-branches=80",
      "--test-coverage-functions=80",
      // Caller args stay last, so a project's own patterns and exclusions reach
      // Node as positional arguments rather than being second-guessed here.
      "--test-coverage-exclude=*.test.mjs",
      "*.test.mjs",
    ]);
    expect(opts).toEqual({ stdio: "inherit" });
  });

  it("propagates the runner's exit code, treating a missing status as failure", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1 });
    expect(runNodeTests([], { thresholds: floor() })).toBe(1);

    // Killed by a signal: no status, and a suite that did not finish is not a pass.
    vi.mocked(spawnSync).mockReturnValue({ status: null });
    expect(runNodeTests([], { thresholds: floor() })).toBe(1);
  });

  it("fails without running a suite when the floor names a metric Node cannot enforce", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(runNodeTests([], { thresholds: floor({ statements: 95 }) })).toBe(1);

    expect(error).toHaveBeenCalledWith(expect.stringContaining("statements: 95"));
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rethrows a spawn failure rather than reporting it as a test result", () => {
    const boom = new Error("spawn failed");
    vi.mocked(spawnSync).mockReturnValue({ error: boom });
    expect(() => runNodeTests([], { thresholds: floor() })).toThrow(boom);
  });
});
