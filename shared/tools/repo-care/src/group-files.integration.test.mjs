/**
 * The grouping names its groups in the vocabulary `check-commit-scope`
 * enforces, and this is the only place that agreement is checked.
 *
 * It runs `dev-cli list-scopes` in a subprocess rather than importing it: a
 * cross-project source import would be an edge the Nx project graph cannot see
 * (`shared/CLAUDE.md`), and spawning is how this tool already reaches dev-cli
 * from its own lint target. What the pin buys: if either side changes how a
 * project is named, a review comment would silently start grouping along a
 * boundary the commit gate does not recognise — a divergence that fails no
 * build and that nobody reads a diff carefully enough to notice.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverProjectRoots, groupFiles, readProjectNames } from "./group-files.mjs";

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

describe("group labels against the workspace's own scope vocabulary", () => {
  it("names every project group with a scope check-commit-scope would accept", () => {
    const scopes = new Set(
      execFileSync("node", ["shared/tools/dev-cli/src/main.mjs", "list-scopes"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    expect(scopes.size).toBeGreaterThan(0);

    const roots = discoverProjectRoots(REPO_ROOT);
    const names = readProjectNames(roots, REPO_ROOT);
    // One file per project root is enough: the label depends on the owner, not
    // on how many files landed in it.
    const groups = groupFiles(
      roots.map((root) => `${root}/probe.txt`),
      roots,
      names,
    );

    expect(groups).toHaveLength(roots.length);
    for (const group of groups) expect(scopes).toContain(group.name);
  });
});

describe("project discovery against a hostile ambient git environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * `GIT_DIR` outranks the `-C` this module pins, so an ambient one decides which
   * repository is read no matter which directory is named. The failure is silent
   * by construction: `discoverProjectRoots` swallows a git error and returns no
   * projects, and every group then degrades from an Nx project to its subsystem —
   * a review comment grouped along a boundary the commit gate does not recognise,
   * which fails no build and which nobody reads a diff carefully enough to notice.
   *
   * Pointed at a directory that is no repository at all, so the assertion can only
   * pass by the variable having been ignored. Nothing is written anywhere.
   */
  it("still finds the workspace's projects when the environment names another repository", () => {
    vi.stubEnv("GIT_DIR", join(mkdtempSync(join(tmpdir(), "repo-care-absent-")), ".git"));

    expect(discoverProjectRoots(REPO_ROOT)).toContain("shared/tools/repo-care");
  });
});
