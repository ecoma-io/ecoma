import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkCommandRefs } from "./check-command-refs.mjs";
import { initFixtureRepo } from "./git-fixture.mjs";

/**
 * Creates a throwaway git repo holding `files` and returns its path. The
 * fixture helper owns the git isolation (scrubbed env + `-C` + a guard) — see
 * `git-fixture.mjs` for why a bare `cwd` is not enough.
 */
function initGitRepo(files) {
  return initFixtureRepo("check-command-refs", files);
}

describe("checkCommandRefs against a real git repo", () => {
  const originalCwd = process.cwd();
  let error;

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  // deriveCommandNames() always spawns the REAL, installed main.mjs (this
  // source tree's own file, resolved off import.meta.url) — never a copy
  // inside the fixture — because the known-command list is a property of the
  // actual CLI, not of whatever the fixture happens to contain.
  it("reports the doc and line of a citation naming a command the real CLI does not have", () => {
    process.chdir(
      initGitRepo({
        "docs/guide.md": [
          "Run:",
          "node shared/tools/dev-cli/src/main.mjs check-doc-links",
          "node shared/tools/dev-cli/src/main.mjs check-subsystem-readmes-renamed",
        ].join("\n"),
      }),
    );

    expect(checkCommandRefs()).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("docs/guide.md:3");
    expect(reported).toContain("check-subsystem-readmes-renamed");
    expect(reported).not.toContain("guide.md:2:");
  });

  it("passes when every cited dev-cli command exists in the real registry", () => {
    process.chdir(
      initGitRepo({
        "docs/guide.md": "node shared/tools/dev-cli/src/main.mjs check-doc-links\n",
      }),
    );
    expect(checkCommandRefs()).toBe(0);
  });
});
