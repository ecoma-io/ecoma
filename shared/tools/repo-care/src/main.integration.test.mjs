import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const MAIN = fileURLToPath(new URL("./main.mjs", import.meta.url));

/**
 * Drives the real CLI in a subprocess (main.mjs process.exits at import time,
 * so it cannot be imported in-process). Network-touching paths stay out of
 * scope here — they are unit-tested with injected fetch.
 */
describe("repo-care CLI", () => {
  it("rejects an unknown command and lists what exists", async () => {
    const res = await run("node", [MAIN, "no-such-command"]).catch((e) => e);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown command 'no-such-command'");
    expect(res.stderr).toContain("triage-issue");
  });

  it("fails triage-issue as a usage error before touching any network", async () => {
    const res = await run("node", [MAIN, "triage-issue", "--issue", "1"], {
      env: { ...process.env, GITHUB_TOKEN: "", GITHUB_REPOSITORY: "" },
    }).catch((e) => e);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("GITHUB_TOKEN and GITHUB_REPOSITORY");
  });
});
