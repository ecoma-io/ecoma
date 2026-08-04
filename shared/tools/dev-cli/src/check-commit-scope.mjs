/**
 * Enforces the scope ↔ path contract on a Conventional Commit: the scope must
 * be the *narrowest* scope covering every path the commit touches.
 *
 * Scope vocabulary (also exported to `commitlint.config.mjs` for `scope-enum`
 * — single source of truth):
 *   - every Nx project name (discovered from tracked `project.json` files);
 *   - every subsystem root — a top-level directory containing at least one
 *     project (`shared`, and any product subsystem root), which also owns
 *     subsystem files no project claims (e.g. `shared/CLAUDE.md`);
 *   - `workspace` — root files and anything spanning subsystems.
 *
 * Narrowest-covering rule: one project → that project's name; several owners
 * inside one subsystem → the subsystem; anything wider (multiple subsystems,
 * or every path root-owned) → `workspace`. One relaxation keeps atomic
 * cross-project commits honest: when every touched path belongs to a project
 * and all other touched projects transitively depend on one of them (per the
 * Nx project graph), that upstream project's name is also allowed — an API
 * change in `core-ui` may adapt its consumers in the same commit as
 * `fix(core-ui): …`.
 *
 * A commit that mixes root-owned paths (e.g. the single-package-monorepo
 * `package.json`) with project- or subsystem-owned paths has no honest
 * covering scope at all — `workspace` would bury the project-specific work in
 * a generic bucket the changelog can't attribute, and the project/subsystem
 * scope would misdescribe the root-level change. Rather than pick a lesser
 * evil, this is rejected outright: split into one commit for the root-owned
 * paths (`workspace`) and one per project/subsystem for the rest.
 *
 * One path a commit touches may have no owner left in the tree being judged:
 * the *old* side of a project that this very commit moved. Resolving it
 * against the commit's tree alone makes a relocation unjudgeable — the old
 * paths read as root-owned, the new ones as the project's, and the mix is
 * rejected as needing a split that cannot be made, because deleting a
 * project's files and creating them elsewhere is one act with one honest
 * scope. So a project that exists in both the parent tree and this one lends
 * its parent-tree root as an owner too, and `refactor(doctrine): …` covers the
 * move whole. The name must survive in the current tree for its old root to
 * count: a project genuinely *deleted* falls through to whatever still owns
 * the space it stood in — its subsystem, or `workspace` when it was that
 * subsystem's last project — exactly as before. Borrowing a name for it would
 * demand a scope commitlint's `scope-enum` cannot accept, because a vocabulary
 * derived from the tracked tree cannot contain a name that tree no longer has.
 *
 * Two modes share the logic; both discover projects from the tree being
 * judged (so a commit scaffolding a new project may already use its scope):
 *   - `check-commit-scope <msg-file>` — commit-msg hook; paths from the index.
 *     Best-effort under `--amend`/rebase (the index diff is empty or partial);
 *     CI is the authoritative net.
 *   - `check-commit-scope --commit <sha>` — CI; paths and tree from that
 *     commit.
 *
 * Message shape, mandatory scope, and the scope vocabulary itself are
 * commitlint's rules (tier 1); this check silently defers anything it cannot
 * parse or that carries no scope.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { cwdGitEnv } from "./git-env.mjs";

export const WORKSPACE_SCOPE = "workspace";

// Derived artifacts a commit drags along regardless of its subject — never
// counted when computing the covering scope (a project-scoped dependency bump
// must not be forced to `workspace` by the root lockfile).
//
// `go.work.sum` earns its place for a stronger reason than the lockfile's: it
// is root-owned, so without the exemption `go mod tidy` inside one module
// writes that module's own `go.sum` *and* this root file in the same breath,
// which `mustSplit` rejects outright — and the split it demands is impossible,
// because the two halves are one atomic act. Only this file: `Cargo.lock` and
// `uv.lock` are root-owned too but no per-project counterpart forces them to
// travel with a project change, so they stay judged.
const EXEMPT_PATHS = new Set(["pnpm-lock.yaml", "go.work.sum"]);

// Mirror of @commitlint/is-ignored's default wildcards (not importable here —
// pnpm exposes it only to commitlint's own packages). Messages commitlint
// waves through must not be failed by this tier either.
const IGNORED_MESSAGE_RES = [
  /^Merge pull request /,
  /^((Merge (.*?) into (.*?))|(Merge branch (.*?)))(?:\r?\n)*$/m,
  /^(R|r)evert (.*)/,
  /^(fixup|squash|amend)!/,
  /^Merged (.*?)(in|into) (.*)/,
  /^Merge remote-tracking branch (.*)/,
  /^Automatic merge(.*)/,
  /^Auto-merged (.*?) into (.*)/,
  /^v?\d+\.\d+\.\d+(-\S+)?$/, // bare semver bump
];

const SCISSORS = "# ------------------------ >8 ------------------------";

// `cwd` selects the repository to read; undefined keeps git's own default (the
// process working directory), which is what every production caller wants — the
// commit-msg hook and CI both run at the repo root. Taking it as an argument is
// what lets a caller judge a repository other than the one it is standing in,
// instead of `process.chdir`-ing the whole runner to get there.
//
// `cwdGitEnv` is what makes that promise true: `GIT_DIR` outranks `cwd`, so
// without it a hook could hand this check a different repository than the one it
// was pointed at (`git-env.mjs`). `GIT_INDEX_FILE` deliberately survives the
// scrub — under `git commit -- <paths>` it names the temporary index holding
// exactly the paths being committed, which is the set this check must judge.
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: cwdGitEnv() });

/**
 * First real line of a commit message file: comment lines and everything from
 * the scissors marker on (verbose-mode diff) are stripped, as git will strip
 * them after the hook runs.
 */
