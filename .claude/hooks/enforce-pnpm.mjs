#!/usr/bin/env node
// PreToolUse(Bash) hook: deny npm/npx/yarn invocations — pnpm nx is the only
// task runner (CLAUDE.md > Workspace Execution). Reads the hook payload from
// stdin; a deny decision goes to stdout, silence means allow.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const command = input.tool_input?.command ?? "";
if (/(^|[;&|(`])[ \t]*(npm|npx|yarn)([ \t]|$)/m.test(command)) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "npm/npx/yarn are blocked in this repo — pnpm nx is the only task runner (CLAUDE.md > Workspace Execution).",
      },
    }),
  );
}
