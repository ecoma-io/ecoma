import { afterEach, describe, expect, it, vi } from "vitest";

import { cwdGitEnv } from "./git-env.mjs";

/**
 * The two halves of this contract pull in opposite directions, which is why both
 * are pinned: the repository must come from cwd (a hook's `GIT_DIR` is a lie
 * about which tree a project lint is looking at), while the INDEX must still come
 * from the hook (`git commit -- <paths>` hands it a temporary one naming exactly
 * the paths being committed). Scrub too little and a gate reads the wrong tree;
 * scrub too much and it judges a change nobody is making.
 */
describe("cwdGitEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("drops every variable that relocates the repository", () => {
    vi.stubEnv("GIT_DIR", "/elsewhere/.git");
    vi.stubEnv("GIT_WORK_TREE", "/elsewhere");
    vi.stubEnv("GIT_COMMON_DIR", "/elsewhere/.git");

    const env = cwdGitEnv();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_COMMON_DIR).toBeUndefined();
  });

  it("keeps the inherited index, which names the change a hook is committing", () => {
    vi.stubEnv("GIT_INDEX_FILE", "/repo/.git/next-index-1234.lock");

    expect(cwdGitEnv().GIT_INDEX_FILE).toBe("/repo/.git/next-index-1234.lock");
  });

  it("leaves variables that select no repository untouched", () => {
    vi.stubEnv("GIT_AUTHOR_NAME", "Someone");
    vi.stubEnv("HOME", "/home/someone");

    const env = cwdGitEnv();
    expect(env.GIT_AUTHOR_NAME).toBe("Someone");
    expect(env.HOME).toBe("/home/someone");
  });

  it("copies rather than mutates, so a caller's own environment survives", () => {
    const source = { GIT_DIR: "/elsewhere/.git", PATH: "/usr/bin" };

    expect(cwdGitEnv(source).GIT_DIR).toBeUndefined();
    expect(source.GIT_DIR).toBe("/elsewhere/.git");
  });
});
