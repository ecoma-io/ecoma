#!/usr/bin/env node
// PreToolUse(Artifact|SendUserFile) hook: validate every .html file being
// published with the html-artifact skill checks; exit 2 blocks the tool call.
// SendUserFile delivers full self-contained pages, so those validate with
// --standalone; the Artifact tool wraps body-only content, so its files
// validate in the default mode.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

try {
  if (process.env.CLAUDE_PROJECT_DIR) process.chdir(process.env.CLAUDE_PROJECT_DIR);
} catch {
  process.exit(0); // no project directory — nothing to validate against
}

const input = JSON.parse(readFileSync(0, "utf8"));
const flag = input.tool_name === "SendUserFile" ? ["--standalone"] : [];
const files = [
  input.tool_input?.file_path,
  ...(Array.isArray(input.tool_input?.files) ? input.tool_input.files : []),
].filter((f) => typeof f === "string" && f.endsWith(".html"));

let failed = false;
for (const file of files) {
  const r = spawnSync(
    process.execPath,
    [".claude/skills/html-artifact/scripts/check.mjs", file, ...flag],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    if (r.error) process.stderr.write(`${r.error}\n`);
    process.stderr.write((r.stdout ?? "") + (r.stderr ?? ""));
    failed = true;
  }
}
process.exit(failed ? 2 : 0);
