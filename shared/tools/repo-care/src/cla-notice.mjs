/**
 * `cla-notice` — the messenger for the CLA gate: when
 * `dev-cli check-contributor-record` refuses a pull request, tell the author
 * on the thread what is missing and how to fix it, instead of leaving them a
 * red check whose log they may never open.
 *
 * It is a MESSENGER, never a second gate. `ci.yml`'s `Contributor record`
 * step remains the required check; this command exits 0 whether the gate
 * passed or failed, and non-zero only when it could not do its own job
 * (bad invocation, no token, GitHub refusing the comment). A fork pull
 * request's `pull_request` token is read-only, which is why this runs from
 * `pull_request_target` in its own workflow rather than as a step in `ci.yml`
 * — the same trigger reasoning as `pr-practice-review.yml`, with the same
 * boundary: nothing from the pull request head is ever executed. The
 * workflow materializes only `contributors/` and `CONTRIBUTORS.md` out of
 * the pull request's clean merge result (the same tree ci.yml judges;
 * head snapshot when no clean merge exists) — records are markdown data —
 * while `CLA.md`, `CODEOWNERS` and every script stay the trusted base
 * versions. A side effect worth having: the base `CODEOWNERS` judges the
 * licensor exemption here, so a pull request editing that file cannot
 * exempt its own author in this comment's verdict.
 *
 * The verdict is the gate's, spawned rather than restated (Rule 14 rung 1):
 * `dev-cli check-contributor-record --author … --author-type …` from this
 * module's own repo root, the same seam `audit-roadmap-labels` uses (covered
 * by this project's `implicitDependencies: ["dev-cli"]`). Its stderr goes
 * into the comment verbatim inside a code fence — it already names the exact
 * record path owed, and it is this workspace's own deterministic text.
 *
 * Comment discipline matches the other thread-writing commands: one
 * `CLA_NOTICE_MARKER` comment, `startsWith`-anchored, edited in place —
 * created only on a failure, flipped to a short "resolved" note once the
 * gate passes (deleting it would erase the thread's record that it ever
 * failed), and never posted at all on a pull request that was never red.
 * No model is involved anywhere; the whole judgment is the gate's exit code
 * (Rule 5).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { githubClient } from "./github.mjs";

export const CLA_NOTICE_MARKER = "<!-- repo-care:cla-notice -->";

/** Gate stderr beyond this is truncated in the comment, loudly. */
const MAX_GATE_OUTPUT_CHARS = 1500;

// Derived from this file's own location, never from the process: the gate
// reads CLA.md and contributors/ through repo-relative paths, and a
// workflow's working directory is not something to rely on.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const DEV_CLI = join(REPO_ROOT, "shared/tools/dev-cli/src/main.mjs");

