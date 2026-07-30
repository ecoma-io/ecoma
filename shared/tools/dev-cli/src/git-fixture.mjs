/**
 * Git-fixture plumbing shared by dev-cli's integration tests: a throwaway repo
 * under the OS temp dir, driven so that no ambient git state can redirect a
 * read or a write into a real checkout.
 *
 * The hazard, concretely: git resolves `GIT_DIR` *before* the working
 * directory, so `-C` and `cwd` both lose to an inherited `GIT_DIR`.
 * `lefthook.yml`'s `pre-push` hook runs `verify`, which runs this suite — and a
 * git hook exports `GIT_DIR` pointing at the repository being pushed. An
 * unqualified (or merely `cwd`-qualified) `git add`/`git commit` inside a
 * fixture therefore commits into *that* repository and rewrites the branch
 * under the developer, which is what happened in issue #82.
 *
 * Three layers close it, in order of who they protect:
 *   1. `scrubGitEnv()`, run once from `vitest.setup.mjs`, strips the
 *      repo-selecting variables from this process. Only this layer can protect
 *      the command modules called *in process* (`checkClaudeMd` and friends
 *      spawn their own unqualified git).
 *   2. `fixtureGit` pins `-C`, `cwd`, and a scrubbed `env` on every spawn, so a
 *      fixture write is contained even if layer 1 is missing.
 *   3. `assertFixtureIsolated` fails the run loudly if either of the above is
 *      broken, rather than letting a write find a real repository.
 *
 * Consequence for anyone adding an integration test here: drive git through
 * `fixtureGit`/`initFixtureRepo`, never a bare `execFileSync("git", …)`.
 *
 * The production half of the same hazard lives in `git-env.mjs`, which owns the
 * repo-selecting variable names this file builds on.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { REPO_SELECTING_GIT_VARS } from "./git-env.mjs";

/**
 * Ambient variables a fixture must not inherit. Each of them outranks both the
 * working directory and `-C`. The repo-selecting ones are shared with production
 * (`git-env.mjs`); `GIT_INDEX_FILE` is added here only, because production keeps
 * it on purpose — a hook's index is the change being committed — while a fixture
 * has no business reading any index but its own.
 */
const FIXTURE_ISOLATED_GIT_VARS = [...REPO_SELECTING_GIT_VARS, "GIT_INDEX_FILE"];

/** A copy of `env` with every repo-selecting git variable removed. */
export function fixtureEnv(env = process.env) {
  const scrubbed = { ...env };
  for (const name of FIXTURE_ISOLATED_GIT_VARS) delete scrubbed[name];
  return scrubbed;
}

/**
 * Removes the repo-selecting git variables from this process, so in-process
 * command modules and any child that inherits the environment resolve git from
 * the path they are given. Run once per test process from `vitest.setup.mjs`.
 */
export function scrubGitEnv(env = process.env) {
  for (const name of FIXTURE_ISOLATED_GIT_VARS) delete env[name];
}

/** Repo-selecting git variables still present in `env`, if any. */
function inheritedGitVars(env = process.env) {
  return FIXTURE_ISOLATED_GIT_VARS.filter((name) => env[name] !== undefined);
}

/** True when `child` is `parent` or lives beneath it. */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Runs git against `dir` and only `dir`: `-C`, a pinned cwd, and a scrubbed env. */
export function fixtureGit(dir, args, options = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: fixtureEnv(),
    ...options,
  });
}

/**
 * Fail-loud precondition for a fixture repo — better to abort the whole run
 * than to let a test write into a real checkout (issue #82, where exactly that
 * deleted a developer's tree twice). Asserted before the fixture's first write:
 *
 *   1. `dir` is under the OS temp dir, so even a total loss of isolation can
 *      only damage a throwaway path. (The subject is the fixture directory, not
 *      `process.cwd()`: these tests no longer `chdir`, so the process sits at
 *      the repo root by design.)
 *   2. no repo-selecting git variable survives in this process, i.e. layer 1
 *      ran. Without it the in-process command modules would still read the
 *      inherited repository.
 *   3. driven through `fixtureGit` — the same code path every fixture write
 *      takes — git resolves *no* repository at `dir` yet. If it resolves one,
 *      a dropped `-C`/`cwd` or an unscrubbed spawn env is pointing git at a
 *      real repository and every write from here would land in it.
 */
export function assertFixtureIsolated(dir) {
  const temp = realpathSync(tmpdir());
  if (!isInside(temp, dir)) {
    throw new Error(
      `git fixture refuses to run: ${dir} is not under the OS temp dir (${temp}) — ` +
        `a fixture may only ever write to a throwaway path`,
    );
  }

  const inherited = inheritedGitVars();
  if (inherited.length > 0) {
    throw new Error(
      `git fixture refuses to run: ${inherited.join(", ")} still set in this process ` +
        `(${inherited.map((n) => `${n}=${process.env[n]}`).join(", ")}). ` +
        `These outrank cwd and -C, so a fixture would read and write the inherited ` +
        `repository. vitest.setup.mjs is supposed to have scrubbed them.`,
    );
  }

  let resolved;
  try {
    resolved = fixtureGit(dir, ["rev-parse", "--absolute-git-dir"], { stdio: "pipe" }).trim();
  } catch {
    return; // no repository resolves at the fresh fixture — exactly what we want
  }
  throw new Error(
    `git fixture refuses to run: git resolves ${resolved} from the fresh fixture ${dir}. ` +
      `A dropped -C/cwd or an unscrubbed spawn environment is pointing git at a real ` +
      `repository — every write from here would land in it.`,
  );
}

/**
 * Creates a throwaway git repo under the OS temp dir holding `files`, all
 * staged, with a fixture commit identity configured. Returns its path.
 */
export function initFixtureRepo(prefix, files = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), `${prefix}-`));
  assertFixtureIsolated(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  fixtureGit(dir, ["init", "-q"]);
  fixtureGit(dir, ["config", "user.email", "test@example.com"]);
  fixtureGit(dir, ["config", "user.name", "Test"]);
  fixtureGit(dir, ["add", "-A"]);
  return dir;
}
