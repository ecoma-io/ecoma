import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fixtureEnv, initFixtureRepo } from "./git-fixture.mjs";

const MAIN = fileURLToPath(new URL("./main.mjs", import.meta.url));

/**
 * Runs the real CLI in a subprocess and returns { status, stderr }. The env is
 * scrubbed as well as the cwd pinned: the CLI's commands drive git themselves,
 * and an inherited `GIT_DIR` would outrank `cwd` inside the child too.
 */
function runCli(args, cwd) {
  return spawnSync(process.execPath, [MAIN, ...args], { cwd, encoding: "utf8", env: fixtureEnv() });
}

/**
 * Creates a throwaway git repo holding `files` and returns its path. The
 * fixture helper owns the git isolation (scrubbed env + `-C` + a guard) — see
 * `git-fixture.mjs` for why a bare `cwd` is not enough.
 */
function initGitRepo(files) {
  return initFixtureRepo("dev-cli-main", files);
}

describe("dev-cli entry point", () => {
  it("rejects an unknown (or missing) command with exit 2 and lists what exists", () => {
    const unknown = runCli(["frobnicate"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown command 'frobnicate'");
    expect(unknown.stderr).toContain("check-journey-markers");

    expect(runCli([]).status).toBe(2);
  });

  it("dispatches to a command and propagates its failure exit code", () => {
    const repo = initGitRepo({ "undocumented/project.json": "{}\n" });
    const result = runCli(["check-claude-md"], repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("undocumented/project.json");
  });

  it("exits 0 when the dispatched command passes", () => {
    const repo = initGitRepo({
      "documented/project.json": "{}\n",
      "documented/CLAUDE.md": "# scope\n",
    });
    expect(runCli(["check-claude-md"], repo).status).toBe(0);
  });

  it("forwards positional arguments to the command", () => {
    // Two subtrees, one of them violating: the argument is what decides which
    // is judged, so the pair proves the value ARRIVED rather than that some
    // default happened to give the same verdict.
    const repo = initGitRepo({
      "clean/notes.md": "# notes\n",
      "dirty/phase-2-notes.md": "# notes\n",
    });

    expect(runCli(["check-journey-markers", "clean"], repo).status).toBe(0);
    expect(runCli(["check-journey-markers", "dirty"], repo).status).toBe(1);
  });
});
