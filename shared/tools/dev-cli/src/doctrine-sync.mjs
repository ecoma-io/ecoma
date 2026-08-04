/**
 * `dev-cli doctrine-sync [<pathspec>]` — records, in every doctrine variant,
 * the fingerprint of the canonical document it sits beside.
 *
 * `check-doctrine` refuses a variant whose `canonical-sha` no longer matches
 * its canonical, and prints the value to record. Typing that value back by
 * hand is a twelve-character copy per variant, with no feedback when a digit
 * is wrong: the gate simply stays red and the eye cannot tell a mistyped
 * fingerprint from a genuinely stale translation. This command is the write
 * side of the same function the gate reads with, so the two can never disagree
 * about what the fingerprint of a document is.
 *
 * **It asserts nothing about the translation.** Re-stamping a variant declares
 * "I re-read this against the current canonical" — which is a human act. Run
 * it after re-reading, never as a way to make a red gate go quiet; a variant
 * stamped without being re-read is exactly the second document, carrying
 * authority it no longer earns, that the staleness rule exists to catch.
 *
 * It reads the git index (`listTrackedFiles`) through the gate's own
 * `doctrineDocPaths`, so the set it writes is the set the gate judges — which
 * is what keeps the project's README variants out of its reach. Those are
 * peers under a fixed-order frontmatter contract, and a `canonical-sha` key
 * stamped into one is a `check-subproject-readmes` failure, not a repair.
 *
 * Reading the index rather than walking the filesystem means a newly written
 * variant must be `git add`ed to be seen. That is deliberate: a file the gate
 * cannot see is a file this command has no business stamping. Prettier runs in
 * `pre-commit` and rewrites markdown, which changes the canonical's bytes and
 * therefore its fingerprint — so the order that terminates is stage, then
 * format, then sync, then commit.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { DOCTRINE_ROOT, doctrineDocPaths, fingerprint, variantOf } from "./check-doctrine.mjs";
import { listTrackedFiles } from "./tracked-files.mjs";

/** The leading `---` … `---` block, with its keys captured. */
const FRONTMATTER = /^---\n([\s\S]*?)\n---/;

/**
 * Locates the `canonical-sha` line to overwrite. Deliberately looser than the
 * gate's own pattern, which requires twelve hex digits: a variant carrying a
 * malformed fingerprint is precisely the one needing a rewrite, and matching
 * only well-formed values would append a second key beside the broken one.
 * Validating the result stays the gate's job — this regex only has to find the
 * line.
 */
const SHA_LINE = /^canonical-sha:.*$/m;

/**
 * `text` with `canonical-sha` set to `sha`, or `null` when there is no
 * frontmatter block to record it in. Returns `text` unchanged when the value
 * is already current, so the caller can report only real writes. Pure.
 *
 * The edit is confined to the frontmatter block rather than applied to the
 * whole document: a doctrine page may quote a `canonical-sha:` line in its
 * prose while explaining this very rule, and a body-wide replace would rewrite
 * the explanation instead of the header.
 */
export function recordCanonicalSha(text, sha) {
  const block = FRONTMATTER.exec(text);
  if (!block) return null;

  const keys = block[1];
  const line = `canonical-sha: ${sha}`;
  const next = SHA_LINE.test(keys) ? keys.replace(SHA_LINE, line) : `${keys}\n${line}`;
  if (next === keys) return text;

  return `${text.slice(0, block.index)}---\n${next}\n---${text.slice(block.index + block[0].length)}`;
}

/**
 * Stamps every variant under the root named by `args[0]`, defaulting to this
 * workspace's published tree — the same argument `check-doctrine` takes, so
 * the write side and the read side of one fingerprint cannot be pointed at
 * different trees by accident. A family directory is a root like any other, so
 * one family can still be stamped without the whole tree.
 *
 * Returns a process exit code: non-zero for a variant it cannot stamp, never
 * for one it simply had no work to do on.
 */
export function doctrineSync(args = [], deps = {}) {
  const {
    read = readFileSync,
    write = writeFileSync,
    list = listTrackedFiles,
    log = console.log,
    error = console.error,
  } = deps;

  const paths = doctrineDocPaths(args[0] ?? DOCTRINE_ROOT, list);

  let failed = false;
  const written = [];
  for (const path of paths) {
    const variant = variantOf(path);
    if (!variant) continue;

    // Read the canonical from disk rather than looking it up in `paths`: a
    // pathspec naming one variant would not list its canonical, and reporting
    // that as an orphan would be the command inventing a problem out of its
    // own scoping.
    let canonical;
    try {
      canonical = read(variant.canonicalPath, "utf8");
    } catch {
      error(`${path}: no canonical ${variant.canonicalPath} to fingerprint`);
      failed = true;
      continue;
    }

    const text = read(path, "utf8");
    const sha = fingerprint(canonical);
    const next = recordCanonicalSha(text, sha);
    if (next === null) {
      error(`${path}: no frontmatter block to record 'canonical-sha: ${sha}' in`);
      failed = true;
      continue;
    }
    if (next === text) continue;

    write(path, next);
    written.push(path);
    log(`${path}: canonical-sha → ${sha}`);
  }

  if (written.length === 0) log("doctrine-sync: every variant already records its canonical");
  return failed ? 1 : 0;
}
