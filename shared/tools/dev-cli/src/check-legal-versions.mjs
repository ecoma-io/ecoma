/**
 * Holds every restatement of a legal document's version and effective date to
 * the document itself.
 *
 * `CLA.md` and `CORPORATE-CLA.md` each open with
 * `**Version <n>, effective <date>.**`, and the pair is then repeated in prose
 * elsewhere — `CLA.md` summarises the other agreements under "The other
 * agreements", `CORPORATE-CLA.md` pins the `CLA.md` version its definitions are
 * taken from, and the doctrine overview's legal rows quote both. Nothing forced
 * those copies to move with the documents, and some had already drifted a whole
 * version and a whole date behind. That is Rule 14's stated failure mode: a
 * value copied across ≥2 files was never a valid hardcode, it was an unsynced
 * config that skipped rung 2.
 *
 * **Where the single value lives, and why not git.** The named home is the
 * document's own `**Version …**` line — the document is the only honest author
 * of its own version, because a config file naming `CLA.md`'s version would be
 * a second place to edit and could label the text with a version the text does
 * not carry. Deriving the effective date from git (`git log -1 -- CLA.md`) was
 * rejected for the same reason it looks attractive: git answers *when the file
 * last changed*, and a typo fix would move an effective date that no editor
 * intended to move. Both halves are editorial acts, so both are authored once,
 * in the one place a signatory who was handed a copy of the document can read —
 * `CORPORATE-CLA.md` is explicitly a document a company signs and keeps, and
 * this repository's history is not in that filing cabinet. What this gate adds
 * is the part a single home cannot give on its own: every *other* mention is a
 * restatement, and a restatement that disagrees is a defect caught here.
 *
 * **Both the sources and the restatements are derived, never listed.** A
 * document is a source because it declares the line, so publishing a fourth
 * legal text needs no edit here. A mention is a restatement because a version
 * or an effective-date claim follows the document's filename closely enough to
 * be about it — which is what a reader concludes too. The scan is over tracked
 * Markdown in every language the tree carries, because the drift that actually
 * happened was in a translation as well as in its canonical.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { listTrackedFiles } from "./tracked-files.mjs";

/**
 * The line a legal document declares itself with, e.g.
 * `**Version 1.1, effective 2026-08-04.**`. Both captures are required: a
 * document that declares one half and not the other cannot be the source of
 * truth for what its restatements claim, and the gate would rather see no
 * source than half of one.
 */
const DECLARATION_RE = /^\*\*Version\s+(\d+(?:\.\d+)*),\s*effective\s+(\d{4}-\d{2}-\d{2})\.?\*\*/m;

/**
 * A version claim, in every language this tree publishes prose in. The
 * canonical texts are English, the doctrine overview has a Vietnamese variant,
 * and the READMEs add Chinese — a gate that only read English would go quiet
 * on exactly the reader least able to notice the drift.
 */
const VERSION_CLAIM_RE = /(?:version|phiên bản|版本)\s*(\d+(?:\.\d+)*)/gi;

/** An effective-date claim, same three languages. */
const EFFECTIVE_CLAIM_RE =
  /(?:effective(?:\s+(?:from|on))?|hiệu lực(?:\s+từ)?|生效(?:日期)?)[\s:]*(\d{4}-\d{2}-\d{2})/gi;

/**
 * How far past a document's filename a claim is still read as being about that
 * document. Bounded because prose moves on: two paragraphs later, "version 2.0"
 * is about something else. A window that also stops at the next legal
 * document's name (see `restatementsIn`) is what keeps adjacent bullets — the
 * shape `CLA.md`'s "The other agreements" section is written in — from being
 * read as claims about each other.
 */
export const CLAIM_WINDOW = 200;

/** Literal text made safe to embed in a RegExp source. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A filename mention, bounded on both sides so a longer name never matches a
 * shorter one inside it. `CORPORATE-CLA.md` ends with the literal text
 * `CLA.md`, so without the left boundary every corporate mention would also be
 * read as a mention of the personal agreement — and the corporate version would
 * be checked against the wrong document.
 */
