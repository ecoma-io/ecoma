/**
 * Gates the acceptance mechanism `CLA.md` declares: a contributor agrees once,
 * by posting the agreement sentence as a pull request comment, and **nothing is
 * granted until that signature exists**.
 *
 * That sentence was the whole control. `CONTRIBUTING.md` and `CLA.md` both
 * state it, `CODEOWNERS` protects the licence texts from being changed by
 * someone who could not make the grant — and nothing at all checked that a
 * merged contribution had a signature behind it. The failure is silent by
 * construction and lands years later: the project cannot say what rights it
 * holds in that code, and relicensing needs a person it may no longer be able
 * to find.
 *
 * **What records the signature is the CLA action, not this gate.** The
 * contributor's comment is turned into a line in the signatures file by
 * `contributor-assistant/github-action` (`.github/workflows/cla.yml`), which
 * commits it to this repository — so the writing the agreement needs lives in
 * the tree, in git history, and in every clone, rather than in a service's
 * database. This gate is the half that keeps the required check honest: the
 * action publishes its own commit status, and branch protection here watches
 * exactly one check (`ci-gate`), so the verdict has to be re-derivable inside
 * CI or it is not covered by the thing that blocks a merge.
 *
 * **Every vocabulary here is read out of `CLA.md` or the workflow, never
 * restated** (Rule 14 rung 1). The agreement sentence and the version come from
 * `CLA.md`; the signatures path comes from the workflow input that writes it.
 * Editing the agreement therefore moves the gate with it, and a workflow
 * pointed at a new signature generation cannot leave this gate reading the old
 * one. The dependency runs the other way too: `--sign-comment` and
 * `--allowlist` print what the workflow needs as inputs, so the workflow
 * derives them from here instead of writing a second copy of the sentence and a
 * second answer to who is exempt.
 *
 * Modes, because the questions have different availability:
 *
 * - Bare (pre-push, CI): audits the **shape** of the signatures file and the
 *   attribution promise around it. Runs offline, judges the tree.
 * - `--author <login> [--author-type <user.type>]`: additionally judges who
 *   opened the pull request — normally by requiring a signature from them. Only
 *   CI can know that, so this mode is where the "no signature, no grant" rule
 *   actually bites.
 * - `--commits <range>`: additionally judges that every non-merge commit in the
 *   range carries the `Signed-off-by` trailer `CLA.md` asks for — the Developer
 *   Certificate of Origin, which the agreement deliberately keeps separate from
 *   assent to itself. It rides here rather than in a gate of its own because the
 *   one exemption it needs already lives here: automation this project runs
 *   certifies nothing, its commits are not contributions, and re-deriving that
 *   set somewhere else would be a second answer to a question this file has
 *   already answered.
 * - `--sign-comment` / `--allowlist`: print, for the workflow to consume.
 *
 * **A signature is bound to a version by the file it lands in.** `CLA.md`'s own
 * change rule says a new version binds a contributor only once they agree to
 * it, and the action's versioning is the mechanism: publishing a new version
 * moves `path-to-signatures` to the next generation, everyone signs again, and
 * the previous generation's file stays in the tree as the writing for
 * everything already merged under it. That is why the join key is a path here
 * and not a search through `CLA.md`'s git history — the history read was
 * answering "which text did this record quote", a question a per-version file
 * answers by construction.
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
 * right for anyone to grant, and a signature for it would be a licence contract
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
 *   and owe a signature, or nobody did, in which case no copyright arose and the
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
 *
 * **What this gate does not judge**, stated so it is not mistaken for covered:
 * a pull request whose commits were authored by someone other than the account
 * that opened it. `--author` asks about the opener; the action asks about every
 * committer and is the wider of the two. Narrowing to the opener here is
 * deliberate — GitHub is the only authority that can resolve a commit's author
 * to an account, and that is a network call this command does not make.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { cwdGitEnv } from "./git-env.mjs";

export const CLA = "CLA.md";
export const CODEOWNERS = ".github/CODEOWNERS";
export const CONTRIBUTORS_FILE = "CONTRIBUTORS.md";
export const CLA_WORKFLOW = ".github/workflows/cla.yml";

/** Literal text made safe to embed in a RegExp source. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The version the agreement declares for itself, e.g. `"1.0"` from
 * `**Version 1.0, effective 2026-07-30.**`. Throws rather than guessing: a
 * document with no version cannot have an assent sentence that names the right
 * one.
 */
