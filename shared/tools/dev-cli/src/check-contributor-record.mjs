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
 * - `--author <login> [--author-type <user.type>]`: additionally judges who
 *   opened the pull request — normally by requiring a record of them. Only CI can
 *   know that, so this mode is where the "no record, no grant" rule actually
 *   bites.
 *
 * **A record outlives the version it agreed to.** `CLA.md`'s own change rule
 * says a new version binds a contributor only once they agree to it, so a
 * record quoting a superseded assent sentence is valid, not stale. The set of
 * published versions is derived from git history of `CLA.md` (Rule 14 rung 1),
 * read lazily — see `auditRecordAcrossVersions`. The same clause-derivation
 * covers attribution: while `CLA.md` promises naming in `CONTRIBUTORS.md`
 * (clause 3), every record's handle must be named there, because a merged
 * contribution whose author that file omits is a promise the project is
 * already breaking.
 *
 * **A licensor is exempt, and the exemption is derived rather than named.** The
 * CLA runs *to* whoever can make a licence grant, so it would be circular for
 * them to grant it to themselves. `CODEOWNERS` already answers who that is — it
 * exists precisely so the licence texts "never land on an approval from someone
 * who could not make that grant" — and the owners of `/CLA.md` are that set.
 * Hardcoding a handle here would be a second answer to the same question, and
 * the one nobody would remember to update.
 *
 * **The project's own automation is exempt, and that exemption is the
 * agreement's rather than this file's.** `CLA.md` says commits made by automated
 * tooling the project runs are not contributions under it, so the gate reads
 * that sentence — delete it from the agreement and the exemption stops here in
 * the same edit. The law under which the agreement is governed says the same
 * thing from the other side: copyright arises only from a human's substantial
 * and decisive contribution, so a dependency bump nobody authored carries no
 * right for anyone to grant, and a record for it would be a licence contract
 * with a party that has no legal personality.
 *
 * **Being a machine account is necessary for that exemption and nowhere near
 * sufficient**, which is the whole reason this is not a `user.type === "Bot"`
 * test. Two machine accounts open pull requests for opposite reasons:
 *
 * - Tooling *the project runs* (`PROJECT_AUTOMATION`) produces version strings
 *   and lockfile hashes — no authored expression, no author, nothing to license.
 * - A **coding agent** produces code, and someone directed it. Either that person
 *   steered it enough to be its author, in which case *they* are the contributor
 *   and owe a record, or nobody did, in which case no copyright arose and the
 *   agreement's own clause on undisclosed provenance decides whether it can be
 *   taken at all. Neither branch is satisfied by the opener being a bot.
 *
 * So an unlisted machine account fails, and says which of the two it must be.
 * Waving it through on account type alone would leave a contributor who has not
 * agreed one move away from merging: have an agent open the pull request.
 *
 * Whether an account is a person is GitHub's answer (`user.type`, passed as
 * `--author-type`), never a guess from a `[bot]` suffix; whether the project runs
 * it is answered by the tree, since automation this project runs is configured in
 * this repository. A caller that cannot say leaves `--author-type` out and the
 * author is treated as a person, which fails closed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { cwdGitEnv } from "./git-env.mjs";

export const CLA = "CLA.md";
export const CODEOWNERS = ".github/CODEOWNERS";
export const CONTRIBUTORS_DIR = "contributors";
export const CONTRIBUTORS_FILE = "CONTRIBUTORS.md";

/** Literal text made safe to embed in a RegExp source. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
 * The version the agreement declares lives in two places — the
 * `**Version …**` line (which this gate reads) and inside the fenced assent
 * sentence (which every record must quote). Nothing forces an edit to move
 * both, so the gate cross-checks them: a fault here is a defect in `CLA.md`
 * itself, caught on the commit that drifted them apart rather than on the
 * first record that quotes the wrong one.
 */
export function templateVersionFault({ sentence }, version) {
  return sentence.includes(`version ${version},`)
    ? null
    : `the assent sentence in the record template does not name version ${version} — ` +
        `the '**Version …**' line and the fenced template have drifted apart; move both in one edit`;
}

/**
 * Every text `CLA.md` has ever been committed as, newest first — the set of
 * published versions, derived from git history rather than restated anywhere
 * (Rule 14 rung 1). Read lazily and only when a record fails the current
 * template, so the common case spawns no git. An environment without readable
 * history (no repository, a shallow clone with nothing behind it) yields `[]`,
 * which leaves only the working-tree text to judge against — fail closed.
 */
