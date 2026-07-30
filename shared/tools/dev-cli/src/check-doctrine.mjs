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
 *  - **No stale translation.** A variant records a fingerprint of the canonical
 *    text it was made from. Edit the canonical and the fingerprint no longer
 *    matches, so the variant fails until someone looks at it. A translation
 *    nobody re-read is not a smaller version of the truth — it is a second
 *    document, carrying authority it no longer earns, in the language of the
 *    reader least able to notice.
 *
 * Two of the marker patterns are narrower than their names suggest, and both
 * narrowings are load-bearing rather than oversights. A finding id is matched
 * only zero-padded (`F04`), because the rubric's own group-F criteria are
 * written unpadded (`F3`) and a pattern covering both would delete the
 * corpus's internal referencing to catch a handful of episode labels — the
 * same reason a bare B-number is left alone and only `BET-12` is refused. A
 * round code is matched only as two digits and a letter, which is every form
 * the corpus actually uses; a bare `#4` is indistinguishable from an ordinal
 * and stays on review.
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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { linkTargets } from "./check-doc-links.mjs";
import { LANGS } from "./readme-schema.mjs";
import { listTrackedFiles } from "./tracked-files.mjs";

/** The published tree. Everything below is scoped to it. */
export const DOCTRINE_ROOT = "shared/libs/doctrine";

/**
 * The pathspec naming the documents this gate judges: markdown inside the
 * tree's families, and deliberately not the project's own `README.md` triad or
 * its `CLAUDE.md`, which sit at the root. Those carry a different contract —
 * the README triad is a fixed-order frontmatter block gated by
 * `check-subproject-readmes`, in which a `canonical-sha` key is a violation
 * rather than a requirement, and its three languages are peers rather than a
 * canonical with variants.
 *
 * Named rather than written inline because `doctrine-sync` writes the
 * fingerprints this gate reads: the two scanning different sets is exactly how
 * a README acquires a key no gate asked for.
 */
export const DOCTRINE_DOCS = `${DOCTRINE_ROOT}/**/*.md`;

/**
 * Markers that must not survive redaction, each with the reason it goes — the
 * message a failing file shows, so the fix is obvious without opening this
 * file.
 */
