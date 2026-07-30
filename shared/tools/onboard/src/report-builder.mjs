#!/usr/bin/env node
/**
 * Orchestrator: runs doctrine-reader, nx-reader, and git-reader, then
 * assembles a unified onboarding report as JSON.
 *
 * Outputs to stdout. The skill then decides whether to render as prose
 * or as an HTML artifact.
 *
 * Usage:
 *   node shared/tools/onboard/src/report-builder.mjs [--window week]
 *
 * The report structure:
 *   {
 *     generatedAt: <ISO timestamp>,
 *     window: <resolved window>,
 *     targetArchitecture: { ... from doctrine },
 *     currentArchitecture: { ... from nx graph },
 *     roadmapProgress: { milestones, coverage, churn, ... },
 *     gaps: { ... from doctrine }  // known gaps + reserved seams
 *   }
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function run(script, ...args) {
  try {
    const out = execFileSync("node", [resolve(SCRIPT_DIR, script), ...args], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60000,
    });
    return JSON.parse(out);
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : "";
    const msg = stderr
      ? `${script} failed: ${stderr.split("\n").pop()}`
      : `${script} failed with status ${err.status}`;
    throw new Error(msg, { cause: err });
  }
}

function main() {
  const args = process.argv.slice(2);
  const windowFlag = args.find((a) => a.startsWith("--window="));
  const windowArg = windowFlag ? windowFlag.slice("--window=".length) : "week";

  const doctrine = run("doctrine-reader.mjs");
  const nx = run("nx-reader.mjs");
  const git = run("git-reader.mjs", `--window=${windowArg}`);

  // Build the unified report
  const report = {
    generatedAt: new Date().toISOString(),
    window: {
      label: git.window.label,
      focusSince: git.window.focus,
    },
    targetArchitecture: {
      vision: doctrine.endState?.vision || "",
      systemShape: doctrine.systemShape || "",
      principles: doctrine.endState?.principles || [],
      invariants: doctrine.endState?.invariants || [],
      primitives: doctrine.endState?.primitives || [],
      layers: doctrine.endState?.layers || [],
      milestones: doctrine.milestones || [],
    },
    currentArchitecture: {
      source: nx.source,
      groupCount: nx.groupKeys?.length || 0,
      groups: nx.groups || {},
      totalProjects: nx.nodes?.length || 0,
    },
    roadmapProgress: {
      knownGaps: doctrine.gaps || [],
      milestones: doctrine.milestones || [],
      git: {
        totalCommits: git.allTime?.totalCommits || 0,
        firstCommit: git.allTime?.firstCommit || "",
        topAuthors: git.allTime?.topAuthors || [],
        contextCommits: git.contextSpan?.totalCommits || 0,
        contextChurn: git.contextSpan?.churn || [],
        focusCommits: git.focusSpan?.totalCommits || 0,
        focus: git.focusSpan?.commits || [],
      },
    },
  };

  process.stdout.write(JSON.stringify(report, null, 2));
}

main();
