import { describe, expect, it, vi } from "vitest";

import {
  applyIdentity,
  BOT_EMAIL,
  ensureCommitIdentity,
  identEmail,
  isBotEmail,
  pickIdentity,
} from "./ensure-commit-identity.mjs";

/** A deps double: bot ambient identity, resolvable operator, recorded writes. */
function makeDeps(overrides = {}) {
  const writes = [];
  return {
    writes,
    env: { CLAUDE_CODE_USER_EMAIL: "op@example.com" },
    committerEmail: () => BOT_EMAIL,
    authorEmail: () => BOT_EMAIL,
    setConfig: (key, value) => writes.push([key, value]),
    fetchGithubUser: () => ({
      login: "op",
      id: 42,
      name: "Real Operator",
      email: "op@example.com",
    }),
    ...overrides,
  };
}

describe("isBotEmail", () => {
  it("flags the bot address and an absent email, case-insensitively", () => {
    expect(isBotEmail(BOT_EMAIL)).toBe(true);
    expect(isBotEmail("NoReply@Anthropic.com")).toBe(true);
    expect(isBotEmail("")).toBe(true);
    expect(isBotEmail(undefined)).toBe(true);
  });

  it("passes a human operator address", () => {
    expect(isBotEmail("op@example.com")).toBe(false);
  });
});

describe("identEmail", () => {
  it("extracts the address from a git var ident line", () => {
    expect(identEmail("John Martin <john@example.com> 1784850358 +0000")).toBe("john@example.com");
  });

  it("returns empty when the line has no angle-bracketed address", () => {
    expect(identEmail("")).toBe("");
    expect(identEmail(undefined)).toBe("");
  });
});

describe("pickIdentity", () => {
  it("prefers the account's public email and display name from the API", () => {
    const api = { login: "op", id: 42, name: "Real Operator", email: "public@example.com" };
    expect(pickIdentity(api, "env@example.com")).toEqual({
      name: "Real Operator",
      email: "public@example.com",
    });
  });

  it("falls back to the session email, then the login, for a private account", () => {
    const api = { login: "op", id: 42, name: null, email: null };
    expect(pickIdentity(api, "env@example.com")).toEqual({ name: "op", email: "env@example.com" });
  });

  it("derives the GitHub noreply address when neither API nor session email has one", () => {
    const api = { login: "op", id: 42, name: "Real Operator", email: null };
    expect(pickIdentity(api, undefined)).toEqual({
      name: "Real Operator",
      email: "42+op@users.noreply.github.com",
    });
  });

  it("returns null when no email can be determined at all", () => {
    expect(pickIdentity(null, undefined)).toBeNull();
  });
});

describe("applyIdentity", () => {
  it("writes the resolved operator identity and disables signing when the ambient identity is the bot", () => {
    const deps = makeDeps();
    expect(applyIdentity(deps)).toEqual({ acted: true, email: "op@example.com" });
    expect(deps.writes).toEqual([
      ["user.name", "Real Operator"],
      ["user.email", "op@example.com"],
      ["commit.gpgsign", "false"],
    ]);
  });

  it("leaves a human machine untouched (ambient identity already an operator)", () => {
    const deps = makeDeps({ committerEmail: () => "someone@example.com" });
    expect(applyIdentity(deps)).toEqual({ acted: false, email: null });
    expect(deps.writes).toEqual([]);
  });

  it("does not write when the operator cannot be resolved", () => {
    const deps = makeDeps({ env: {}, fetchGithubUser: () => null });
    expect(applyIdentity(deps)).toEqual({ acted: false, email: null });
    expect(deps.writes).toEqual([]);
  });
});

describe("ensureCommitIdentity", () => {
  it("setter mode always exits 0 (best-effort at session start)", () => {
    expect(ensureCommitIdentity([], makeDeps())).toBe(0);
    expect(ensureCommitIdentity([], makeDeps({ fetchGithubUser: () => null, env: {} }))).toBe(0);
  });

  it("guard mode passes a human commit", () => {
    const deps = makeDeps({
      committerEmail: () => "op@example.com",
      authorEmail: () => "op@example.com",
    });
    expect(ensureCommitIdentity(["--check"], deps)).toBe(0);
    expect(deps.writes).toEqual([]);
  });

  it("guard mode blocks a bot commit, resetting the config for the retry", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps();
    expect(ensureCommitIdentity(["--check"], deps)).toBe(1);
    expect(deps.writes).toContainEqual(["user.email", "op@example.com"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("Re-run your commit"));
    err.mockRestore();
  });

  it("guard mode blocks and asks for a manual fix when the operator is unresolvable", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({ env: {}, fetchGithubUser: () => null });
    expect(ensureCommitIdentity(["--check"], deps)).toBe(1);
    expect(deps.writes).toEqual([]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("git config user.email"));
    err.mockRestore();
  });

  it("guard mode blocks when only the author is the bot (forced --author)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({ committerEmail: () => "op@example.com", authorEmail: () => BOT_EMAIL });
    expect(ensureCommitIdentity(["--check"], deps)).toBe(1);
    vi.restoreAllMocks();
  });
});
