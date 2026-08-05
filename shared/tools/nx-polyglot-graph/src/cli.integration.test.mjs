import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));

/** Runs the real executable, the way a shell or an editor would. */
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

describe("nx-polyglot-graph CLI", () => {
  it("prints a usage message that marks checking as unavailable", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nx-polyglot-graph check");
    expect(result.stdout).toContain("module-boundaries.config.mjs");
    expect(result.stdout).toContain("NO RULE IS IMPLEMENTED YET");
  });

  // The whole tool exists because `@nx/enforce-module-boundaries` exits 0 over
  // a Go file that violates the layer axis. A stub exiting 0 would reproduce
  // that defect at a new address, so the exit code is the behaviour under test.
  it("fails rather than reporting a clean tree it cannot inspect", () => {
    const result = run(["check"]);
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("'check' is not implemented");
  });

  it("separates a missing implementation from a mistyped command by exit code", () => {
    const unknown = run(["frobnicate"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown command 'frobnicate'");

    const bare = run([]);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("no command given");
  });
});