export function messageHeader(message) {
  for (const line of message.split(/\r?\n/)) {
    if (line === SCISSORS) break;
    if (line.startsWith("#")) continue;
    if (line.trim() !== "") return line;
  }
  return "";
}

/** True for messages commitlint ignores by default (merges, git reverts, …). */
export function isIgnoredMessage(header) {
  return IGNORED_MESSAGE_RES.some((re) => re.test(header));
}

/** Parses `type(scope)!: subject` → `{ type, scope }`; null when not Conventional. */
export function parseHeader(header) {
  const m = header.match(/^([a-z]+)(?:\(([^)]*)\))?!?: .+/);
  return m ? { type: m[1], scope: m[2] ?? null } : null;
}

/**
 * Discovers Nx projects from tracked `project.json` files — the index when
 * `ref` is null (hook mode), that commit's tree otherwise (CI mode). Returns
 * `[{ name, root, tags }]`. `cwd` picks the repository (see the `git` helper).
 */
export function discoverProjects(ref = null, cwd = undefined) {
  const listing = ref ? git(["ls-tree", "-r", "--name-only", ref], cwd) : git(["ls-files"], cwd);
  const projects = [];
  for (const path of listing.split("\n").filter(Boolean)) {
    if (path !== "project.json" && !path.endsWith("/project.json")) continue;
    const root = dirname(path);
    if (root === ".") continue; // a repo-root project would own every path
    let json;
    try {
      json = JSON.parse(git(["show", `${ref ?? ""}:${path}`], cwd));
    } catch {
      continue; // an unparsable project.json is lint's problem, not this check's
    }
    projects.push({
      name: json.name ?? basename(root),
      root,
      tags: Array.isArray(json.tags) ? json.tags : [],
    });
  }
  return projects;
}

/**
 * The projects that own the paths of one commit: those in the tree being
 * judged, plus the parent-tree root of any project that is still there under a
 * different one. Only the *root* is borrowed, and only for a surviving name —
 * see the module header for why a deleted project must not borrow one.
 *
 * Order matters no more than duplication does: `ownerOf` keeps the deepest
 * matching root, and a project that did not move contributes the same root
 * twice.
 */
export function owningProjects(projects, parentProjects) {
  const names = new Set(projects.map((p) => p.name));
  return [...projects, ...parentProjects.filter((p) => names.has(p.name))];
}

/**
 * Projects as of the parent of the commit being judged — the tree that still
 * held whatever this commit deletes. `[]` when there is no parent to read
 * (a root commit, an unborn branch, a ref git cannot resolve), which is the
 * honest answer rather than a failure: nothing existed before.
 */
