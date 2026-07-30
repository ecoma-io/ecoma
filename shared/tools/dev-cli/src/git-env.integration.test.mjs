import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { fixtureEnv, initFixtureRepo } from "./git-fixture.mjs";

const MAIN = fileURLToPath(new URL("./main.mjs", import.meta.url));

/**
 * The gates that run from a project's `lint` target, driven the way a git hook
 * drives them: an absolute `GIT_DIR` in the environment and a PROJECT directory
 * as the working directory (Nx runs every lint target with `cwd: {projectRoot}`).
 *
 * A subprocess, not an in-process call, because that ambient environment is the
 * subject: `initFixtureRepo`'s own guard refuses to build a fixture while
 * `GIT_DIR` is set in this process, and rightly so. Handing the child the
 * variable instead reproduces the hook exactly without ever letting the test
 * process see it.
 *
 * What each expectation buys, per gate: without the scrub git answers that the
 * project directory is the whole work tree, and the failures are NOT symmetrical.
 * `check-e2e-story-coverage` dies loudly on a pathspec that is suddenly outside
 * the repository — recoverable, because the commit stops. `check-journey-markers`
 * gets a whole-index listing whose repo-relative paths no longer resolve against
 * its cwd, opens no file, and reports a clean project: green while having checked
 * nothing, on every commit, which is why the marker below must come back named.
 */
function runGate(args, cwd, repo) {
  return spawnSync(process.execPath, [MAIN, ...args], {
    cwd,
    encoding: "utf8",
    // Exactly what git exports to a hook run from a linked worktree.
    env: { ...fixtureEnv(), GIT_DIR: join(repo, ".git") },
  });
}

describe("project lint gates under the GIT_DIR a git hook exports", () => {
  /**
   * A library project holding one incomplete primitive and one marker, plus a
   * sibling e2e project that scans it from outside — the two cwds these gates
   * actually run in.
   */
  function initWorkspaceFixture() {
    return initFixtureRepo("git-env", {
      "libs/ui/project.json": JSON.stringify({ name: "ui", targets: { lint: {} } }),
      "libs/ui/src/primitives/Button/Button.vue": "<template><button /></template>\n",
      "libs/ui/src/styles/tokens.css": "/* ships at 0.2 */\n",
      "apps/probe/project.json": JSON.stringify({ name: "probe", targets: { lint: {} } }),
    });
  }

  it("reports a journey marker in the project's own files instead of reading none", () => {
    const repo = initWorkspaceFixture();

    const result = runGate(["check-journey-markers", "."], join(repo, "libs/ui"), repo);

    expect(result.stderr).toContain("src/styles/tokens.css:1");
    expect(result.stderr).toContain("ships at 0.2");
    expect(result.status).toBe(1);
  });

  it("reports a component with no story instead of dying on its own pathspec", () => {
    const repo = initWorkspaceFixture();

    const result = runGate(
      ["check-e2e-story-coverage", "../../libs/ui/src"],
      join(repo, "apps/probe"),
      repo,
    );

    expect(result.stderr).toContain("libs/ui/src/primitives/Button: missing Button.stories.ts");
    expect(result.stderr).not.toContain("outside repository");
    expect(result.status).toBe(1);
  });

  it("reports an incomplete primitive from inside the project that owns it", () => {
    const repo = initWorkspaceFixture();

    const result = runGate(["check-primitive-artifacts"], join(repo, "libs/ui"), repo);

    expect(result.stderr).toContain("src/primitives/Button: missing Button.test.ts");
    expect(result.status).toBe(1);
  });
});
