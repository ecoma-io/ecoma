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

export const WORKSPACE_SCOPE = "workspace";

// Derived artifacts a commit drags along regardless of its subject — never
// counted when computing the covering scope (a project-scoped dependency bump
// must not be forced to `workspace` by the root lockfile).
const EXEMPT_PATHS = new Set(["pnpm-lock.yaml"]);

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
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });

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
  const subsystems = deriveSubsystems(projects);
  const { allowed, owners, projectNames, upstreamEligible, mustSplit } = evaluateScopes(
    paths,
    projects,
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
