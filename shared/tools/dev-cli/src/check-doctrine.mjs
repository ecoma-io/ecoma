/**
 * Three rules over the published doctrine tree (`shared/libs/doctrine`), all
 * enforcing the same thing from different sides: **a reader who has never met
 * us must be able to check every sentence.**
 *
 *  - **No episode coordinates.** A round number or a finding id is true only
 *    because we were present when it happened; it is unverifiable to everyone
 *    else and it dates a document that is meant to describe an end state. Git
 *    history is the log, and it cannot drift the way a hand-kept one does.
 *  - **No commercial markers.** Bet identifiers belong to the market ledger,
 *    which is not published. A threshold that tells an interviewee which answer
 *    "counts" contaminates the data it was collected to produce.
 *  - **No orphan reference families.** A document may cite a scenario, a gate
 *    or an ADR only if the file that owns that family travelled with it.
 *    Citing something a reader cannot open is a dangling promise, and it is the
 *    characteristic failure of a partial migration.
 *
 * The third rule is deliberately family-level rather than per-identifier.
 * Deciding whether `S31` is *defined* somewhere needs a notion of "definition"
 * that no regex holds honestly; deciding whether the catalog is present does
 * not. It catches the case that actually happens — a family left behind — and
 * refuses to guess at the one it cannot judge.
 *
 * What it does NOT do: detect confidential prose. No pattern can. This gate
 * catches *references*; semantic review stays with a human, which is why the
 * migration commits ask to be read before merge.
 */
import { readFileSync } from "node:fs";

import { listTrackedFiles } from "./tracked-files.mjs";

/** The published tree. Everything below is scoped to it. */
export const DOCTRINE_ROOT = "shared/libs/doctrine";

/**
 * Markers that must not survive redaction, each with the reason it goes — the
 * message a failing file shows, so the fix is obvious without opening this
 * file.
 */
export const FORBIDDEN = [
  {
    id: "round",
    pattern: /vòng \d+[a-z]?/g,
    why: "a round number is true only to whoever was in that round; git history is the log",
  },
  {
    id: "finding",
    pattern: /\b[Ff]\d{2}\b/g,
    why: "a finding id names an episode of our review, not a property of the design",
  },
  {
    id: "blind-spot",
    pattern: /\bW\d{1,2}\b/g,
    why: "keep what the blind spot is; drop the label that only indexes our own history",
  },
  {
    id: "bet",
    pattern: /\bB\d{1,2}\b/g,
    why: "bet identifiers belong to the market ledger, which is not published",
  },
];

/**
 * Reference families and the filename fragment of the document that owns each.
 * One named map rather than a condition per family (Rule 14): adding a family
 * is a line here, not a branch somewhere.
 */
export const FAMILIES = [
  { id: "scenario", pattern: /\bS\d{2}\b/, owner: "scenario", cites: "a scenario" },
  { id: "gate", pattern: /◆G\d/, owner: "roadmap", cites: "a freeze gate" },
  { id: "adr", pattern: /ADR-\d{4}/, owner: "adr", cites: "an ADR" },
];

/** Every forbidden marker in `text`, with its line number. Pure. */
export function findForbidden(text) {
  const lines = text.split("\n");
  const hits = [];
  for (const rule of FORBIDDEN) {
    lines.forEach((line, i) => {
      for (const match of line.matchAll(rule.pattern)) {
        hits.push({ line: i + 1, marker: match[0], id: rule.id, why: rule.why });
      }
    });
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Families cited by `files` whose owning document is absent from `files`.
 * Pure; `files` is a list of `{ path, text }`.
 */
export function findOrphanFamilies(files) {
  return FAMILIES.filter((family) => {
    const citedBy = files.filter((f) => family.pattern.test(f.text));
    if (citedBy.length === 0) return false;
    return !files.some((f) => f.path.includes(family.owner));
  });
}

/** Scans the published tree. Returns a process exit code. */
export function checkDoctrine(read = readFileSync, list = listTrackedFiles) {
  const paths = list([`${DOCTRINE_ROOT}/**/*.md`]);
  const files = paths.map((path) => ({ path, text: read(path, "utf8") }));

  let failed = false;
  for (const file of files) {
    for (const hit of findForbidden(file.text)) {
      console.error(`${file.path}:${hit.line}: '${hit.marker}' — ${hit.why}`);
      failed = true;
    }
  }
  for (const family of findOrphanFamilies(files)) {
    console.error(
      `${DOCTRINE_ROOT}: cites ${family.cites} but the document that owns that family did not travel with it`,
    );
    failed = true;
  }
  return failed ? 1 : 0;
}
