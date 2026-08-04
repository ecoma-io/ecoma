#!/usr/bin/env node
/**
 * repo-care — automation that cares for the repository itself (issue triage
 * today; further repo-care commands register here). Same shape as dev-cli:
 * each command is a thin wrapper over a module returning a process exit code,
 * invoked as `node shared/tools/repo-care/src/main.mjs <command>`. Argument
 * parsing stays minimal until several commands genuinely need a framework.
 */
import { auditRoadmapLabels } from "./audit-roadmap-labels.mjs";
import { claNotice } from "./cla-notice.mjs";
import { reviewPr } from "./review-pr.mjs";
import { translateIssue, translatePr } from "./translate-thread.mjs";
import { triageIssue } from "./triage-issue.mjs";

const COMMANDS = {
  "audit-roadmap-labels": (args) => auditRoadmapLabels(args),
  "cla-notice": (args) => claNotice(args),
  "review-pr": (args) => reviewPr(args),
  "translate-issue": (args) => translateIssue(args),
  "translate-pr": (args) => translatePr(args),
  "triage-issue": (args) => triageIssue(args),
};

const [command, ...args] = process.argv.slice(2);
const run = COMMANDS[command];

if (!run) {
  const known = Object.keys(COMMANDS).join(", ");
  console.error(`repo-care: unknown command '${command ?? ""}'. Available: ${known}`);
  process.exit(2);
}

process.exit((await run(args)) ?? 0);