export function parentProjectsOf(ref = null, cwd = undefined) {
  try {
    return discoverProjects(ref ? `${ref}^` : "HEAD", cwd);
  } catch {
    return [];
  }
}

/** Subsystem roots: top-level directories that contain at least one project. */
export function deriveSubsystems(projects) {
  const subsystems = new Set();
  for (const { root } of projects) {
    const top = root.split("/")[0];
    if (top !== root) subsystems.add(top); // a top-level project is not a subsystem
  }
  return subsystems;
}

/**
 * The full commit-scope vocabulary for a project set: every project name,
 * every subsystem root, and `workspace` — deduped (a subsystem's single
 * project can name both an app and its subsystem) and sorted. The single
 * derivation shared by `commitlint.config.mjs` (tier 1 `scope-enum`) and
 * `dev-cli list-scopes`.
 */
export function allScopes(projects) {
  return [
    ...new Set([...projects.map((p) => p.name), ...deriveSubsystems(projects), WORKSPACE_SCOPE]),
  ].sort();
}

/** Maps one path to its owner: deepest containing project, else subsystem, else workspace. */
export function ownerOf(path, projects, subsystems) {
  let best = null;
  for (const p of projects) {
    if (path === p.root || path.startsWith(`${p.root}/`)) {
      if (!best || p.root.length > best.root.length) best = p;
    }
  }
  if (best) return { kind: "project", name: best.name, root: best.root };
  const top = path.split("/")[0];
  if (subsystems.has(top)) return { kind: "subsystem", name: top };
  return { kind: "workspace", name: WORKSPACE_SCOPE };
}

/**
 * Computes the narrowest covering scope for `paths`. Returns
 * `{ allowed, owners, projectNames, upstreamEligible, mustSplit }` —
 * `upstreamEligible` marks commits where the upstream-project exception could
 * additionally apply (every path project-owned, more than one project), which
 * the caller resolves against the Nx graph only when needed (the graph is
 * expensive to read); `mustSplit` marks a mix of root-owned and project- or
 * subsystem-owned paths, which has no honest covering scope at all —
 * `allowed` is left empty and the caller rejects unconditionally (see module
 * header).
 */
export function evaluateScopes(paths, projects, subsystems) {
  const owners = paths.map((path) => ({ path, owner: ownerOf(path, projects, subsystems) }));
  const projectNames = new Set(
    owners.filter((o) => o.owner.kind === "project").map((o) => o.owner.name),
  );
  const allProjectOwned = owners.every((o) => o.owner.kind === "project");
  const hasWorkspaceOwned = owners.some((o) => o.owner.kind === "workspace");
  const mustSplit = hasWorkspaceOwned && owners.some((o) => o.owner.kind !== "workspace");
  const allowed = new Set();

  if (mustSplit) {
    // No single scope honestly covers this mix — see the module header.
  } else if (allProjectOwned && projectNames.size === 1) {
    allowed.add([...projectNames][0]);
  } else if (hasWorkspaceOwned) {
    allowed.add(WORKSPACE_SCOPE); // every path is root-owned
  } else {
    const touchedSubsystems = new Set(
      owners.map(({ owner }) => {
        if (owner.kind === "subsystem") return owner.name;
        const top = owner.root.split("/")[0];
        return subsystems.has(top) ? top : null;
      }),
    );
    if (!touchedSubsystems.has(null) && touchedSubsystems.size === 1) {
      allowed.add([...touchedSubsystems][0]);
    } else {
      allowed.add(WORKSPACE_SCOPE);
    }
  }

  return {
    allowed,
    owners,
    projectNames,
    upstreamEligible: allProjectOwned && projectNames.size > 1,
    mustSplit,
  };
}

