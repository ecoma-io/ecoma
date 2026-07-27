import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkClaudeMd } from "./check-claude-md.mjs";
import { initFixtureRepo } from "./git-fixture.mjs";

/**
 * Creates a throwaway git repo holding `files` and returns its path. The
 * fixture helper owns the git isolation (scrubbed env + `-C` + a guard) — see
 * `git-fixture.mjs` for why a bare `cwd` is not enough.
 */
function initGitRepo(files) {
  return initFixtureRepo("check-claude-md", files);
}

describe("checkClaudeMd against a real git repo", () => {
  const originalCwd = process.cwd();
  let error;

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("names each tracked project.json whose directory lacks a CLAUDE.md", () => {
    process.chdir(
      initGitRepo({
        "has-doc/project.json": "{}\n",
        "has-doc/CLAUDE.md": "# scope\n",
        "no-doc/project.json": "{}\n",
        "lookalike/subproject.json": "{}\n", // not a project manifest → ignored
      }),
    );

    expect(checkClaudeMd()).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("no-doc/project.json");
    expect(reported).not.toContain("has-doc/project.json");
    expect(reported).not.toContain("lookalike");
  });

  it("passes once every project carries its CLAUDE.md", () => {
    process.chdir(
      initGitRepo({
        "has-doc/project.json": "{}\n",
        "has-doc/CLAUDE.md": "# scope\n",
      }),
    );
    expect(checkClaudeMd()).toBe(0);
  });
});
