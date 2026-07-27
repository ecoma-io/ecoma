/**
 * Keeps the commit identity attributed to the human operator of the current
 * session — never the agent/sandbox bot — in the one environment where the bot
 * would otherwise leak in: a cloud agent sandbox whose ambient git identity is
 * `Claude <noreply@anthropic.com>`.
 *
 * Two modes, one command:
 *   - `ensure-commit-identity`          — setter. Run at session start. When
 *     the ambient committer is the bot, it resolves the operator and writes the
 *     repo-local git identity (author + committer) plus disables signing (the
 *     only key present is the bot's, so a signature would be bot residue and
 *     Unverified anyway). Idempotent; a no-op once the identity is a human's,
 *     so it never touches a contributor's own machine.
 *   - `ensure-commit-identity --check`  — guard. Run at pre-commit. git resolves
 *     the commit identity *before* pre-commit runs, so this cannot rewrite the
 *     current commit — it fixes the repo config for the retry and fails loud,
 *     closing the session-timing gap (a session predating the setter, or a
 *     mid-session `.git/config` reset) that no session-start hook can.
 *
 * The operator is resolved dynamically from the session, never hardcoded:
 *   1. GitHub display name via `GET /user` (through the sandbox's auth proxy);
 *   2. `CLAUDE_CODE_USER_EMAIL` — the session operator's email, deterministic
 *      and offline — as the email of record and the fallback when the API is
 *      unreachable.
 * Email of record is the account's public address (per the operator's choice),
 * falling back to the GitHub `{id}+{login}` noreply form when none is exposed.
 */
import { execFileSync } from "node:child_process";

// The agent/sandbox bot identity we refuse to let author commits. Its signing
// key is registered to this address; a commit under any other committer is the
// thing we are enforcing, not preventing.
export const BOT_EMAIL = "noreply@anthropic.com";

/** True when an email is the bot's or absent — the identities the guard blocks. */
export function isBotEmail(email) {
  return !email || email.toLowerCase() === BOT_EMAIL;
}

/** Extracts the `<email>` from a `git var GIT_*_IDENT` line (`Name <email> ts tz`). */
export function identEmail(identLine) {
  const m = (identLine ?? "").match(/<([^>]*)>/);
  return m ? m[1] : "";
}

/**
 * Chooses the operator identity from the two dynamic sources. `apiUser` is the
 * parsed GitHub `/user` payload (or null when unreachable); `envEmail` is
 * `CLAUDE_CODE_USER_EMAIL`. Returns `{ name, email }`, or null when no email can
 * be determined at all (the guard then asks the operator to set it by hand).
 */
export function pickIdentity(apiUser, envEmail) {
  const email =
    apiUser?.email ||
    envEmail ||
    (apiUser?.login && apiUser?.id
      ? `${apiUser.id}+${apiUser.login}@users.noreply.github.com`
      : "");
  if (!email) return null;
  const name = apiUser?.name || apiUser?.login || envEmail || email;
  return { name, email };
}

/** Real I/O the two modes need; overridden wholesale in unit tests. */
export function defaultDeps() {
  const git = (args) => execFileSync("git", args, { encoding: "utf8" });
  return {
    env: process.env,
    committerEmail: () => identEmail(git(["var", "GIT_COMMITTER_IDENT"])),
    authorEmail: () => identEmail(git(["var", "GIT_AUTHOR_IDENT"])),
    setConfig: (key, value) => git(["config", key, value]),
    fetchGithubUser: () => {
      // curl, not Node fetch: the sandbox auth proxy (which injects the real
      // GitHub credential) is only honored by proxy-aware clients — Node's
      // global fetch ignores HTTPS_PROXY and would be rejected. A dev-cli
      // command already shells out (git, nx); this stays out of the emitted
      // git hook, which is kept dependency-free.
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      const headers = [
        "-H",
        "User-Agent: ecoma-dev-cli",
        "-H",
        "Accept: application/vnd.github+json",
      ];
      if (token) headers.push("-H", `Authorization: Bearer ${token}`);
      try {
        const out = execFileSync(
          "curl",
          ["-sS", "--max-time", "10", ...headers, "https://api.github.com/user"],
          { encoding: "utf8" },
        );
        const json = JSON.parse(out);
        return json?.login
          ? { login: json.login, id: json.id, name: json.name ?? null, email: json.email ?? null }
          : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolves the operator and writes the repo-local identity, but only when the
 * ambient committer is the bot (so a human machine is never touched). Returns
 * `{ acted, email }` — `acted` false means either the identity was already a
 * human's, or the operator could not be resolved.
 */
export function applyIdentity(deps) {
  if (!isBotEmail(deps.committerEmail())) return { acted: false, email: null };
  const identity = pickIdentity(deps.fetchGithubUser(), deps.env.CLAUDE_CODE_USER_EMAIL);
  if (!identity) return { acted: false, email: null };

  deps.setConfig("user.name", identity.name);
  deps.setConfig("user.email", identity.email);
  // Drop the bot's signature: keeping it would be both agent residue and, under
  // a human committer, permanently Unverified on GitHub.
  deps.setConfig("commit.gpgsign", "false");
  return { acted: true, email: identity.email };
}

/** Setter mode: best-effort at session start; the guard is the hard gate. */
function runSetter(deps) {
  applyIdentity(deps);
  return 0;
}

/** Guard mode: block any commit whose author or committer is still the bot. */
function runGuard(deps) {
  if (!isBotEmail(deps.committerEmail()) && !isBotEmail(deps.authorEmail())) return 0;

  const { acted, email } = applyIdentity(deps);
  if (acted) {
    console.error(
      `commit identity was the agent bot (${BOT_EMAIL}); the repo git config has ` +
        `been reset to the session operator (${email}). Re-run your commit.`,
    );
  } else {
    console.error(
      `commit identity is the agent bot (${BOT_EMAIL}) and the operator could not ` +
        `be resolved from the session. Set it by hand, then re-run your commit:\n` +
        `  git config user.email <you@example.com> && git config user.name "<Your Name>"`,
    );
  }
  return 1;
}

/** CLI entry — `--check` selects the guard; anything else runs the setter. */
export function ensureCommitIdentity(args = [], deps = defaultDeps()) {
  return args.includes("--check") ? runGuard(deps) : runSetter(deps);
}
