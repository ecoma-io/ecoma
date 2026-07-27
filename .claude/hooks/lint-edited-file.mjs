#!/usr/bin/env node
// PostToolUse(Write|Edit) hook: lint the file that was just written — eslint
// for code files, the journey-marker check for HTML; exit 2 surfaces the
// violations to the agent immediately. Runs eslint's bin through Node directly
// (not `pnpm exec`) so the hook works wherever Node works.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

try {
  if (process.env.CLAUDE_PROJECT_DIR) process.chdir(process.env.CLAUDE_PROJECT_DIR);
} catch {
  process.exit(0); // no project directory — nothing to lint
}

const input = JSON.parse(readFileSync(0, "utf8"));
const file = input.tool_input?.file_path ?? "";
// Scratch files outside the project (e.g. the session scratchpad) are not ours
// to lint — the repo's eslint/journey-marker config does not apply to them.
if (!resolve(file).startsWith(process.cwd() + sep)) process.exit(0);

let argv = null;
if (/\.(vue|js|ts|mjs|cjs|astro)$/.test(file)) {
  argv = ["node_modules/eslint/bin/eslint.js", "--no-warn-ignored", "--max-warnings", "0", file];
} else if (file.endsWith(".html")) {
  argv = ["shared/tools/dev-cli/src/main.mjs", "check-journey-markers", file];
}
if (!argv) process.exit(0);

const r = spawnSync(process.execPath, argv, { encoding: "utf8" });
if (r.status !== 0) {
  if (r.error) process.stderr.write(`${r.error}\n`);
  process.stderr.write((r.stdout ?? "") + (r.stderr ?? ""));
  process.exit(2);
}