export const FORBIDDEN = [
  {
    id: "round",
    pattern: /\b(?:vòng|round)\s*#?\s*\d+[a-z]?\b/gi,
    why: "a round number is true only to whoever was in that round; git history is the log",
  },
  {
    id: "round-code",
    pattern: /\b\d{2}[a-z]\b/g,
    why: "a round code is a round number with the word dropped, and dates the document the same way",
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
    pattern: /\bBET-\d{1,2}\b/g,
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

/**
 * The corpus map: the one document that routes a reader to every other. A
 * published page it does not name is a page nobody arrives at, and nobody
 * reports a page they do not know exists — the same failure `buildNav`'s
 * refusals close on the site, closed here on the content instead.
 */
export const CORPUS_MAP = `${DOCTRINE_ROOT}/overview/index.md`;

/**
 * Documents in `files` the corpus map does not route to. Pure; `files` is a
 * list of `{ path, text }`.
 *
 * Only this direction. A map row pointing at a file that does not exist is
 * already `check-doc-links`' answer, and a second gate for it would report the
 * same defect twice.
 *
 * Translation variants are skipped rather than required: a variant is the same
 * document as its canonical, so the canonical's row routes both, and an
 * orphaned variant is `findStaleVariants`' finding, not this one's.
 */
export function findUnmappedDocuments(files) {
  if (files.length === 0) return []; // nothing published yet, so nothing to route

  const map = files.find((f) => f.path === CORPUS_MAP);
  if (!map) return [{ path: CORPUS_MAP, why: "the corpus map itself is missing" }];

  const routed = new Set(linkTargets(map.text, map.path).map((link) => link.resolved));
  return files
    .filter((f) => f.path !== CORPUS_MAP && !variantOf(f.path) && !routed.has(resolve(f.path)))
    .map((f) => ({
      path: f.path,
      why: `no row in ${CORPUS_MAP} — a published document the corpus map does not route to`,
    }));
}

/**
 * How the corpus map says a document exists but is not published here.
 *
 * Hardcoded rather than derived or configured, and this is the Rule 14 case
 * that permits it: the phrase is the corpus map's own vocabulary, it appears in
 * exactly one place in code, and a config file read by a single consumer would
 * be infrastructure out of all proportion to one string. It reaches the author
 * through the failure message, which prints it — so the document and the gate
 * cannot disagree about the spelling without the gate saying so.
 */
export const WITHHELD_MARKER = "(không công bố)";

/** Blocks of consecutive table lines, each row carrying its 1-based line. */
function tablesIn(text) {
  const tables = [];
  let current = null;
  text.split("\n").forEach((line, i) => {
    if (!line.trimStart().startsWith("|")) return void (current = null);
    if (!current) tables.push((current = []));
    current.push({ line: i + 1, text: line });
  });
  return tables;
}

const firstCell = (row) => (row.split("|")[1] ?? "").trim();
const SEPARATOR = /^[\s|:-]+$/;

/**
 * Inventory rows that neither route to a document nor declare it withheld.
 * Pure; `files` is a list of `{ path, text }`.
 *
 * An unlinked name reads as a document the reader failed to find, when what it
 * usually is, is a document they were never meant to have. Absence cannot say
 * which; only a positive mark can, and this is the gate that keeps the mark
 * from being forgotten on the next row someone adds.
 *
 * The inventory table is **found, not named**: it is the one whose first column
 * links into the tree at all. Naming it by its heading would hardcode a phrase
 * in a document free to rephrase it, and the map's other tables — known gaps,
 * the licence ledger, the publishing policy — carry no such link in that
 * column, so the derivation selects exactly one table without being told which.
 */
export function findUnmarkedEntries(files) {
  const map = files.find((f) => f.path === CORPUS_MAP);
  if (!map) return []; // an absent map is findUnmappedDocuments' finding, not a second one

  const root = resolve(DOCTRINE_ROOT);
  const routes = (cell) =>
    linkTargets(cell, CORPUS_MAP).some((link) => link.resolved.startsWith(`${root}/`));

  const problems = [];
  for (const rows of tablesIn(map.text)) {
    if (!rows.some((row) => routes(firstCell(row.text)))) continue;
    rows.forEach((row, i) => {
      const cell = firstCell(row.text);
      if (i === 0 || SEPARATOR.test(row.text) || !cell) return;
      if (routes(cell) || cell.includes(WITHHELD_MARKER)) return;
      problems.push({
        line: row.line,
        why:
          `'${cell}' neither links to a document nor carries '${WITHHELD_MARKER}' — ` +
          `a reader cannot tell a withheld document from a missing one`,
      });
    });
  }
  return problems;
}

/** Scans the published tree. Returns a process exit code. */
export function checkDoctrine(read = readFileSync, list = listTrackedFiles) {
  const paths = list([DOCTRINE_DOCS]);
  const files = paths.map((path) => ({ path, text: read(path, "utf8") }));

  let failed = false;
  for (const file of files) {
    for (const hit of findForbidden(file.text)) {
      console.error(`${file.path}:${hit.line}: '${hit.marker}' — ${hit.why}`);
      failed = true;
    }
  }
  for (const problem of findStaleVariants(files)) {
    console.error(`${problem.path}: ${problem.kind} translation — ${problem.why}`);
    failed = true;
  }
  for (const problem of findUnmappedDocuments(files)) {
    console.error(`${problem.path}: ${problem.why}`);
    failed = true;
  }
  for (const problem of findUnmarkedEntries(files)) {
    console.error(`${CORPUS_MAP}:${problem.line}: ${problem.why}`);
    failed = true;
  }
  for (const family of findOrphanFamilies(files)) {
    console.error(
      `${DOCTRINE_ROOT}: cites ${family.cites} but the document that owns that family did not travel with it`,
    );
    failed = true;
  }
  return failed ? 1 : 0;
}

/**
 * Variant filename suffixes: the workspace triad minus its canonical, DERIVED
 * from `languages.config.json` through `readme-schema` rather than restated.
 * The config is ordered and a consumer needing a default takes the first entry,
 * which is what makes `LANGS[0]` the canonical and the rest variants — so
 * adding a language is one line in the config, and this module follows without
 * being touched. Restating the list here would have been a second copy of the
 * very file cited two lines above as the authority.
 *
 * The split is a pure function so it can be pinned against a fabricated triad.
 * Asserting against the real config cannot tell derivation from a lucky
 * hardcode — `["vi", "zh"]` written by hand satisfies it exactly.
 *
 * A canonical document is plain `<name>.md`; a variant is `<name>.<lang>.md`.
 *
 * A document is allowed to have no variant at all. It is not allowed to have
 * one that has fallen behind: holding the whole ceiling hostage to translation
 * would stop the migration for as long as the translation takes, while a stale
 * variant is worse than an absent one — it carries authority it no longer earns,
 * in the language of the reader least able to notice.
 */
export function splitLangs(langs) {
  return { canonical: langs[0], variants: langs.slice(1) };
}

export const { canonical: CANONICAL_LANG, variants: VARIANT_LANGS } = splitLangs(LANGS);

/** Short content fingerprint of a canonical document. Pure given its text. */
export function fingerprint(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

/** `{ canonicalPath, lang }` for a variant path, or null when it is canonical. */
export function variantOf(path) {
  const match = /^(.*)\.(\w+)\.md$/.exec(path);
  if (!match || !VARIANT_LANGS.includes(match[2])) return null;
  return { canonicalPath: `${match[1]}.md`, lang: match[2] };
}

const RECORDED = /^canonical-sha:\s*([0-9a-f]{12})\s*$/m;

/**
 * Every variant in `files` that is orphaned, unmarked, or behind its canonical.
 * Pure; `files` is a list of `{ path, text }`.
 */
export function findStaleVariants(files) {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const problems = [];
  for (const file of files) {
    const variant = variantOf(file.path);
    if (!variant) continue;
    const canonical = byPath.get(variant.canonicalPath);
    if (canonical === undefined) {
      problems.push({
        path: file.path,
        kind: "orphan",
        why: `no canonical ${variant.canonicalPath}`,
      });
      continue;
    }
    const recorded = RECORDED.exec(file.text);
    const expected = fingerprint(canonical);
    if (!recorded) {
      problems.push({
        path: file.path,
        kind: "unmarked",
        why: `add \`canonical-sha: ${expected}\` to its frontmatter`,
      });
    } else if (recorded[1] !== expected) {
      problems.push({
        path: file.path,
        kind: "stale",
        why: `canonical changed since this was written — re-read it, then record ${expected}`,
      });
    }
  }
  return problems;
}
