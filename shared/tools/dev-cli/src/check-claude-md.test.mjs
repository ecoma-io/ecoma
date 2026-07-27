import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkClaudeMd, findMissingClaudeMd } from "./check-claude-md.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

describe("findMissingClaudeMd", () => {
  it("reports only the projects whose directory lacks a CLAUDE.md", () => {
    const present = new Set(["vider/apps/vider/CLAUDE.md", "shared/libs/core-app/CLAUDE.md"]);
    const missing = findMissingClaudeMd(
      [
        "vider/apps/vider/project.json",
        "shared/libs/core-app/project.json",
        "reacher/apps/reacher/project.json", // no CLAUDE.md
      ],
      (p) => present.has(p),
    );
    expect(missing).toEqual(["reacher/apps/reacher/project.json"]);
  });

  it("reports nothing when every project is documented", () => {
    expect(findMissingClaudeMd(["a/project.json"], (p) => p === "a/CLAUDE.md")).toEqual([]);
  });
});

describe("checkClaudeMd", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails loudly, naming each undocumented project", () => {
    vi.mocked(execFileSync).mockReturnValue("no-such-dir/project.json\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkClaudeMd()).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("no-such-dir/project.json"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("missing sibling CLAUDE.md"));
  });

  it("passes when every tracked project.json has its sibling CLAUDE.md", () => {
    // dirname("project.json") is "." — resolved against cwd (this project's
    // root, which does carry a CLAUDE.md).
    vi.mocked(execFileSync).mockReturnValue("project.json\n");
    expect(checkClaudeMd()).toBe(0);
  });

  it("ignores files that merely end in project.json (e.g. subproject.json)", () => {
    vi.mocked(execFileSync).mockReturnValue("no-such-dir/subproject.json\n");
    expect(checkClaudeMd()).toBe(0);
  });
});
