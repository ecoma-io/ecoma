/**
 * Partitions a pull request's changed files into the units this workspace
 * already reviews by.
 *
 * A single review pass over a whole pull request degrades in three ways that
 * were measured on a real 46-file diff, not assumed:
 *
 *   - the diff is truncated (128k characters against a 45k budget), so most of
 *     it is never read and the comment can only say so;
 *   - every `pathCard` is offered against every file, because `activeChecks`
 *     activates a card when ANY changed file matches its scope — one comment
 *     edited in a stylesheet put the design-vocabulary card in front of models
 *     reviewing skills and workflows;
 *   - the whole run is one draw against a pool that fails roughly a quarter of
 *     its calls. In the measurement, two of three models failed on the full
 *     diff and the third returned nothing, so the run reached no quorum at all
 *     while the same models, on one group of it, each returned a finding.
 *
 * The grouping key is deliberately the one this repository already uses to
 * decide a commit's scope: the deepest project that owns the path, else its
 * subsystem, else its top-level directory, else the repository root. A group is
 * therefore exactly the work one commit could have carried, which is what makes
 * a grouped review comment readable as a checklist rather than a flat list.
 *
 * The ownership rule is expressed here rather than imported from `dev-cli`'s
 * `check-commit-scope`, which owns the same idea for commit messages: a
 * cross-project source import would be an edge the Nx project graph cannot see
 * (see `shared/CLAUDE.md`). The duplication is the narrow half — deepest owning
 * root, then fall back — and rather than leave it to a comment,
 * `group-files.integration.test.mjs` pins the property that actually matters:
 * every project group is labelled with a scope `dev-cli list-scopes` prints, so
 * the two sides cannot drift apart on what a project is called without a test
 * going red. A divergence otherwise fails no build — reviews would simply be
 * grouped along a boundary the commit gate does not recognise, and nobody would
 * read a diff carefully enough to notice.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * Repo-relative roots of every Nx project: a directory holding a tracked
 * `project.json` is a project.
 *
 * Read from the git index, never from a directory walk. A walk finds build
 * output — a built Storybook ships its own `project.json`, and the first run of
 * this module's own integration test grouped by one — and no prune list stays
 * ahead of what a build emits next. The index is also the source `dev-cli`'s
 * gates already derive projects from, so the two cannot disagree about what
 * exists. `run` is injectable so the parse is unit-testable without a git
 * repository.
 */
export function discoverProjectRoots(dir = ".", run = defaultRun) {
  let output;
  try {
    output = run(dir, ["ls-files", "--recurse-submodules", "*project.json"]);
  } catch {
    return []; // not a git checkout: no projects to group by, and grouping degrades to directories
  }
  return output
    .split("\n")
    .filter((path) => path.endsWith("/project.json"))
    .map((path) => path.slice(0, -"/project.json".length))
    .sort();
}

const defaultRun = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

/**
 * The group a path belongs to, as a repo-relative directory or the sentinel
 * `.` for a file at the repository root.
 *
 * Deepest project wins, so a project nested inside a subsystem takes its files
 * back from it. A path under no project falls back to its top-level directory —
 * dot-directories included, which is what keeps `.claude` and `.github` apart
 * instead of collapsing them into one bucket with the root files, the split
 * that kept the largest group under budget in the measurement.
 */
export function ownerOf(path, projectRoots) {
  const owner = projectRoots.reduce(
    (best, root) =>
      path.startsWith(`${root}/`) && (!best || root.length > best.length) ? root : best,
    null,
  );
  if (owner) return owner;
  const slash = path.indexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

/**
 * `[{ name, files }]`, one entry per owner, ordered by descending file count so
 * the review spends its first (and most likely to succeed) calls on the part of
 * the pull request with the most in it. Ties break by name so a run is
 * reproducible.
 */
export function groupFiles(filenames, projectRoots, projectNames = {}) {
  const byOwner = new Map();
  for (const file of filenames) {
    const root = ownerOf(file, projectRoots);
    if (!byOwner.has(root)) byOwner.set(root, []);
    byOwner.get(root).push(file);
  }
  return [...byOwner.entries()]
    .map(([root, files]) => ({ root, name: label(root, projectNames), files }))
    .sort((a, b) => b.files.length - a.files.length || a.root.localeCompare(b.root));
}

/**
 * What a group is called in the comment. A project is named the way a commit
 * scope names it — the Nx project name, not its path — so a reviewer reads the
 * same vocabulary `check-commit-scope` enforces. Anything else keeps its
 * directory, which is already how contributors refer to it, and the repository
 * root is spelled out because `.` names nothing to a reader.
 */
function label(root, projectNames) {
  if (projectNames[root]) return projectNames[root];
  return root === "." ? "repository root" : root;
}

/**
 * `{ root: nxProjectName }` for every discovered project, read from each
 * `project.json`'s own `name`. A manifest that cannot be read or parsed is
 * skipped rather than fatal: the group still forms, it is just labelled by
 * path, and a malformed `project.json` is a failure the lint gate owns.
 */
export function readProjectNames(roots, dir = ".", read = defaultRead) {
  const names = {};
  for (const root of roots) {
    try {
      const name = JSON.parse(read(`${dir}/${root}/project.json`))?.name;
      if (typeof name === "string" && name) names[root] = name;
    } catch {
      continue;
    }
  }
  return names;
}

const defaultRead = (path) => readFileSync(path, "utf8");
