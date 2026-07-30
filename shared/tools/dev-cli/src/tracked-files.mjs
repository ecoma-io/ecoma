/**
 * The workspace's tracked files, submodules included.
 *
 * `git ls-files` in a superproject stops at the gitlink: it reports `cloud` as a
 * single slashless entry and nothing beneath it. Every gate that audits *the
 * workspace* — which projects exist, which docs they carry, which links resolve
 * — therefore skipped a whole subtree while Nx, which scans the filesystem, saw
 * it. A project inside a submodule was visible to the boundary rules and
 * invisible to the tag and convention gates ([#3]).
 *
 * `--recurse-submodules` closes that with one flag and the same idiom. When the
 * submodule is not checked out — which is every contributor's clone and every
 * CI run, since `actions/checkout` does not fetch submodules — it simply lists
 * nothing extra, so both states stay green. That is the invariant the topology
 * rests on and it is why this is a flag rather than a second code path.
 *
 * Not every caller wants it. `check-commit-scope` reads the paths a
 * superproject commit touches, which never include submodule internals, and
 * `check-practice-index` deliberately keeps its cards citing public rules only —
 * a card quoting a file inside `cloud/` would fail for everyone who cannot see
 * it. Those keep plain `git ls-files` on purpose.
 *
 * [#3]: https://github.com/ecoma-io/ecoma/issues/3
 */
import { execFileSync } from "node:child_process";

import { cwdGitEnv } from "./git-env.mjs";

/**
 * Tracked paths matching `pathspecs` (all files when omitted), submodules
 * included. `run` is injectable so the flag can be pinned without a fixture
 * repository carrying a real submodule.
 */
export function listTrackedFiles(pathspecs = [], run = defaultRun) {
  const args = ["ls-files", "--recurse-submodules"];
  if (pathspecs.length > 0) args.push("--", ...pathspecs);
  return run(args).split("\n").filter(Boolean);
}

const defaultRun = (args) => execFileSync("git", args, { encoding: "utf8", env: cwdGitEnv() });
