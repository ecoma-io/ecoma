import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkDocLinks } from "./check-doc-links.mjs";
import { initFixtureRepo } from "./git-fixture.mjs";

/**
 * Creates a throwaway git repo holding `files` and returns its path. The
 * fixture helper owns the git isolation (scrubbed env + `-C` + a guard) — see
 * `git-fixture.mjs` for why a bare `cwd` is not enough.
 */
function initGitRepo(files) {
  return initFixtureRepo("check-doc-links", files);
}

describe("checkDocLinks against a real git repo", () => {
  const originalCwd = process.cwd();
  let error;

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it("reports the doc, line, and target of each link whose file moved away", () => {
    process.chdir(
      initGitRepo({
        "README.md": "# readme\n",
        "docs/guide.md": [
          "Good [readme](../README.md) and [site](https://example.com).",
          "Broken [gone](./moved-elsewhere.md).",
        ].join("\n"),
      }),
    );

    expect(checkDocLinks()).toBe(1);
    const reported = error.mock.calls.flat().join("\n");
    expect(reported).toContain("docs/guide.md:2");
    expect(reported).toContain("./moved-elsewhere.md");
    expect(reported).not.toContain("README.md:");
  });

  it("passes when every relative Markdown link resolves", () => {
    process.chdir(
      initGitRepo({
        "README.md": "See [guide](docs/guide.md).\n",
        "docs/guide.md": "Back to [readme](../README.md).\n",
      }),
    );
    expect(checkDocLinks()).toBe(0);
  });
});
