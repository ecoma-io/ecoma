import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertFixtureIsolated, fixtureEnv, fixtureGit, initFixtureRepo } from "./git-fixture.mjs";

/**
 * These are the tests that stand between the suite and a developer's branch. A
 * git hook exports `GIT_DIR`, `verify` runs on `pre-push`, and `GIT_DIR`
 * outranks both `cwd` and `-C` — so an unqualified fixture write commits into
 * the repository being pushed and deletes its tree (issue #82). Every
 * expectation below pins one of the layers that stops that.
 */
describe("git fixtures under a hostile ambient git environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("strips every repo-selecting variable from a spawn environment", () => {
    vi.stubEnv("GIT_DIR", "/somewhere/.git");
    vi.stubEnv("GIT_WORK_TREE", "/somewhere");
    vi.stubEnv("GIT_INDEX_FILE", "/somewhere/.git/index");
    vi.stubEnv("GIT_COMMON_DIR", "/somewhere/.git");
    vi.stubEnv("HOME", "/somewhere"); // untouched: it selects no repository

    const env = fixtureEnv();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
    expect(env.HOME).toBe("/somewhere");
  });

  it("keeps a fixture commit out of the repository the environment names", () => {
    const other = initFixtureRepo("git-fixture-bystander", { "keep.txt": "keep\n" });
    fixtureGit(other, ["commit", "-qm", "bystander baseline"]);
    const headBefore = fixtureGit(other, ["rev-parse", "HEAD"]).trim();

    const fixture = initFixtureRepo("git-fixture-subject", { "a.txt": "a\n" });
    // Exactly the ambient state a git hook hands the suite.
    vi.stubEnv("GIT_DIR", join(other, ".git"));
    vi.stubEnv("GIT_WORK_TREE", other);
    fixtureGit(fixture, ["commit", "-qm", "fixture commit"]);
    vi.unstubAllEnvs();

    expect(fixtureGit(other, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(fixtureGit(other, ["status", "--porcelain"])).toBe("");
    expect(fixtureGit(fixture, ["log", "--oneline"])).toContain("fixture commit");
  });

  it("refuses a fixture directory outside the OS temp dir", () => {
    expect(() => assertFixtureIsolated(process.cwd())).toThrow(/not under the OS temp dir/);
  });

  it("refuses to build a fixture while a repo-selecting variable is still set", () => {
    vi.stubEnv("GIT_DIR", "/somewhere/.git");
    expect(() => initFixtureRepo("git-fixture-guarded")).toThrow(
      /GIT_DIR still set in this process/,
    );
  });

  it("refuses a fixture directory that already resolves to a repository", () => {
    const outer = initFixtureRepo("git-fixture-outer");
    const nested = join(outer, "nested");
    mkdirSync(nested);

    expect(() => assertFixtureIsolated(nested)).toThrow(/git resolves .* from the fresh fixture/);
  });
});
