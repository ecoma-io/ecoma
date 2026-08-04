/**
 * The workspace-declared language set, exercised against the real filesystem.
 *
 * The unit suites cannot reach this behavior: `LANGS` is resolved once at
 * module load, from the tree the TEST process stands in — always this
 * workspace, always its three languages. What changed is which tree answers,
 * so the only honest probe is a subprocess standing in a different tree: a
 * fixture repository that declares two languages, judged by the real CLI.
 * The fallback path (a tree declaring nothing resolves to this workspace's
 * copy) is already exercised by every scaffold-lib integration fixture, none
 * of which carries a root config.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_SELECTING_GIT_VARS } from "./git-env.mjs";
import { initFixtureRepo } from "./git-fixture.mjs";

const MAIN = join(import.meta.dirname, "main.mjs");

/**
 * Run a dev-cli gate as its own process with the fixture as cwd — the same
 * shape a downstream workspace invokes it in. The repo-selecting git
 * variables are scrubbed for the reason git-fixture.mjs documents: inherited,
 * they outrank cwd and would point the subprocess's git at a real checkout.
 */
function runGate(repo, command) {
  const env = { ...process.env };
  for (const name of REPO_SELECTING_GIT_VARS) delete env[name];
  try {
    return execFileSync(process.execPath, [MAIN, command], { cwd: repo, env, encoding: "utf8" });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
}

describe("workspace-declared languages against the real filesystem", () => {
  it("judges a two-language workspace by its own declaration, not by this one's", () => {
    const repo = initFixtureRepo("langs-two", {
      "languages.config.json": JSON.stringify({
        languages: [
          { code: "en", label: "English" },
          { code: "vi", label: "Tiếng Việt" },
        ],
      }),
    });

    const output = runGate(repo, "check-subsystem-readmes");

    // The root README pair is demanded in the declared languages — and ONLY
    // in them: a third variant demanded here would mean the gate read the
    // harness's own config instead of the judged tree's.
    expect(output).toContain("README.md: missing");
    expect(output).toContain("README.vi.md: missing");
    expect(output).not.toContain("README.zh.md");
  });

  it("fails loudly on a language config that exists but cannot be parsed", () => {
    // The fallback covers a MISSING config only. A tree whose config is
    // broken must not be quietly judged by the default language set — the
    // wrong-variant verdicts that would follow read as the tree's fault, not
    // the config's.
    const repo = initFixtureRepo("langs-broken", {
      "languages.config.json": "{ this is not json",
    });

    const output = runGate(repo, "check-subsystem-readmes");

    expect(output).toContain("languages.config.json");
    expect(output).not.toContain("README.vi.md: missing");
  });

  it("fails loudly on a journey-marker config that exists but cannot be parsed", () => {
    const repo = initFixtureRepo("journey-broken", {
      "journey-markers.config.json": "{ this is not json",
    });

    const output = runGate(repo, "check-journey-markers-workspace");

    expect(output).toContain("journey-markers.config.json");
  });
});
