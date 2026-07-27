/**
 * Enforces the root CLAUDE.md Documentation mandate mechanically: every Nx
 * subproject (each git-tracked `project.json`) carries a sibling `CLAUDE.md`.
 * Existence only — content quality (scope line, no copied-down rules,
 * proportional length) stays on review, where judgment lives.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Returns the subset of `projectFiles` (paths to `project.json` files) whose
 * directory lacks a `CLAUDE.md`. `exists` is injectable so the logic is
 * unit-testable without a real filesystem.
 */
export function findMissingClaudeMd(projectFiles, exists = existsSync) {
  return projectFiles.filter((p) => !exists(join(dirname(p), "CLAUDE.md")));
}

/** Scans every git-tracked `project.json` in the repo. Returns a process exit code. */
export function checkClaudeMd() {
  const files = execFileSync("git", ["ls-files", "--", "*project.json"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => basename(f) === "project.json");

  const missing = findMissingClaudeMd(files);
  for (const file of missing) {
    console.error(
      `${file}: missing sibling CLAUDE.md — every Nx subproject carries one (root CLAUDE.md, Documentation)`,
    );
  }
  return missing.length > 0 ? 1 : 0;
}
