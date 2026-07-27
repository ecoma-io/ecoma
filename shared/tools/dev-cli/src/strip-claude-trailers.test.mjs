import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stripClaudeTrailers, stripTrailers } from "./strip-claude-trailers.mjs";

describe("stripTrailers", () => {
  it("strips the Claude trailers while preserving a human co-author", () => {
    const agentMessage = [
      "feat(core): add widget",
      "",
      "Body explaining the change.",
      "",
      "Co-Authored-By: Some Human <human@example.com>",
      "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>",
      "Claude-Session: https://claude.ai/code/session_abc",
      "",
    ].join("\n");

    const cleaned = stripTrailers(agentMessage);
    expect(cleaned).not.toMatch(/Claude-Session:/);
    expect(cleaned).not.toMatch(/Co-Authored-By:\s*Claude/i);
    expect(cleaned).toMatch(/Co-Authored-By: Some Human <human@example.com>/);
    // The blank line left dangling after the trailers is collapsed too.
    expect(cleaned.endsWith("<human@example.com>\n")).toBe(true);
  });

  it("matches the trailer keys case-insensitively", () => {
    expect(stripTrailers("fix: x\n\nco-authored-by: claude <a@b>\n").trimEnd()).toBe("fix: x");
  });

  it("returns a message with no agent trailers byte-for-byte unchanged", () => {
    // Human commits (incl. legitimate Signed-off-by trailers) are never touched.
    const humanMessage = "fix: thing\n\nSigned-off-by: John Martin <j@example.com>\n";
    expect(stripTrailers(humanMessage)).toBe(humanMessage);
  });
});

describe("stripClaudeTrailers", () => {
  it("rewrites the commit-message file in place", () => {
    const msgPath = join(mkdtempSync(join(tmpdir(), "strip-trailers-")), "COMMIT_EDITMSG");
    writeFileSync(msgPath, "fix: y\n\nClaude-Session: https://claude.ai/code/session_abc\n");

    expect(stripClaudeTrailers(msgPath)).toBe(0);
    expect(readFileSync(msgPath, "utf8")).toBe("fix: y\n");
  });

  it("leaves a clean commit message untouched", () => {
    const msgPath = join(mkdtempSync(join(tmpdir(), "strip-trailers-")), "COMMIT_EDITMSG");
    writeFileSync(msgPath, "fix: y\n");

    expect(stripClaudeTrailers(msgPath)).toBe(0);
    expect(readFileSync(msgPath, "utf8")).toBe("fix: y\n");
  });

  it("never blocks the commit: a missing path or unreadable file is a no-op", () => {
    expect(stripClaudeTrailers(undefined)).toBe(0);
    expect(stripClaudeTrailers("/no/such/file")).toBe(0);
  });
});
