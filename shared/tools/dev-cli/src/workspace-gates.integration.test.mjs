import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { WORKSPACE_GATES } from "./workspace-gates.mjs";

const MAIN = fileURLToPath(new URL("./main.mjs", import.meta.url));
const CI_WORKFLOW = fileURLToPath(new URL("../../../../.github/workflows/ci.yml", import.meta.url));

// Same derivation as check-command-refs: the CLI's own unknown-command listing
// is the registry, read from the running artifact rather than restated.
function registeredCommands() {
  const { stderr } = spawnSync(process.execPath, [MAIN], { encoding: "utf8" });
  const match = stderr.match(/Available: (.+)/);
  if (!match) throw new Error(`could not parse dev-cli's command list from: ${stderr}`);
  return new Set(match[1].split(", "));
}

describe("the gate list against the real CLI", () => {
  it("names only registered commands, so every red line is re-runnable in isolation", () => {
    const commands = registeredCommands();
    for (const [name] of WORKSPACE_GATES) {
      expect(commands, `'${name}' is not a registered dev-cli command`).toContain(name);
    }
  });
});

describe("the gate list against the CI workflow", () => {
  // The invariant this command exists to hold: the workspace-wide gate list
  // lives HERE and nowhere else. A bare dev-cli step added to ci.yml is a
  // second list — invisible to every other consumer of workspace-gates, which
  // would keep reporting green while judging less than this repository does.
  // `check-contributor-record` is the one documented exemption: its bare form
  // is the push-mode half of an event-scoped gate and stays beside its
  // argument-taking half in the workflow (workspace-gates.mjs header).
  it("stays the only argument-free dev-cli invocation in ci.yml, so the list cannot fork", () => {
    const workflow = readFileSync(CI_WORKFLOW, "utf8");
    const bare = [...workflow.matchAll(/main\.mjs\s+([a-z][a-z0-9-]*)\s*$/gm)].map((m) => m[1]);
    const unexpected = bare.filter(
      (name) => !["workspace-gates", "check-contributor-record"].includes(name),
    );
    expect(unexpected, "move these gates into WORKSPACE_GATES instead of adding CI steps").toEqual(
      [],
    );
  });

  it("is executed by ci.yml, so the single source is also the one actually run", () => {
    expect(readFileSync(CI_WORKFLOW, "utf8")).toContain("main.mjs workspace-gates");
  });
});