/** True when `dependent` reaches `dependency` in the project graph (cycle-safe). */
export function transitiveDependsOn(dependent, dependency, deps) {
  const seen = new Set([dependent]);
  const queue = [dependent];
  while (queue.length > 0) {
    for (const target of deps.get(queue.shift()) ?? []) {
      if (target === dependency) return true;
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return false;
}

/** Groups `owners` by owner name and prints up to 5 example paths each. */
function logOwners(owners) {
  const byOwner = new Map();
  for (const { path, owner } of owners) {
    const key = owner.kind === "project" ? owner.name : `(${owner.kind}) ${owner.name}`;
    byOwner.set(key, [...(byOwner.get(key) ?? []), path]);
  }
  for (const [ownerName, ownedPaths] of byOwner) {
    const shown = ownedPaths.slice(0, 5).join(", ");
    const more = ownedPaths.length > 5 ? ` (+${ownedPaths.length - 5} more)` : "";
    console.error(`  ${ownerName}: ${shown}${more}`);
  }
}

/** Direct project → project dependencies from `nx graph` (npm packages dropped). */
export function readProjectGraphDeps() {
  const out = join(mkdtempSync(join(tmpdir(), "commit-scope-graph-")), "graph.json");
  execFileSync("pnpm", ["nx", "graph", `--file=${out}`], { stdio: "ignore", shell: true });
  const graph = JSON.parse(readFileSync(out, "utf8"));
  const deps = new Map();
  for (const [name, edges] of Object.entries(graph.graph?.dependencies ?? {})) {
    deps.set(
      name,
      edges.map((e) => e.target).filter((t) => !t.startsWith("npm:")),
    );
  }
  return deps;
}

/**
 * CLI entry — see the module header for modes. Returns a process exit code.
 * `readDeps` is injectable so tests never spawn nx; `cwd` names the repository
 * to judge, defaulting to the process working directory.
 */
export function checkCommitScope(args, { readDeps = readProjectGraphDeps, cwd } = {}) {
  let message;
  let ref = null;
  let changed;
  if (args[0] === "--commit" && args[1]) {
    ref = args[1];
    message = git(["log", "-1", "--format=%B", ref], cwd);
    changed = git(["show", "--no-renames", "--name-only", "--format=", ref], cwd);
  } else if (args[0] && args[0] !== "--commit") {
    message = readFileSync(args[0], "utf8");
    changed = git(["diff", "--cached", "--no-renames", "--name-only"], cwd);
  } else {
    console.error("usage: check-commit-scope <commit-msg-file> | --commit <sha>");
    return 2;
  }

  const header = messageHeader(message);
  if (header === "" || isIgnoredMessage(header)) return 0;
  const parsed = parseHeader(header);
  if (!parsed || !parsed.scope) return 0; // shape and mandatory scope are commitlint's rules

  const { scope } = parsed;
  if (/[,/\s]/.test(scope)) {
    console.error(
      `commit scope '${scope}': one scope per commit — use the narrowest covering scope or split the commit`,
    );
    return 1;
  }

  const paths = changed.split("\n").filter((p) => p !== "" && !EXEMPT_PATHS.has(p));
  if (paths.length === 0) return 0; // empty/amend/exempt-only commit — nothing to judge

  const projects = discoverProjects(ref, cwd);
  // Subsystems come from the tree being judged alone, deliberately: a
  // subsystem's own files (`<area>/CLAUDE.md`, its READMEs) are its identity,
  // and moving those is a different act from moving a project that happens to
  // live inside it. Only project roots are borrowed from the parent.
  const subsystems = deriveSubsystems(projects);
  const { allowed, owners, projectNames, upstreamEligible, mustSplit } = evaluateScopes(
    paths,
    owningProjects(projects, parentProjectsOf(ref, cwd)),
    subsystems,
  );

  if (mustSplit) {
    console.error(
      "commit mixes root-owned paths with project- or subsystem-owned paths — no single scope " +
        "covers both honestly; split into one commit scoped `workspace` for the root paths and " +
        "one per project/subsystem for the rest",
    );
    logOwners(owners);
    return 1;
  }

  if (allowed.has(scope)) return 0;

  // Upstream-project exception, resolved against the Nx graph only when the
  // claimed scope is itself one of the touched projects.
  if (upstreamEligible && projectNames.has(scope)) {
    const deps = readDeps();
    const others = [...projectNames].filter((p) => p !== scope);
    if (others.every((p) => transitiveDependsOn(p, scope, deps))) return 0;
  }

  console.error(
    `commit scope '${scope}' does not match the changed paths — the scope must be the ` +
      `narrowest one covering every path (allowed here: ${[...allowed].sort().join(", ")})`,
  );
  logOwners(owners);
  if (upstreamEligible) {
    console.error(
      "  (a touched project's scope is also allowed when every other touched project depends on it)",
    );
  }
  return 1;
}
