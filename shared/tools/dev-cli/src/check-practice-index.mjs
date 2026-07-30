/**
 * Keeps `practice-index.json` (repo root) honest about the prose it points at.
 *
 * Each card cites a CLAUDE.md tier by path plus a verbatim `quote`; this gate
 * fails when that quote no longer appears in that file, so a rule that was
 * reworded or deleted cannot leave a card behind still asserting it. The quote
 * is also the locator — errors report the line it was found on, which is why
 * cards carry no fragile heading anchor.
 *
 * A quote rather than a content hash, deliberately: rule churn in this repo
 * is overwhelmingly additive, and a section hash would fail on every unrelated
 * addition inside the same section. A gate that cries wolf gets bypassed. What
 * this gate covers is "the cited text still exists"; whether a summary is still
 * semantically right stays on review — the same mechanical/judgment split
 * `check-claude-md` (existence, not content) and `check-doc-links` (target
 * exists, not link text) already make.
 *
 * Scope globs are checked too: one that matches no tracked file is dead
 * routing, which is how a card silently stops reaching the edits it was
 * written for.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";

import { cwdGitEnv } from "./git-env.mjs";

const INDEX_PATH = "practice-index.json";

// A quote short enough to match incidental prose is not an anchor — it would
// keep passing after the rule it cites is gone.
const MIN_QUOTE_CHARS = 20;

// A wrapped quote spans consecutive source lines; six covers the longest
// bullet prose in the tier without letting an unrelated match drift in.
const MAX_QUOTE_LINES = 6;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Collapses whitespace runs so a hard-wrapped source matches a one-line quote. */
export function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Returns the 1-based line where `quote` STARTS in `sourceText`, or null when
 * it is absent. The whole file is normalized once and each character mapped
 * back to its source line, so a quote the source hard-wraps still reports the
 * line the rule opens on rather than wherever the search happened to begin.
 * A match spanning more than `MAX_QUOTE_LINES` is rejected and the search
 * continues: a quote names one contiguous passage, never scattered fragments
 * that happen to normalize into sequence.
 */
export function findQuoteLine(sourceText, quote) {
  const needle = normalize(quote);
  if (!needle) return null;

  let doc = "";
  const lineOf = [];
  sourceText.split("\n").forEach((raw, index) => {
    const line = normalize(raw);
    if (!line) return;
    if (doc) {
      doc += " ";
      lineOf.push(index + 1);
    }
    doc += line;
    for (let i = 0; i < line.length; i++) lineOf.push(index + 1);
  });

  for (let at = doc.indexOf(needle); at !== -1; at = doc.indexOf(needle, at + 1)) {
    const first = lineOf[at];
    const last = lineOf[at + needle.length - 1];
    if (last - first + 1 <= MAX_QUOTE_LINES) return first;
  }
  return null;
}

function checkShared(card, kind, problems, seen, readSource) {
  const id = card.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    problems.push(`${kind} card ${JSON.stringify(id)}: id must be kebab-case`);
    return;
  }
  if (seen.has(id)) problems.push(`card '${id}': duplicate id`);
  seen.add(id);

  if (!card.summary?.trim()) problems.push(`card '${id}': empty summary`);

  // Every card must answer the triage question — a rule a gate could hold
  // does not belong here at all (practice-index.json, $admission).
  if (!("gate" in card)) {
    problems.push(`card '${id}': missing 'gate' (use null when none)`);
  } else if (card.gate !== null && typeof card.gate !== "string") {
    problems.push(`card '${id}': 'gate' must be a command string or null`);
  }
  if (!card.gateNote?.trim()) {
    problems.push(`card '${id}': empty gateNote — say why a gate does or cannot cover this`);
  }

  if (!card.source?.trim()) {
    problems.push(`card '${id}': empty source`);
    return;
  }
  if (typeof card.quote !== "string" || normalize(card.quote).length < MIN_QUOTE_CHARS) {
    problems.push(`card '${id}': quote must be at least ${MIN_QUOTE_CHARS} characters`);
    return;
  }

  let text;
  try {
    text = readSource(card.source);
  } catch {
    problems.push(`card '${id}': source '${card.source}' does not exist`);
    return;
  }
  if (findQuoteLine(text, card.quote) === null) {
    problems.push(
      `card '${id}': quote not found in ${card.source} — the rule moved, was reworded, or was deleted; re-read it and update the card`,
    );
  }
}

/**
 * Returns a list of human-readable problems (empty when the index is sound).
 * `readSource` and `tracked` are injectable so the rules are unit-testable
 * without a filesystem or a git repository.
 */
export function validateIndex(index, readSource, tracked) {
  const problems = [];
  const seen = new Set();

  for (const kind of ["pathCards", "diffCards"]) {
    if (!Array.isArray(index?.[kind])) {
      problems.push(`${INDEX_PATH}: '${kind}' must be an array`);
    }
  }
  if (problems.length > 0) return problems;

  for (const card of index.pathCards) {
    checkShared(card, "path", problems, seen, readSource);
    if (!Array.isArray(card.scope) || card.scope.length === 0) {
      problems.push(`card '${card.id}': pathCards need a non-empty scope`);
      continue;
    }
    for (const glob of card.scope) {
      if (typeof glob !== "string" || !glob.trim()) {
        problems.push(`card '${card.id}': scope entries must be non-empty globs`);
      } else if (!tracked.some((f) => matchesGlob(f, glob))) {
        problems.push(`card '${card.id}': scope '${glob}' matches no tracked file — dead routing`);
      }
    }
  }

  for (const card of index.diffCards) {
    checkShared(card, "diff", problems, seen, readSource);
    if ("scope" in card) {
      problems.push(
        `card '${card.id}': diffCards are judged against the diff, not paths — drop 'scope'`,
      );
    }
  }

  return problems;
}

/** Scans the repo-root index against the working tree. Returns a process exit code. */
export function checkPracticeIndex() {
  let index;
  try {
    index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
  } catch (err) {
    console.error(`${INDEX_PATH}: cannot read or parse — ${err.message}`);
    return 1;
  }

  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8", env: cwdGitEnv() })
    .split("\n")
    .filter(Boolean);
  const problems = validateIndex(index, (p) => readFileSync(p, "utf8"), tracked);

  for (const problem of problems) console.error(`${INDEX_PATH}: ${problem}`);
  return problems.length > 0 ? 1 : 0;
}
