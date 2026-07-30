/**
 * Gates the acceptance mechanism `CLA.md` declares: a contributor agrees once,
 * by committing `contributors/<github-handle>.md`, and **nothing is granted
 * until that record exists**.
 *
 * That sentence was the whole control. `CONTRIBUTING.md` and `CLA.md` both
 * state it, `CODEOWNERS` protects the licence texts from being changed by
 * someone who could not make the grant — and nothing at all checked that a
 * merged contribution had a record behind it. The failure is silent by
 * construction and lands years later: the project cannot say what rights it
 * holds in that code, and relicensing needs a person it may no longer be able
 * to find.
 *
 * **Every vocabulary here is read out of `CLA.md`, never restated** (Rule 14
 * rung 1). The required field labels and the agreement sentence come from the
 * fenced block under "How you agree", and the version comes from the document's
 * effective-version line. Editing the agreement therefore moves the gate with
 * it; a copy here would be a second contract nobody knows they are signing.
 *
 * Two modes, because the two questions have different availability:
 *
 * - Bare (pre-commit, CI): audits the **shape** of every record that exists.
 *   Runs offline, judges the tree, and is the mode that catches a record
 *   committed with a field missing.
 * - `--author <login>`: additionally requires that login to have a record. Only
 *   CI can know who opened a pull request, so this mode is where the "no record,
 *   no grant" rule actually bites.
 *
 * **A licensor is exempt, and the exemption is derived rather than named.** The
 * CLA runs *to* whoever can make a licence grant, so it would be circular for
 * them to grant it to themselves. `CODEOWNERS` already answers who that is — it
 * exists precisely so the licence texts "never land on an approval from someone
 * who could not make that grant" — and the owners of `/CLA.md` are that set.
 * Hardcoding a handle here would be a second answer to the same question, and
 * the one nobody would remember to update.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const CLA = "CLA.md";
export const CODEOWNERS = ".github/CODEOWNERS";
export const CONTRIBUTORS_DIR = "contributors";

/**
 * The version the agreement declares for itself, e.g. `"1.0"` from
 * `**Version 1.0, effective 2026-07-30.**`. Throws rather than guessing: a
 * document with no version cannot have a record that names the right one.
 */
export function claVersion(claText) {
  const m = claText.match(/^\*\*Version\s+([0-9.]+),/m);
  if (!m) throw new Error(`${CLA}: no '**Version <n>, effective …' line to read the version from`);
  return m[1];
}

/**
 * The record template `CLA.md` publishes — the fenced block under "How you
 * agree". Returns `{ fields, sentence }`: the `Label:` lines a record must
 * carry, and the one-sentence assent, whitespace-normalized because the
 * document wraps it and a record need not wrap it the same way.
 */
export function recordTemplate(claText) {
  const section = claText.split(/^## How you agree$/m)[1];
  if (!section) throw new Error(`${CLA}: no '## How you agree' section`);
  const fence = section.match(/```\n([\s\S]*?)```/);
  if (!fence) throw new Error(`${CLA}: '## How you agree' carries no fenced record template`);

  const body = fence[1];
  const fields = [...body.matchAll(/^([A-Z][A-Za-z ]*):\s*$/gm)].map((m) => m[1]);
  const sentence = body
    .split("\n")
    .filter((l) => !/^[A-Z][A-Za-z ]*:\s*$/.test(l) && l.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!fields.length) throw new Error(`${CLA}: the record template declares no fields`);
  if (!sentence) throw new Error(`${CLA}: the record template declares no agreement sentence`);
  return { fields, sentence };
}

/**
 * The GitHub handles that own `/CLA.md` in CODEOWNERS, lower-cased — the people
 * who can make the grant, and so the people the agreement does not apply to.
 */
export function licensorHandles(codeownersText) {
  const line = codeownersText
    .split("\n")
    .find((l) => !l.trim().startsWith("#") && /^\/CLA\.md\s/.test(l.trim()));
  if (!line) throw new Error(`${CODEOWNERS}: no entry for /CLA.md to derive the licensor from`);
  return line
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter((t) => t.startsWith("@"))
    .map((t) => t.slice(1).toLowerCase());
}

/**
 * Returns the faults in one record's text — a missing field, a field left
 * blank, or an assent sentence that is absent or names another version. Pure:
 * `template` and `version` are what `CLA.md` said, passed in.
 */
export function auditRecord(text, { fields, sentence }, version) {
  const faults = [];
  for (const field of fields) {
    const m = text.match(new RegExp(`^${field}:(.*)$`, "m"));
    if (!m) faults.push(`missing the '${field}:' line the CLA's record template requires`);
    else if (!m[1].trim()) faults.push(`'${field}:' is blank`);
  }
  const normalized = text.replace(/\s+/g, " ");
  if (!normalized.includes(sentence)) {
    faults.push(
      normalized.includes("Contributor License Agreement")
        ? `the agreement sentence does not match CLA.md version ${version} verbatim`
        : "carries no agreement sentence",
    );
  }
  return faults;
}

/** Record filenames are the handle, so the handle is derivable from the tree. */
function recordPath(handle) {
  return join(CONTRIBUTORS_DIR, `${handle}.md`);
}

/**
 * Audits every existing record, and — given `--author <login>` — that the
 * author has one. Returns a process exit code.
 */
export function checkContributorRecord(args = []) {
  const claText = readFileSync(CLA, "utf8");
  const version = claVersion(claText);
  const template = recordTemplate(claText);
  const licensors = licensorHandles(readFileSync(CODEOWNERS, "utf8"));

  let failed = false;

  const records = existsSync(CONTRIBUTORS_DIR)
    ? readdirSync(CONTRIBUTORS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md")
    : [];
  for (const file of records) {
    const path = join(CONTRIBUTORS_DIR, file);
    for (const fault of auditRecord(readFileSync(path, "utf8"), template, version)) {
      failed = true;
      console.error(`${path}: ${fault}`);
    }
  }

  const authorAt = args.indexOf("--author");
  if (authorAt !== -1) {
    const author = args[authorAt + 1];
    if (!author) {
      console.error("check-contributor-record: --author needs a GitHub login");
      return 2;
    }
    const handle = author.toLowerCase();
    if (!licensors.includes(handle) && !existsSync(recordPath(handle))) {
      failed = true;
      console.error(
        `${recordPath(handle)}: missing — ${CLA} grants nothing until this record exists, ` +
          `so a contribution from '${author}' cannot be merged yet`,
      );
    }
  }

  return failed ? 1 : 0;
}
