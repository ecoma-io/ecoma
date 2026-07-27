import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyIdentity,
  defaultDeps,
  ensureCommitIdentity,
  identEmail,
} from "./ensure-commit-identity.mjs";
import { fixtureGit, initFixtureRepo } from "./git-fixture.mjs";

/**
 * Exercises the real git I/O (`git var`, `git config`) against a throwaway repo.
 * The GitHub `/user` lookup is stubbed — resolving it live needs the sandbox
 * auth proxy, so, like the nx-graph path in check-commit-scope, it is a unit
 * concern only. `fetchGithubUser` returns null here so the session email is the
 * resolved address, proving the offline resolution path end-to-end. Git
 * isolation is the fixture helper's job — see `git-fixture.mjs`.
 */
function initGitRepo() {
  return initFixtureRepo("ensure-commit-identity");
}

/** defaultDeps wired to a specific repo, with the network lookup stubbed off. */
function repoDeps(dir, env) {
  const git = (args) => fixtureGit(dir, args);
  return {
    ...defaultDeps(),
    env,
    committerEmail: () => identEmail(git(["var", "GIT_COMMITTER_IDENT"])),
    authorEmail: () => identEmail(git(["var", "GIT_AUTHOR_IDENT"])),
    setConfig: (key, value) => git(["config", key, value]),
    fetchGithubUser: () => null,
  };
}

describe("ensureCommitIdentity against a real git repo", () => {
  let dir;
  let error;

  beforeEach(() => {
    dir = initGitRepo();
    fixtureGit(dir, ["config", "user.name", "Claude"]);
    fixtureGit(dir, ["config", "user.email", "noreply@anthropic.com"]);
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const readConfig = (key) => fixtureGit(dir, ["config", "--get", key]).trim();

  it("rewrites the bot identity to the session operator and disables signing", () => {
    const result = applyIdentity(repoDeps(dir, { CLAUDE_CODE_USER_EMAIL: "op@example.com" }));

    expect(result).toEqual({ acted: true, email: "op@example.com" });
    expect(readConfig("user.email")).toBe("op@example.com");
    expect(readConfig("user.name")).toBe("op@example.com"); // name falls back to the email offline
    expect(readConfig("commit.gpgsign")).toBe("false");
  });

  it("guard blocks a bot commit and resets the config for the retry", () => {
    const code = ensureCommitIdentity(
      ["--check"],
      repoDeps(dir, { CLAUDE_CODE_USER_EMAIL: "op@example.com" }),
    );

    expect(code).toBe(1);
    expect(readConfig("user.email")).toBe("op@example.com");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Re-run your commit"));
  });

  it("guard passes once a human identity is configured", () => {
    fixtureGit(dir, ["config", "user.email", "human@example.com"]);
    fixtureGit(dir, ["config", "user.name", "Human"]);

    expect(ensureCommitIdentity(["--check"], repoDeps(dir, {}))).toBe(0);
  });
});
