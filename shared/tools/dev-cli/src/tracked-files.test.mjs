import { describe, expect, it } from "vitest";

import { listTrackedFiles } from "./tracked-files.mjs";

describe("listTrackedFiles", () => {
  it("asks git to recurse submodules, which is the whole reason this helper exists", () => {
    const seen = [];
    listTrackedFiles([], (args) => {
      seen.push(args);
      return "";
    });
    expect(seen[0]).toEqual(["ls-files", "--recurse-submodules"]);
  });

  it("passes pathspecs after the separator so a leading dash in one cannot be read as a flag", () => {
    const seen = [];
    listTrackedFiles(["*project.json", "*.md"], (args) => {
      seen.push(args);
      return "";
    });
    expect(seen[0]).toEqual(["ls-files", "--recurse-submodules", "--", "*project.json", "*.md"]);
  });

  it("omits the separator entirely when there are no pathspecs, rather than sending an empty one", () => {
    const seen = [];
    listTrackedFiles([], (args) => {
      seen.push(args);
      return "";
    });
    expect(seen[0]).not.toContain("--");
  });

  it("drops the trailing blank line git leaves, so a caller never counts an empty path", () => {
    expect(listTrackedFiles([], () => "a/b.md\nc/d.md\n")).toEqual(["a/b.md", "c/d.md"]);
  });

  it("returns nothing rather than one empty string when the workspace matches no path", () => {
    expect(listTrackedFiles(["*.nope"], () => "")).toEqual([]);
  });
});
