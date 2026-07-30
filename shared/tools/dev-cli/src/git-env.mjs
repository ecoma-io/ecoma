/**
 * The environment a production git spawn must run in: one where git resolves the
 * repository from the working directory it was handed, never from an ambient
 * variable that outranks it.
 *
 * Same hazard `git-fixture.mjs` closes for tests, arriving by a different door.
 * `GIT_DIR` outranks both `cwd` and `-C`, and a git hook run from a **linked
 * worktree** exports an absolute one (measured on git 2.43.0: `pre-commit` and
 * `pre-push` both export it from a worktree, neither does from a plain
 * checkout). `lefthook.yml`'s `pre-commit` runs `pnpm nx affected -t lint`, and
 * every lint target runs with `cwd: {projectRoot}` — so git, asked about the
 * repository from inside a project directory, answers that the project directory
 * IS the whole work tree. Both consequences were observed on this repository:
 * `check-e2e-story-coverage` dies because its pathspec is suddenly "outside
 * repository", and `check-journey-markers` gets a whole-index listing whose
 * repo-relative paths no longer resolve against its cwd, so it reports a clean
 * project having opened no file at all — the silent half, and the worse one.
 *
 * `GIT_INDEX_FILE` is deliberately NOT scrubbed, the one place this list is
 * narrower than the fixture's. It selects an index, not a repository, and at hook
 * time it is the authoritative one: `git commit -- <paths>` hands the hook a
 * temporary index naming exactly the paths being committed, so a gate that
 * ignored it would judge a change nobody is making.
 */

/**
 * The ambient variables that relocate the repository or its work tree. Named
 * here rather than in a shared config because they are git's own vocabulary, not
 * a decision of this workspace.
 */
export const REPO_SELECTING_GIT_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"];

/**
 * A copy of `env` in which git resolves the repository from the working
 * directory. Pass it as `env` on every production `execFileSync("git", …)`.
 */
export function cwdGitEnv(env = process.env) {
  const scrubbed = { ...env };
  for (const name of REPO_SELECTING_GIT_VARS) delete scrubbed[name];
  return scrubbed;
}
