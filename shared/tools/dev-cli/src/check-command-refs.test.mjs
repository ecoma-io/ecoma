import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkCommandRefs,
  deriveCommandNames,
  findUnknownCommandRefs,
} from "./check-command-refs.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));

describe("deriveCommandNames", () => {
  it("parses the comma-separated list off the CLI's own unknown-command stderr", () => {
    const run = () => "dev-cli: unknown command ''. Available: check-doc-links, check-claude-md\n";
    expect(deriveCommandNames(run)).toEqual(["check-doc-links", "check-claude-md"]);
  });

  it("throws loudly rather than silently reporting nothing when stderr is unparseable", () => {
    expect(() => deriveCommandNames(() => "")).toThrow(/could not parse/);
  });
});

describe("findUnknownCommandRefs", () => {
  const known = ["check-doc-links", "check-claude-md"];

  it("flags a full invocation naming a command outside the known set", () => {
    const text = [
      "Run:",
      "node shared/tools/dev-cli/src/main.mjs check-claude-md",
      "node shared/tools/dev-cli/src/main.mjs check-subsystem-readmes-renamed",
    ].join("\n");

    const hits = findUnknownCommandRefs(text, known);
    expect(hits).toEqual([{ command: "check-subsystem-readmes-renamed", line: 3 }]);
  });

  it("ignores a bare inline-code mention and a reserved-seam placeholder", () => {
    const text = [
      "`check-does-not-exist-anywhere` is only prose here.",
      "invoked one uniform way: `node shared/tools/dev-cli/src/main.mjs <command>`.",
      "a different tool: `node shared/tools/repo-care/src/main.mjs triage-issue`.",
    ].join("\n");

    expect(findUnknownCommandRefs(text, known)).toEqual([]);
  });
});

describe("checkCommandRefs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails when a tracked doc cites a dev-cli command outside the derived registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-command-refs-"));
    const doc = join(dir, "guide.md");
    writeFileSync(doc, "node shared/tools/dev-cli/src/main.mjs check-subsystem-readmes-renamed\n");
    vi.mocked(execFileSync).mockReturnValue(`${doc}\n`);
    vi.mocked(spawnSync).mockReturnValue({
      stderr: "dev-cli: unknown command ''. Available: check-doc-links, check-claude-md\n",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkCommandRefs()).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("check-subsystem-readmes-renamed"));
  });

  it("passes when every cited command is in the derived registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-command-refs-"));
    const doc = join(dir, "guide.md");
    writeFileSync(doc, "node shared/tools/dev-cli/src/main.mjs check-claude-md\n");
    vi.mocked(execFileSync).mockReturnValue(`${doc}\n`);
    vi.mocked(spawnSync).mockReturnValue({
      stderr: "dev-cli: unknown command ''. Available: check-doc-links, check-claude-md\n",
    });

    expect(checkCommandRefs()).toBe(0);
  });

  it("skips unreadable listed files instead of crashing", () => {
    vi.mocked(execFileSync).mockReturnValue("no/such/file.md\n");
    vi.mocked(spawnSync).mockReturnValue({
      stderr: "dev-cli: unknown command ''. Available: check-doc-links\n",
    });

    expect(checkCommandRefs()).toBe(0);
  });
});
