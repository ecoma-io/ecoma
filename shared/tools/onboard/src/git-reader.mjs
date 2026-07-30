#!/usr/bin/env node
/**
 * Deterministic reader of git history with temporal level-of-detail.
 *
 * Three bands: all-time (compressed), context (medium), focus (detailed).
 * The focus band is set by the `--window` argument: day | week (default) | month | since=<expr>.
 *
 * Usage: node shared/tools/onboard/src/git-reader.mjs [--window week]
 */
import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: "pipe" }).trim();
}

function resolveWindow(raw) {
  const arg = (raw || "week").trim();
  const VALID = new Set(["day", "week", "month"]);
  const sinceMatch = arg.match(/^since=(.+)$/);
  if (sinceMatch) {
    return { focus: sinceMatch[1], context: "3 months ago", label: arg };
  }
  if (!VALID.has(arg)) {
    throw new Error(
      `Invalid --window value '${arg}'. Expected: day, week, month, or since=<git-date> (e.g. since=2026-06-01)`,
    );
  }
  switch (arg) {
    case "day":
      return { focus: "1 day ago", context: "1 week ago", label: "day" };
    case "week":
      return { focus: "1 week ago", context: "1 month ago", label: "week" };
    case "month":
      return { focus: "1 month ago", context: "3 months ago", label: "month" };
  }
}

function bandA() {
  const totalCommits = git(["log", "--oneline"]).split("\n").length;
  const firstCommit =
    git(["log", "--reverse", "--format=%ad %s", "--date=short"]).split("\n")[0] || "none";
  const topAuthors = git(["shortlog", "-sn", "--all", "--no-merges", "-20"]);
  return { totalCommits, firstCommit, topAuthors: topAuthors.split("\n").filter(Boolean) };
}

function bandB(since) {
  const log = git(["log", "--since=" + since, "--date=short", "--pretty=%ad %s"]);
  const files = git(["log", "--since=" + since, "--name-only", "--pretty=format:"])
    .split("\n")
    .filter(Boolean);
  const churn = {};
  for (const f of files) {
    const top = f.split("/")[0];
    churn[top] = (churn[top] || 0) + 1;
  }
  const sortedChurn = Object.entries(churn)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([dir, count]) => ({ dir, count }));
  return {
    totalCommits: log.split("\n").filter(Boolean).length,
    subjects: log.split("\n").slice(0, 50),
    churn: sortedChurn,
  };
}

function bandC(since) {
  const log = git(["log", "--since=" + since, "--stat", "--pretty=%h %ad %s", "--date=short"]);
  const lines = log.split("\n");
  const commits = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^([0-9a-f]{7,})\s+(\S+)\s+(.+)/);
    if (m) {
      if (current) commits.push(current);
      current = { hash: m[1], date: m[2], subject: m[3], files: [] };
    } else if (current && line.trim() && line.startsWith(" ") && line.includes("|")) {
      const parts = line.trim().split(/\s+\|?\s*/);
      current.files.push(parts[0]);
    }
  }
  if (current) commits.push(current);
  return { totalCommits: commits.length, commits: commits.slice(0, 100) };
}

function main() {
  const args = process.argv.slice(2);
  const windowFlag = args.find((a) => a.startsWith("--window="));
  const windowArg = windowFlag ? windowFlag.slice("--window=".length) : args[0] || "week";
  const w = resolveWindow(windowArg);

  const result = {
    window: { focus: w.focus, context: w.context, label: w.label },
    allTime: bandA(),
    contextSpan: bandB(w.context),
    focusSpan: bandC(w.focus),
  };

  process.stdout.write(JSON.stringify(result, null, 2));
}

main();