const mentionRe = (name) => new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w-])`, "g");

/**
 * What `text` declares about itself, as `{ version, effective }`, or `null`
 * when it declares nothing. A file with no declaration is not a legal document
 * for this gate's purposes — that is how the source set stays derived.
 */
export function declaredVersion(text) {
  const m = text.match(DECLARATION_RE);
  return m ? { version: m[1], effective: m[2] } : null;
}

/**
 * Every version/effective claim `text` makes *about* one of `names`, as
 * `[{ name, kind, claimed, line }]`. Pure, so the window rules are testable
 * without a tree.
 *
 * A window opens at the end of each filename mention and closes at whichever
 * comes first: `CLAIM_WINDOW` characters, or the next mention of any legal
 * document — including another mention of the same one. The second boundary is
 * what makes a list of documents safe to write as a list: the paragraph about
 * one agreement cannot lend its version to the paragraph about the next one.
 */
export function restatementsIn(text, names) {
  const mentions = [];
  for (const name of names) {
    for (const m of text.matchAll(mentionRe(name))) {
      mentions.push({ name, at: m.index, end: m.index + name.length });
    }
  }
  mentions.sort((a, b) => a.at - b.at);

  const found = [];
  for (const [i, mention] of mentions.entries()) {
    const next = mentions[i + 1]?.at ?? text.length;
    const window = text.slice(mention.end, Math.min(next, mention.end + CLAIM_WINDOW));
    for (const [kind, re] of [
      ["version", VERSION_CLAIM_RE],
      ["effective date", EFFECTIVE_CLAIM_RE],
    ]) {
      // Fresh lastIndex per window: these are module-level /g regexes.
      re.lastIndex = 0;
      const m = re.exec(window);
      if (!m) continue;
      found.push({
        name: mention.name,
        kind,
        claimed: m[1],
        line: text.slice(0, mention.at).split("\n").length,
      });
    }
  }
  return found;
}

/**
 * The faults in one file's restatements, as strings. `sources` maps a
 * document's filename to what it declares. A claim about a document that
 * declares nothing is not judged here — `checkLegalVersions` never puts such a
 * document in `sources`, so it is not a name this function is asked about.
 */
export function auditRestatements(text, sources) {
  const faults = [];
  for (const { name, kind, claimed, line } of restatementsIn(text, Object.keys(sources))) {
    const declared = kind === "version" ? sources[name].version : sources[name].effective;
    if (claimed !== declared) {
      faults.push(
        `${line}: says ${name} is at ${kind} ${claimed}, but ${name} declares ${declared} — ` +
          `the document's own '**Version …, effective ….**' line is the single source of truth ` +
          `for both halves; move the restatement, or the document, so they agree`,
      );
    }
  }
  return faults;
}

/**
 * Every tracked Markdown file that declares a version line, keyed by filename.
 * Two files with the same basename in different directories would be
 * indistinguishable to a prose mention, so the second one is refused rather
 * than silently shadowing the first. A legal text is exactly the kind of file
 * that gets copied — vendored beside the code it governs, or carried into a
 * package — and that is how the collision arrives.
 */
export function legalSources(files, read = (f) => readFileSync(f, "utf8")) {
  const sources = {};
  const collisions = [];
  for (const file of files) {
    let declared;
    try {
      declared = declaredVersion(read(file));
    } catch {
      continue;
    }
    if (!declared) continue;
    const name = basename(file);
    if (sources[name]) collisions.push({ name, files: [sources[name].file, file] });
    else sources[name] = { ...declared, file };
  }
  return { sources, collisions };
}

/** Returns a process exit code. */
export function checkLegalVersions() {
  const files = listTrackedFiles(["*.md"]);
  const { sources, collisions } = legalSources(files);

  let failed = false;
  for (const { name, files: both } of collisions) {
    failed = true;
    console.error(
      `${both[1]}: a second '${name}' declares a version line (the first is ${both[0]}) — ` +
        `a prose mention of '${name}' cannot say which one it means, so this gate refuses to guess`,
    );
  }

  if (Object.keys(sources).length === 0) {
    console.error(
      "check-legal-versions: no tracked Markdown declares a '**Version …, effective ….**' line — " +
        "either every legal document lost its declaration, or the line's shape changed and this " +
        "gate is now judging nothing",
    );
    return 1;
  }

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const fault of auditRestatements(text, sources)) {
      failed = true;
      console.error(`${file}:${fault}`);
    }
  }

  if (!failed) {
    // Names what was judged, so a source set that silently narrowed — a
    // declaration line deleted or reworded — is visible in a green log instead
    // of being invisible until a restatement drifts behind it.
    const judged = Object.entries(sources)
      .map(([name, { version, effective }]) => `${name} ${version} (${effective})`)
      .join(", ");
    console.error(`check-legal-versions: every restatement agrees with ${judged}`);
  }
  return failed ? 1 : 0;
}