export function claVersion(claText) {
  const m = claText.match(/^\*\*Version\s+([0-9.]+),/m);
  if (!m) throw new Error(`${CLA}: no '**Version <n>, effective …' line to read the version from`);
  return m[1];
}

/**
 * The agreement sentence `CLA.md` publishes — the fenced block under "How you
 * agree", whitespace-normalized because the document may wrap it and the
 * comparison the action makes is on a single trimmed line.
 */
export function assentSentence(claText) {
  const section = claText.split(/^## How you agree$/m)[1];
  if (!section) throw new Error(`${CLA}: no '## How you agree' section`);
  const fence = section.match(/```\n([\s\S]*?)```/);
  if (!fence) throw new Error(`${CLA}: '## How you agree' carries no fenced agreement sentence`);
  const sentence = fence[1].replace(/\s+/g, " ").trim();
  if (!sentence) throw new Error(`${CLA}: the fenced agreement sentence is empty`);
  return sentence;
}

/**
 * The version the agreement declares lives in two places — the
 * `**Version …**` line (which this gate reads) and inside the fenced assent
 * sentence (which every signature quotes). Nothing forces an edit to move both,
 * so the gate cross-checks them: a fault here is a defect in `CLA.md` itself,
 * caught on the commit that drifted them apart rather than on the first
 * signature that quotes the wrong one.
 */
export function templateVersionFault(sentence, version) {
  // Case-insensitive, and boundary-guarded so "1.0" never passes on "1.0.1"
  // or "1.0beta" — exact punctuation is a wording choice the guard must not
  // block, but a longer version token is a different version.
  const named = new RegExp(`version ${escapeRegExp(version)}(?![\\w.])`, "i").test(sentence);
  return named
    ? null
    : `the assent sentence does not name version ${version} — the '**Version …**' line and the ` +
        `fenced sentence have drifted apart; move both in one edit`;
}

/**
 * Where the CLA workflow writes signatures, read off its own
 * `path-to-signatures` input (Rule 14 rung 1). Throws when the workflow is
 * absent or names no path: with no workflow nothing records a signature, so a
 * gate that quietly reported green would be certifying an acceptance mechanism
 * that is not installed.
 */
export function signaturesPath(workflowText) {
  const m = workflowText.match(/^\s*path-to-signatures:\s*["']?([^"'\s#]+)/m);
  if (!m) {
    throw new Error(
      `${CLA_WORKFLOW}: no 'path-to-signatures:' input — nothing records a CLA signature, so ` +
        `this gate cannot say who agreed`,
    );
  }
  return m[1].replace(/^\.\//, "");
}

/**
 * The phrase in `CLA.md` that promises contributors a row in
 * `CONTRIBUTORS.md` (clause 3's naming consent), or `null` when the document
 * no longer makes it. Like `automationClause`, the check this anchors
 * disappears in the same edit that removes the promise.
 */
export function attributionClause(claText) {
  // Anchored on the meaning-carrying words, tolerant of whatever Markdown sits
  // between them — a link relabelled, however verbosely, must not silently
  // switch the roster check off while the promise still stands. The lazy
  // unbounded gap errs toward finding a promise (fail closed): an over-match
  // keeps the gate on, which is the recoverable direction.
  const m = claText.replace(/\s+/g, " ").match(/naming you in .*?CONTRIBUTORS\.md/);
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
 * The signatories in a signatures file's text, as `{ logins, faults }`.
 * `logins` is what everything downstream asks about; `faults` names anything
 * the file carries that is not a usable signature.
 *
 * The file is written by a third-party action, which makes auditing its shape
 * the point rather than paranoia: it is the only writing behind every grant the
 * project holds, and a truncated or hand-edited one fails silently in the
 * direction that matters — an entry that no longer names anybody still counts
 * as a file that exists.
 */
export function auditSignatures(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { logins: [], faults: [`${path}: is not valid JSON (${error.message})`] };
  }
  const entries = parsed?.signedContributors;
  if (!Array.isArray(entries)) {
    return {
      logins: [],
      faults: [
        `${path}: carries no 'signedContributors' array — the CLA action writes one, so a file ` +
          `without it is either hand-made or truncated, and it evidences no grant`,
      ],
    };
  }
  const logins = [];
  const faults = [];
  for (const [i, entry] of entries.entries()) {
    const at = `${path}: signedContributors[${i}]`;
    if (typeof entry?.name !== "string" || !entry.name.trim()) {
      faults.push(`${at} names no GitHub account, so it identifies nobody`);
      continue;
    }
    if (typeof entry.created_at !== "string" || !entry.created_at.trim()) {
      // Without a timestamp the signature cannot be placed against the version
      // that was published when it was made, which is what the agreement's own
      // change rule turns on.
      faults.push(
        `${at} ('${entry.name}') carries no created_at, so it is a signature with no date`,
      );
    }
    logins.push(entry.name);
  }
  return { logins, faults };
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
export const PROJECT_AUTOMATION = {
  "renovate[bot]": { config: ".github/renovate.json5", gitAuthor: "renovate[bot]" },
};

/**
 * `gitAuthor` is declared beside the login because the two are different
 * namespaces that happen to coincide for Renovate and do not in general — the
 * GitHub Actions bot commits as "GitHub Actions" under the login
 * `github-actions[bot]`. Comparing a login against `%an` therefore works by
 * coincidence where it works at all, and fails by turning the gate red on a
 * bot's own commits, which reads as the bot owing a certification it cannot
 * give. Both values are the vendor's published constants, which is what lets
 * either be written down; neither is derivable from the tree.
 */

/**
 * The subset of `PROJECT_AUTOMATION` this repository still runs, as
 * `{ <lower-cased login>: { config, gitAuthor } }` — the entry as
 * `PROJECT_AUTOMATION` declares it, keyed for lookup. `exists` is injected so
 * the reading can be tested without a tree.
 */
export function projectAutomation(exists = existsSync) {
  return Object.fromEntries(
    Object.entries(PROJECT_AUTOMATION)
      .filter(([, entry]) => exists(entry.config))
      .map(([login, entry]) => [login.toLowerCase(), entry]),
  );
}

/**
 * The accounts the CLA action must not ask for a signature, as the action's own
 * comma-separated `allowlist` input: whoever can make the grant, plus the
 * automation whose commits the agreement puts outside itself. Both sets are the
 * ones `authorVerdict` already exempts, which is the point — the workflow reads
 * this instead of restating them, so the action's status and the required check
 * cannot disagree about who is exempt.
 */
export function allowlist(licensors, automation) {
  return [...licensors, ...Object.keys(automation)].join(",");
}

/**
 * The unsigned commits still owed a trailer, given the git author name an
 * exempt machine account commits under (`null` when nothing is exempt).
 * Separated from its caller so both directions are testable without a
 * repository: the commits the bot authored drop out, and everything else —
 * including a person's commit on the bot's own branch — stays.
 */
export function commitsOwedSignOff(unsigned, exemptGitAuthor) {
  if (!exemptGitAuthor) return unsigned;
  const exempt = exemptGitAuthor.toLowerCase();
  return unsigned.filter((c) => c.author?.toLowerCase() !== exempt);
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
 * The sentence in `CLA.md` that asks for a `Signed-off-by` trailer on every
 * commit, or `null` once the document stops asking. Clause-anchored like
 * `automationClause` and `attributionClause`: drop the requirement from the
 * agreement and this check stops in the same edit, rather than outliving the
 * rule it enforces.
 */
export function signOffClause(claText) {
  const m = claText.replace(/\s+/g, " ").match(/Separately, sign off each commit\./);
  return m ? m[0] : null;
}

/** The trailer `git commit -s` writes — the Developer Certificate of Origin. */
export const SIGN_OFF_TRAILER = "Signed-off-by:";

/**
 * The non-merge commits in `range` that carry no `Signed-off-by` trailer, as
 * `[{ sha, subject, author }]` where `author` is the commit's author name.
 * Merges are skipped because git writes them and nobody authors them, matching
 * what commitlint already ignores.
 *
 * `author` is what lets the caller exempt a machine account **per commit**
 * rather than per pull request. Exempting the whole range because a bot opened
 * it is too wide: a person can push onto a bot's branch, and their commits
 * would then escape the trailer entirely. Only GitHub can say whether an
 * *account* is a machine, but which commits an already-exempt account authored
 * is a question git can answer offline, which is the half that matters here.
 */
export function unsignedCommits(range, exec = execFileSync) {
  // The separators come from git's own %x escapes, so no control character
  // has to survive being written into this source file.
  const RECORD = "\u0000";
  const FIELD = "\u001f";
  let log;
  try {
    log = exec("git", ["log", "--no-merges", "--format=%H%x1f%s%x1f%an%x1f%b%x00", range], {
      env: cwdGitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`could not read the commits in '${range}': ${error.message}`, {
      cause: error,
    });
  }
  const trailer = new RegExp(`^\\s*${escapeRegExp(SIGN_OFF_TRAILER)}\\s*\\S`, "im");
  const unsigned = [];
  for (const entry of log.split(RECORD)) {
    if (!entry.trim()) continue;
    const [sha, subject, author, body = ""] = entry.replace(/^\s+/, "").split(FIELD);
    if (!trailer.test(body)) unsigned.push({ sha, subject, author });
  }
  return unsigned;
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
 * What the author of a pull request owes, given who they are. Returns
 * `{ ok, fault?, note? }`: `fault` is why the pull request cannot be merged,
 * `note` is what the gate assumed in letting one through — an exemption nobody
 * sees is an exemption nobody reviews, so it is printed rather than kept.
 *
 * Pure: `licensors`, `clause`, `automation` and `hasSigned` are what the tree
 * and `CLA.md` said, passed in. An absent `type` means the caller could not ask
 * GitHub what kind of account this is, and the author is treated as a person.
 */
export function authorVerdict(
  author,
  { type, licensors, clause, automation, hasSigned, sentence },
) {
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
    const entry = automation[handle];
    if (!entry) {
      return {
        ok: false,
        fault:
          `'${author}' is a machine account this project does not run — ${CLA} exempts its own ` +
          `automation, and nothing committed here configures this account. Either it is ours, and ` +
          `its login belongs in PROJECT_AUTOMATION beside the file that runs it; or it is acting ` +
          `for a person, and that person authored the work and needs their own signature`,
      };
    }
    return {
      ok: true,
      automation: true,
      gitAuthor: entry.gitAuthor,
      note:
        `'${author}' is a machine account this project runs (${entry.config}), and ${CLA} says: ` +
        `"${clause}" No signature is required of it. It cannot agree for anyone else, though: work a ` +
        `person authored — anything a coding agent wrote at someone's direction — still needs that ` +
        `person's signature, and only review can see that this pull request carries none.`,
    };
  }

  if (!hasSigned) {
    return {
      ok: false,
      fault:
        `'${author}' has not agreed to ${CLA} — it grants nothing until they do, so this ` +
        `contribution cannot be merged yet. To agree, post this as a comment on the pull ` +
        `request:\n\n    ${sentence}`,
    };
  }
  return { ok: true };
}

function argValue(args, flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * Audits the signatures file, and — given `--author <login>` — what that author
 * owes. Returns a process exit code.
 */
export function checkContributorRecord(args = []) {
  const claText = readFileSync(CLA, "utf8");
  const version = claVersion(claText);
  const sentence = assentSentence(claText);
  const licensors = licensorHandles(readFileSync(CODEOWNERS, "utf8"));
  const automation = projectAutomation();

  // Print-only modes come first: they exist so the workflow can be configured
  // from this file's derivations, and a workflow that is only asking what to
  // put in an input has no reason to be told the tree's audit on stdout.
  if (args.includes("--sign-comment")) {
    console.log(sentence);
    return 0;
  }
  if (args.includes("--allowlist")) {
    console.log(allowlist(licensors, automation));
    return 0;
  }

  let failed = false;

  const drift = templateVersionFault(sentence, version);
  if (drift) {
    failed = true;
    console.error(`${CLA}: ${drift}`);
  }

  let path, signatures;
  try {
    path = signaturesPath(readFileSync(CLA_WORKFLOW, "utf8"));
  } catch (error) {
    console.error(`check-contributor-record: ${error.message}`);
    return 1;
  }
  if (existsSync(path)) {
    signatures = auditSignatures(readFileSync(path, "utf8"), path);
  } else {
    // The action creates the file with the first signature, and until then
    // there is nothing to audit — every author so far was exempt. Said out
    // loud, because "no signatures" and "signatures not checked" look
    // identical in a green log.
    signatures = { logins: [], faults: [] };
    console.log(
      `${path}: does not exist yet — the CLA action creates it with the first signature, so ` +
        `nobody outside the licensor and this project's own automation has agreed so far.`,
    );
  }
  for (const fault of signatures.faults) {
    failed = true;
    console.error(fault);
  }

  const attribution = attributionClause(claText);
  const contributorsText =
    attribution && existsSync(CONTRIBUTORS_FILE) ? readFileSync(CONTRIBUTORS_FILE, "utf8") : "";
  if (attribution) {
    for (const login of signatures.logins) {
      if (!listedInContributors(login, contributorsText)) {
        failed = true;
        console.error(
          `${CONTRIBUTORS_FILE}: does not name '${login}', who has signed — ${CLA} ` +
            `consents to "${attribution}" as how authors are credited, and that promise holds ` +
            `from the moment a contribution lands. 'dev-cli sync-contributors' adds the row.`,
        );
      }
    }
  }

  let automationGitAuthor = null;
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
    const signed = signatures.logins.map((l) => l.toLowerCase());
    const verdict = authorVerdict(author, {
      type: typeAt === -1 ? undefined : args[typeAt + 1],
      licensors,
      clause: automationClause(claText),
      automation,
      hasSigned: signed.includes(author.toLowerCase()),
      sentence,
    });
    if (verdict.note) console.log(verdict.note);
    if (!verdict.ok) {
      failed = true;
      console.error(verdict.fault);
    }
    automationGitAuthor = verdict.automation === true ? verdict.gitAuthor : null;
  }

  const commitsAt = args.indexOf("--commits");
  if (commitsAt !== -1) {
    const range = argValue(args, "--commits");
    if (!range) {
      console.error("check-contributor-record: --commits needs a git range");
      return 2;
    }
    const signOff = signOffClause(claText);
    if (!signOff) {
      console.log(
        `${CLA} no longer asks for a ${SIGN_OFF_TRAILER} trailer, so the commits in ` +
          `'${range}' are not judged for one.`,
      );
    } else {
      let unsigned;
      try {
        unsigned = unsignedCommits(range);
      } catch (error) {
        console.error(`check-contributor-record: ${error.message}`);
        return 2;
      }
      // A machine account opening the pull request exempts the commits IT
      // authored, never the whole range — a person can push onto a bot's
      // branch, and their commits owe the trailer like anyone else's.
      //
      // **The author name is unverified metadata, and this exemption is only as
      // good as it**: anyone who can write a commit can write any name into it,
      // so a commit that claims the exempt account's name is exempted here
      // without anything checking that claim. What bounds the hole is who can
      // reach it. The exemption opens at all only for a pull request GitHub
      // says a machine account opened, and the spoofed commit has to land on
      // that account's branch — which needs push access to this repository.
      // Anyone holding that can also merge past this gate directly, so closing
      // it here would buy nothing and would cost the gate its offline read.
      // A verified answer exists (GitHub resolves each commit to an account),
      // and it is a network call this command deliberately does not make.
      // The comparison is against the git author name PROJECT_AUTOMATION
      // declares for the account, never the account's login: the two are
      // different namespaces that coincide for Renovate and do not in general.
      const owed = commitsOwedSignOff(unsigned, automationGitAuthor);
      // Only worth saying when the exemption had something to act on: on an
      // all-signed range the counts would read "0 of 0 … the rest are reported
      // below" with nothing below, which is noise contradicting itself.
      if (automationGitAuthor && unsigned.length > 0) {
        console.log(
          `Commits authored as '${automationGitAuthor}' owe no ${SIGN_OFF_TRAILER} trailer — ` +
            `automation this project runs certifies nothing, and its commits are not ` +
            `contributions. ${unsigned.length - owed.length} of the ${unsigned.length} untrailered ` +
            `commit(s) in '${range}' matched; any remainder is reported below. A bot whose commits ` +
            `are all reported has a git author name PROJECT_AUTOMATION no longer describes.`,
        );
      }
      for (const { sha, subject } of owed) {
        failed = true;
        console.error(
          `${sha.slice(0, 8)} ("${subject}"): no ${SIGN_OFF_TRAILER} trailer — ${CLA} says: ` +
            `"${signOff}" Commit with 'git commit -s', or add the trailer to a branch already ` +
            `written with 'git rebase --signoff <base>'.`,
        );
      }
    }
  }

  return failed ? 1 : 0;
}
