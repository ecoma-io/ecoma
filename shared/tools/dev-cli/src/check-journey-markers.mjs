/**
 * Catches roadmap/version/ticket journey markers (CLAUDE.md Rule 13) in the
 * surfaces the ESLint rules can't reach:
 * - file CONTENTS of non-JS/TS/Vue files (CSS, HTML, Markdown, …) — the
 *   `local/no-journey-markers` rule owns parseable sources;
 * - file and directory NAMES of every tracked file, and Nx target names in
 *   `project.json` — the `local/no-journey-marker-names` rule owns exported
 *   identifiers.
 *
 * Two entry points cover disjoint file sets so nothing is scanned twice:
 * - `check-journey-markers <path>` runs inside each project's `lint` target,
 *   covering that project's own files (CI `nx affected -t lint` + lefthook).
 * - `check-journey-markers-workspace` covers files owned by NO nx project
 *   (repo-root docs, `.github/`, `.claude/`, …) that no project lint reaches,
 *   plus the project directory paths themselves (a per-project scan only sees
 *   its own project-relative paths); wired into the lefthook pre-commit gate
 *   and a CI step.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { listTrackedFiles } from "./tracked-files.mjs";

// Patterns live in journey-markers.config.json at the repo root — the single
// source shared with the `local/no-journey-markers` and
// `local/no-journey-marker-names` ESLint rules. The path is fixed relative to
// this file (…/shared/tools/dev-cli/src → repo root).
const CONFIG_URL = new URL("../../../../journey-markers.config.json", import.meta.url);
const CONFIG = JSON.parse(readFileSync(CONFIG_URL, "utf8"));
export const MARKER_RE = new RegExp(CONFIG.pattern, "i");
const NAME_RE = new RegExp(CONFIG.namePattern);

// Contents already covered by the ESLint rule; re-scanning here would just
// double-report. Their file NAMES are still ours to scan.
const ESLINT_COVERED_RE = /\.(ts|tsx|vue|js|mjs|cjs)$/;

/** Returns `[{ line, match }]` for every journey marker in `text`. */
export function scanText(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    const match = line.match(MARKER_RE);
    if (match) hits.push({ line: i + 1, match: match[0] });
  });
  return hits;
}

/** Kebab-normalizes a name per the contract in journey-markers.config.json. */
function normalizeName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/**
 * Returns the offending journey token in a durable name (a path segment or an
 * Nx target name), or null. Dot-chunks are judged separately so `utils-new.ts`
 * is caught without its extension masking the trailing qualifier; the prose
 * pattern also runs on the raw name so plan/review-code file names are caught.
 */
export function scanName(name) {
  for (const chunk of name.split(".")) {
    if (!chunk) continue;
    const match = normalizeName(chunk).match(NAME_RE);
    if (match) return match[0].replace(/^-/, "");
  }
  const prose = name.match(MARKER_RE);
  return prose ? prose[0] : null;
}

/** Scans each file's text, reporting every marker. Returns true when any hit. */
function scanAndReportContents(files) {
  let failed = false;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // binary or unreadable
    }
    for (const { line, match } of scanText(text)) {
      failed = true;
      console.error(
        `${file}:${line}: journey marker '${match}' — describe behavior, not the phase/ticket that produced it (CLAUDE.md Rule 13)`,
      );
    }
  }
  return failed;
}

/**
 * Scans every path segment (file and directory names) of `paths`, reporting
 * each offending segment once even when many files share it. Returns true when
 * any hit.
 */
function scanAndReportNames(paths) {
  let failed = false;
  const seen = new Set();
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const partial = segments.slice(0, i + 1).join("/");
      if (seen.has(partial)) continue;
      seen.add(partial);
      const match = scanName(segments[i]);
      if (match) {
        failed = true;
        console.error(
          `${partial}: journey marker '${match}' in the name — name for the end state, not the phase/ticket that produced it (CLAUDE.md Rule 13)`,
        );
      }
    }
  }
  return failed;
}

/** Scans Nx target names in the given `project.json` files. Returns true when any hit. */
function scanAndReportTargets(manifests) {
  let failed = false;
  for (const manifest of manifests) {
    let targets;
    try {
      targets = JSON.parse(readFileSync(manifest, "utf8")).targets ?? {};
    } catch {
      continue; // unreadable or not JSON — not this gate's failure to report
    }
    for (const name of Object.keys(targets)) {
      const match = scanName(name);
      if (match) {
        failed = true;
        console.error(
          `${manifest}: journey marker '${match}' in target name '${name}' — name for the end state, not the phase/ticket that produced it (CLAUDE.md Rule 13)`,
        );
      }
    }
  }
  return failed;
}

/**
 * Keeps only the `files` that no nx project owns — i.e. not under any directory
 * holding one of `projectManifests` (the git-tracked `project.json` paths).
 * Pure, so the ownership split is unit-testable without touching git.
 */
export function workspaceLevelFiles(files, projectManifests) {
  const projectDirs = projectManifests.map((m) => dirname(m) + "/");
  return files.filter((f) => !projectDirs.some((dir) => f.startsWith(dir)));
}

/**
 * Scans git-tracked files that no nx project owns (repo-root docs, `.github/`,
 * `.claude/`, …) — the blind spot of the per-project scan — plus the project
 * directory paths themselves, whose names no project-relative scan sees.
 * Returns an exit code.
 */
export function checkWorkspaceDocs() {
  const manifests = listTrackedFiles(["*/project.json", "project.json"]);
  const files = workspaceLevelFiles(listTrackedFiles(), manifests);

  const contentHits = scanAndReportContents(files.filter((f) => !ESLINT_COVERED_RE.test(f)));
  const nameHits = scanAndReportNames([...files, ...manifests.map((m) => dirname(m))]);
  return contentHits || nameHits ? 1 : 0;
}

/** Scans git-tracked files under `targetPath`. Returns a process exit code. */
export function checkJourneyMarkers(targetPath = ".") {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const resolvedPath = resolve(targetPath);

  // Skip if the target path is outside the repository working tree.
  if (targetPath !== "." && resolvedPath !== repoRoot && !resolvedPath.startsWith(repoRoot + "/")) {
    return 0;
  }

  const files = execFileSync("git", ["ls-files", "--", targetPath], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

  const contentHits = scanAndReportContents(files.filter((f) => !ESLINT_COVERED_RE.test(f)));
  const nameHits = scanAndReportNames(files);
  const targetHits = scanAndReportTargets(
    files.filter((f) => f === "project.json" || f.endsWith("/project.json")),
  );
  return contentHits || nameHits || targetHits ? 1 : 0;
}