/** The CLA gate's verdict on this author, as `{ status, output }`. */
export function runClaGate({ author, authorType, commits, spawn = spawnSync }) {
  const args = [DEV_CLI, "check-contributor-record", "--author", author];
  if (authorType) args.push("--author-type", authorType);
  // Without the range the messenger would judge less than the required gate
  // does and stay silent on a red it could explain — the sign-off half.
  if (commits) args.push("--commits", commits);
  const res = spawn(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
  // `faults` is stderr alone. The gate prints its FAULTS there and its NOTES —
  // an exemption it applied, a rule the agreement no longer states — on stdout,
  // and those notes quote the same vocabulary a fault does. Deciding whose
  // fault a red is from the merged text therefore reads a note as a fault; the
  // comment still shows both, because a note is context worth having.
  const faults = (res.stderr ?? "").trim();
  const notes = (res.stdout ?? "").trim();
  return {
    status: res.status,
    faults,
    output: [faults, notes].filter(Boolean).join("\n"),
  };
}

/** The failure notice. `repo` is `owner/name`, for absolute links — a comment
 * resolves relative links against the thread URL, not the tree. The gate
 * output is rendered as an INDENTED code block, never a fence: it echoes
 * record paths a pull request author chose, and a filename carrying backticks
 * could close a fence and let untrusted text render as this bot's own
 * guidance — an indented block has no closing delimiter to escape. */
export function buildClaNoticeComment({ author, repo, gateOutput }) {
  const blob = (path) => `https://github.com/${repo}/blob/HEAD/${path}`;
  const output =
    gateOutput.length > MAX_GATE_OUTPUT_CHARS
      ? `${gateOutput.slice(0, MAX_GATE_OUTPUT_CHARS)}\n… (truncated)`
      : gateOutput;
  return [
    CLA_NOTICE_MARKER,
    "### Contributor License Agreement — action needed",
    "",
    `Thanks for the pull request, @${author}! The CLA check (\`Contributor record\` in CI) did not pass, so it will stay red until this is resolved. What the gate said:`,
    "",
    ...output.split("\n").map((line) => `    ${line}`),
    "",
    `If you have not agreed to the CLA yet, you agree **once**, in this pull request — it covers every future contribution:`,
    "",
    `1. Read [\`CLA.md\`](${blob("CLA.md")}) — what you grant, what you keep, and which of your details are published.`,
    "2. Email your full postal address and a contact email to <john.itvn@gmail.com>. Neither is published: the law governing the agreement requires us to hold them, not to put them in a repository nobody can un-publish.",
    `3. Commit a record at the path the gate names above, following the template in \`CLA.md\` under "How you agree".`,
    `4. Add your row to [\`CONTRIBUTORS.md\`](${blob("CONTRIBUTORS.md")}) in the same pull request.`,
    "",
    "Every commit on the branch also needs a `Signed-off-by` trailer — that is the Developer Certificate of Origin, and it is separate from agreeing to the CLA. Use `git commit -s`, or `git rebase --signoff <base>` for commits already written.",
    "",
    "Push, and this check re-runs. If this pull request was opened through a bot or coding-agent account, the person who directed it is the contributor and it is their record the gate asks for.",
    "",
    "A maintainer confirms the record before merging. A question about the CLA never delays review — ask right here on the thread.",
  ].join("\n");
}

/** What an existing notice becomes when the gate stays red for reasons that
 * are not this author's — never created fresh, only ever an update, so a
 * contributor who fixed their part stops being told to act. */
export function buildClaRepoWideComment({ author }) {
  return [
    CLA_NOTICE_MARKER,
    "### Contributor License Agreement — no longer your record",
    "",
    `@${author}, your part of the CLA check is no longer what fails it. The check is currently red for a repository-wide reason (see the CI log); a maintainer owns that failure, and no CLA action is needed from you. (This comment previously asked for a record.)`,
  ].join("\n");
}

/** What the notice becomes once the gate passes — kept, not deleted, so the
 * thread's history stays truthful. */
export function buildClaResolvedComment({ author }) {
  return [
    CLA_NOTICE_MARKER,
    "### Contributor License Agreement — resolved",
    "",
    `The CLA check passes for this pull request now — thanks, @${author}. A maintainer still confirms the contributor record before merging. (This comment previously listed what was missing.)`,
  ].join("\n");
}

function argValue(args, flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * CLI entry: `cla-notice --pr <number> --author <login> [--author-type <type>]`.
 * Reads `GITHUB_TOKEN` and `GITHUB_REPOSITORY`. Returns a process exit code.
 */
export async function claNotice(args, { spawn = spawnSync, client } = {}) {
  const pr = argValue(args, "--pr");
  const author = argValue(args, "--author");
  const authorType = argValue(args, "--author-type");
  const commits = argValue(args, "--commits");
  if (!pr || !author) {
    console.error("cla-notice: --pr <number> and --author <login> are required");
    return 2;
  }
  // `repo` renders the comment's links, so it is required even when a client
  // is injected; the token only ever feeds the default client.
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || (!client && !token)) {
    console.error("cla-notice: GITHUB_REPOSITORY and GITHUB_TOKEN must be set");
    return 2;
  }

  const gate = runClaGate({ author, authorType, commits, spawn });
  if (gate.status !== 0 && gate.status !== 1) {
    // The gate could not judge at all (bad usage, missing documents) — that is
    // this tool's failure to surface, not something to bother the author with.
    console.error(`cla-notice: the CLA gate exited ${gate.status}:\n${gate.output}`);
    return 1;
  }

  // Exit 1 aggregates the whole tree's audit, not just this author: a record
  // someone else broke, or CLA.md's own template drifting, reddens the gate
  // for every pull request at once. A sign-up notice on those would tell a
  // compliant contributor to fix what is not theirs — so the notice posts only
  // when the output names this author's own record or account. Both fault
  // shapes carry one of those two spellings by construction
  // (`authorVerdict`, and the roster fault naming the record's handle).
  // A missing sign-off is always this author's to fix whatever commit it names:
  // the range judged is the pull request's own commits and nobody else's. Read
  // off `faults`, never the merged output — the gate's notes name the same
  // trailer while reporting no fault at all.
  const handle = author.toLowerCase();
  const lower = gate.faults.toLowerCase();
  const authorFault =
    lower.includes(`contributors/${handle}.md`) ||
    lower.includes(`'${handle}'`) ||
    lower.includes("signed-off-by:");

  const gh = client ?? githubClient({ repo, token });
  try {
    // The thread is read before the repository-wide short-circuit on purpose:
    // an earlier author-specific notice must not stay frozen at "action
    // needed" after the author fixed their part, so that branch still needs
    // to know whether a notice exists — and a thread this command cannot read
    // is a loud exit 1, never a silent skip.
    const existing = (await gh.listComments(pr)).find((c) => c.body?.startsWith(CLA_NOTICE_MARKER));
    if (gate.status === 1 && !authorFault) {
      if (existing) await gh.updateComment(existing.id, buildClaRepoWideComment({ author }));
      console.log(
        `cla-notice: gate is red for repository-wide reasons, not for '${author}' — ` +
          `${existing ? "existing notice flipped to say so" : "no notice"}; ` +
          `CI's own log is the right channel for that failure`,
      );
      return 0;
    }
    if (gate.status === 1) {
      const body = buildClaNoticeComment({ author, repo, gateOutput: gate.output });
      if (existing) await gh.updateComment(existing.id, body);
      else await gh.createComment(pr, body);
      console.log(`cla-notice: gate failed — notice ${existing ? "updated" : "posted"} on #${pr}`);
    } else if (existing) {
      await gh.updateComment(existing.id, buildClaResolvedComment({ author }));
      console.log(`cla-notice: gate passes — notice on #${pr} flipped to resolved`);
    } else {
      console.log(`cla-notice: gate passes and no notice exists on #${pr} — nothing to post`);
    }
  } catch (error) {
    console.error(`cla-notice: could not read or write the thread: ${error.message}`);
    return 1;
  }
  return 0;
}
