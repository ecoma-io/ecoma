/**
 * Flags a Markdown citation of a dev-cli invocation whose command name is not
 * in `main.mjs`'s `COMMANDS` registry — the drift class a rename leaves
 * behind. Renaming a command fails loud everywhere it is EXECUTED (lefthook,
 * CI, a project's own `lint` target all exit 2 with "unknown command '…'");
 * nothing previously caught the prose that still told a human or an agent to
 * run the old name.
 *
 * Only the unambiguous invocation form is checked:
 *   node shared/tools/dev-cli/src/main.mjs <name>
 * A bare inline-code span (`` `check-doc-links` ``) is far more common but
 * ambiguous: the same word can be ordinary prose, can name a command of a
 * DIFFERENT main.mjs (`repo-care` answers its own `main.mjs triage-issue`,
 * never this path), or can be a seam the doctrine corpus deliberately reserves
 * before it exists (e.g. `check-backup-key-isolation`, explicitly marked
 * "chưa tồn tại" in `charter/deploy.md`). None of those write the full
 * invocation form, so anchoring on it is precise without a denylist.
 *
 * The registry is derived, never restated (Rule 14 rung 1). `main.mjs` calls
 * `process.exit` at import time, so it cannot be imported for its keys — the
 * same reason `main.integration.test.mjs` drives it as a subprocess instead.
 * This gate does the same: it runs the real CLI with no command and reads its
 * own "unknown command '…'. Available: …" listing off stderr.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listTrackedFiles } from "./tracked-files.mjs";

const MAIN = fileURLToPath(new URL("./main.mjs", import.meta.url));

// The one shape nobody writes aspirationally: a literal invocation naming this
// CLI's own entry point, immediately followed by the command name.
const INVOCATION_RE = /shared\/tools\/dev-cli\/src\/main\.mjs\s+([a-z][a-z0-9-]*)/g;

function defaultRun() {
  return spawnSync(process.execPath, [MAIN], { encoding: "utf8" }).stderr;
}

/**
 * Runs the real CLI with no command so it reports its own known-command
 * listing, and returns the parsed command names. `run` is injectable so this
 * is unit-testable without spawning a process.
 */
export function deriveCommandNames(run = defaultRun) {
  const stderr = run();
  const match = stderr.match(/Available: (.+)/);
  if (!match) {
    throw new Error(`could not parse dev-cli's known-command list from: ${stderr}`);
  }
  return match[1].split(",").map((s) => s.trim());
}

/**
 * Returns `[{ command, line }]` for every dev-cli invocation in `text` whose
 * command name is not in `known`. Pure — unit-testable without git or a
 * spawned process.
 */
export function findUnknownCommandRefs(text, known) {
  const hits = [];
  for (const m of text.matchAll(INVOCATION_RE)) {
    const command = m[1];
    if (!known.includes(command)) {
      hits.push({ command, line: text.slice(0, m.index).split("\n").length });
    }
  }
  return hits;
}

/** Scans every git-tracked Markdown file in the repo. Returns a process exit code. */
export function checkCommandRefs() {
  const known = deriveCommandNames();
  const files = listTrackedFiles(["*.md", "*.mdx"]);

  let failed = false;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { command, line } of findUnknownCommandRefs(text, known)) {
      failed = true;
      console.error(
        `${file}:${line}: citation of unknown dev-cli command '${command}' — main.mjs's COMMANDS registry no longer has it`,
      );
    }
  }
  return failed ? 1 : 0;
}