export function claTextHistory(exec = execFileSync) {
  const opts = { env: cwdGitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  let log;
  try {
    log = exec("git", ["log", "--format=%H", "--", CLA], opts);
  } catch {
    return [];
  }
  const texts = [];
  for (const sha of log.split("\n").filter(Boolean)) {
    try {
      texts.push(exec("git", ["show", `${sha}:${CLA}`], opts));
    } catch {
      // a commit that deleted CLA.md published nothing a record could cite
    }
  }
  return texts;
}

/**
 * Audits one record against the current template first, and — only when that
 * fails — against every template `CLA.md` ever published, because the
 * agreement's own change rule says a record stays valid under the version its
 * author agreed to ("If these terms change"). Without this, publishing a new
 * version would turn every existing record red at once, which is the opposite
 * of what the document promises. `history` is a thunk returning past `CLA.md`
 * texts so the lookup costs nothing while every record matches the present.
 */
export function auditRecordAcrossVersions(text, template, version, history) {
  const faults = auditRecord(text, template, version);
  if (!faults.length) return { faults };
  for (const past of history()) {
    let pastVersion, pastTemplate;
    try {
      pastVersion = claVersion(past);
      pastTemplate = recordTemplate(past);
    } catch {
      continue; // a draft predating the version line or the template — nothing a record could cite
    }
    if (pastVersion === version && pastTemplate.sentence === template.sentence) continue;
    if (auditRecord(text, pastTemplate, pastVersion).length === 0) {
      return { faults: [], supersededVersion: pastVersion };
    }
  }
  return { faults };
}

/**
 * The phrase in `CLA.md` that promises contributors a row in
 * `CONTRIBUTORS.md` (clause 3's naming consent), or `null` when the document
 * no longer makes it. Like `automationClause`, the check this anchors
 * disappears in the same edit that removes the promise.
 */
export function attributionClause(claText) {
  const m = claText
    .replace(/\s+/g, " ")
    .match(/naming you in \[`CONTRIBUTORS\.md`\]\(\.\/CONTRIBUTORS\.md\)/);
  return m ? m[0] : null;
}

/**
 * Whether `CONTRIBUTORS.md` names a GitHub handle — as `@handle` or a
 * `github.com/handle` link, case-insensitively, and never as a prefix of a
 * longer handle.
 */
export function listedInContributors(handle, contributorsText) {
  return new RegExp(`(?:@|github\\.com/)${escapeRegExp(handle)}(?![\\w-])`, "i").test(
    contributorsText,
  );
}

/**
 * GitHub's own vocabulary for an account that is not a person: the value
 * `user.type` carries for an App or bot account, as opposed to `"User"`.
 */
export const MACHINE_ACCOUNT = "Bot";

/**
 * The machine accounts through which this project runs automation of its own,
 * each paired with the configuration that runs it. The pairing is what makes
 * this a list the tree can expire: an account is exempt only while the file
 * that puts that tool to work here is still committed, so retiring a tool
 * retires its exemption without anyone remembering to come back here.
 *
 * A login is the fixed name its vendor publishes for that App, which is why it
 * can be written down at all; that the project *runs* it is the part read off
 * the tree. Adding a tool means adding its pair, and nothing else — a coding
 * agent never belongs here, because it does not produce work without a person
 * behind it.
 */
export const PROJECT_AUTOMATION = { "renovate[bot]": ".github/renovate.json5" };

/**
 * The subset of `PROJECT_AUTOMATION` this repository still runs, as
 * `{ <lower-cased login>: <the config that runs it> }`. `exists` is injected so
 * the reading can be tested without a tree.
 */
export function projectAutomation(exists = existsSync) {
  return Object.fromEntries(
    Object.entries(PROJECT_AUTOMATION)
      .filter(([, config]) => exists(config))
      .map(([login, config]) => [login.toLowerCase(), config]),
  );
}

/**
 * The sentence `CLA.md` uses to put the project's own automation outside the
 * agreement, or `null` when the document no longer says it. Anchored on the two
 * phrases that carry the meaning — what the commits are, and that they are not
 * contributions — so re-wrapping or an edit to the aside between them keeps the
 * clause found, while removing the rule removes the exemption.
 */
export function automationClause(claText) {
  const m = claText
    .replace(/\s+/g, " ")
    .match(/Commits made by automated tooling[^.]*?are not contributions under this agreement\./);
  return m ? m[0] : null;
}

/**
 * The GitHub handles that own `/CLA.md` in CODEOWNERS, lower-cased — the people
 * who can make the grant, and so the people the agreement does not apply to.
 * Of several matching entries the LAST wins, because that is CODEOWNERS' own
 * precedence rule — reading any other line would derive an owner set GitHub
 * itself does not enforce.
 */
export function licensorHandles(codeownersText) {
  const line = codeownersText
    .split("\n")
    .filter((l) => !l.trim().startsWith("#") && /^\/CLA\.md\s/.test(l.trim()))
    .at(-1);
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
    const m = text.match(new RegExp(`^${escapeRegExp(field)}:(.*)$`, "m"));
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
 * The record file for a GitHub login among `files`, or `null`. Matched
 * case-insensitively: GitHub logins are case-insensitive but case-preserving,
 * so a contributor who names their file the way their profile spells it must
 * not fail against a lower-cased lookup on a case-sensitive filesystem.
 */
export function recordFileFor(author, files) {
  const want = `${author.toLowerCase()}.md`;
  return files.find((f) => f.toLowerCase() === want) ?? null;
}

/**
 * What the author of a pull request owes, given who they are. Returns
 * `{ ok, fault?, note? }`: `fault` is why the pull request cannot be merged,
 * `note` is what the gate assumed in letting one through — an exemption nobody
 * sees is an exemption nobody reviews, so it is printed rather than kept.
 *
 * Pure: `licensors`, `clause`, `automation` and `hasRecord` are what the tree
 * and `CLA.md` said, passed in. An absent `type` means the caller could not ask
 * GitHub what kind of account this is, and the author is treated as a person.
 */
export function authorVerdict(author, { type, licensors, clause, automation, hasRecord }) {
  const handle = author.toLowerCase();
  if (licensors.includes(handle)) return { ok: true };

  if (type === MACHINE_ACCOUNT) {
    if (!clause) {
      return {
        ok: false,
        fault:
          `'${author}' is a machine account, and ${CLA} no longer places commits made by ` +
          `automated tooling outside the agreement — nothing exempts this pull request`,
      };
    }
    const config = automation[handle];
    if (!config) {
      return {
        ok: false,
        fault:
          `'${author}' is a machine account this project does not run — ${CLA} exempts its own ` +
          `automation, and nothing committed here configures this account. Either it is ours, and ` +
          `its login belongs in PROJECT_AUTOMATION beside the file that runs it; or it is acting ` +
          `for a person, and that person authored the work and needs their own record`,
      };
    }
    return {
      ok: true,
      note:
        `'${author}' is a machine account this project runs (${config}), and ${CLA} says: ` +
        `"${clause}" No record is required of it. It cannot agree for anyone else, though: work a ` +
        `person authored — anything a coding agent wrote at someone's direction — still needs that ` +
        `person's record, and only review can see that this pull request carries none.`,
    };
  }

  if (!hasRecord) {
    return {
      ok: false,
      fault:
        `${recordPath(handle)}: missing — ${CLA} grants nothing until this record exists, ` +
        `so a contribution from '${author}' cannot be merged yet`,
    };
  }
  return { ok: true };
}

/**
 * Audits every existing record, and — given `--author <login>` — what that
 * author owes. Returns a process exit code.
 */
export function checkContributorRecord(args = []) {
  const claText = readFileSync(CLA, "utf8");
  const version = claVersion(claText);
  const template = recordTemplate(claText);
  const licensors = licensorHandles(readFileSync(CODEOWNERS, "utf8"));

  let failed = false;

  const drift = templateVersionFault(template, version);
  if (drift) {
    failed = true;
    console.error(`${CLA}: ${drift}`);
  }

  let pastTexts;
  const history = () => (pastTexts ??= claTextHistory());
  const attribution = attributionClause(claText);
  const contributorsText =
    attribution && existsSync(CONTRIBUTORS_FILE) ? readFileSync(CONTRIBUTORS_FILE, "utf8") : "";

  const records = existsSync(CONTRIBUTORS_DIR)
    ? readdirSync(CONTRIBUTORS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md")
    : [];
  for (const file of records) {
    const path = join(CONTRIBUTORS_DIR, file);
    const { faults, supersededVersion } = auditRecordAcrossVersions(
      readFileSync(path, "utf8"),
      template,
      version,
      history,
    );
    if (supersededVersion) {
      console.log(
        `${path}: assents to ${CLA} as published at version ${supersededVersion} — still in ` +
          `force: a new version binds a contributor only once they agree to it.`,
      );
    }
    for (const fault of faults) {
      failed = true;
      console.error(`${path}: ${fault}`);
    }
    if (attribution) {
      const handle = file.slice(0, -".md".length);
      if (!listedInContributors(handle, contributorsText)) {
        failed = true;
        console.error(
          `${CONTRIBUTORS_FILE}: does not name '${handle}', whose record exists — ${CLA} ` +
            `consents to "${attribution}" as how authors are credited, and that promise holds ` +
            `from the moment a contribution lands, so add their row in the same pull request`,
        );
      }
    }
  }

  const authorAt = args.indexOf("--author");
  if (authorAt !== -1) {
    const author = args[authorAt + 1];
    if (!author) {
      console.error("check-contributor-record: --author needs a GitHub login");
      return 2;
    }
    const typeAt = args.indexOf("--author-type");
    if (typeAt !== -1 && !args[typeAt + 1]) {
      console.error(
        "check-contributor-record: --author-type needs GitHub's user.type for --author",
      );
      return 2;
    }
    const verdict = authorVerdict(author, {
      type: typeAt === -1 ? undefined : args[typeAt + 1],
      licensors,
      clause: automationClause(claText),
      automation: projectAutomation(),
      hasRecord: recordFileFor(author, records) !== null,
    });
    if (verdict.note) console.log(verdict.note);
    if (!verdict.ok) {
      failed = true;
      console.error(verdict.fault);
    }
  }

  return failed ? 1 : 0;
}
