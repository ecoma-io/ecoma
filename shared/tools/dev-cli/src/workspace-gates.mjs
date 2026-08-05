/**
 * The workspace-wide gate list, as a single runnable command: every gate that
 * judges the whole tree and needs no event context, in one place that both
 * consumers execute — this repository's CI and the cloud repository's CI,
 * which mounts this workspace and must run the same list over the merged
 * tree.
 *
 * The list is the point, not the loop. Before it existed, "which gates judge
 * the workspace" could only be read off `.github/workflows/ci.yml`'s step
 * list, and any second consumer had to re-derive it — a derivation that can
 * silently disagree with the file it reads (a gate whose name breaks the
 * expected shape, a step that grows an argument) and reports green while
 * judging less than it claims. A command owns the list once; a consumer that
 * runs `workspace-gates` runs exactly what every other consumer runs, and a
 * gate added here reaches all of them in the same edit.
 *
 * What stays out, and why it is a rule rather than a residue: a gate whose
 * invocation needs event context (`check-commit-scope --commit <sha>`,
 * `check-contributor-record --author <login>`) is a per-event gate, owned by
 * the workflow step that knows the event. `check-contributor-record`'s bare
 * form is the one judgment call: it does read only the tree, but it is the
 * push-mode half of an event-scoped gate and stays beside its other half in
 * CI, so that one gate does not live in two places.
 *
 * Every failing gate is reported, not just the first — a red run on a moved
 * tree should name the whole bill in one pass. Output goes through a grouping
 * seam so a CI run folds each gate's report and a terminal run stays plain.
 */
import { checkClaudeMd } from "./check-claude-md.mjs";
import { checkCommandRefs } from "./check-command-refs.mjs";
import { checkDocLinks } from "./check-doc-links.mjs";
import { checkDoctrine } from "./check-doctrine.mjs";
import { checkWorkspaceDocs } from "./check-journey-markers.mjs";
import { checkLegalVersions } from "./check-legal-versions.mjs";
import { checkPracticeIndex } from "./check-practice-index.mjs";
import { checkProjectConventions } from "./check-project-conventions.mjs";
import { checkRoadmapIds } from "./check-roadmap-ids.mjs";
import { checkSubprojectReadmes } from "./check-subproject-readmes.mjs";
import { checkSubsystemReadmes } from "./check-subsystem-readmes.mjs";
import { conformance } from "./conformance.mjs";

/**
 * Name → thunk, in the order the gates run. Each name is the gate's own
 * registered command, so a red line here is re-runnable in isolation as
 * `node shared/tools/dev-cli/src/main.mjs <name>`.
 */
export const WORKSPACE_GATES = [
  ["conformance", () => conformance([])],
  ["check-journey-markers-workspace", () => checkWorkspaceDocs()],
  ["check-doc-links", () => checkDocLinks()],
  ["check-command-refs", () => checkCommandRefs()],
  ["check-claude-md", () => checkClaudeMd()],
  ["check-legal-versions", () => checkLegalVersions()],
  ["check-doctrine", () => checkDoctrine()],
  ["check-roadmap-ids", () => checkRoadmapIds()],
  ["check-practice-index", () => checkPracticeIndex()],
  ["check-subsystem-readmes", () => checkSubsystemReadmes()],
  ["check-subproject-readmes", () => checkSubprojectReadmes()],
  ["check-project-conventions", () => checkProjectConventions()],
];

/**
 * GitHub Actions folds everything between `::group::` and `::endgroup::`;
 * anywhere else those directives are noise, so a plain header stands in.
 */
function defaultGroup(log = console.error) {
  const inActions = process.env.GITHUB_ACTIONS === "true";
  return {
    open: (name) => log(inActions ? `::group::${name}` : `── ${name}`),
    close: () => inActions && log("::endgroup::"),
  };
}

/**
 * Runs every workspace gate and returns 0 only when all of them did. A gate
 * that throws is a failed gate, not a crashed run — the remaining gates still
 * report, and the summary names every red one.
 */
export function workspaceGates({
  gates = WORKSPACE_GATES,
  log = console.error,
  group = defaultGroup(log),
} = {}) {
  const failed = [];
  for (const [name, run] of gates) {
    group.open(name);
    let code;
    try {
      code = run() ?? 0;
    } catch (error) {
      log(String(error?.stack ?? error));
      code = 1;
    }
    group.close();
    if (code !== 0) failed.push(name);
  }
  if (failed.length > 0) {
    log(`workspace-gates: ${failed.length} of ${gates.length} gates failed: ${failed.join(", ")}`);
    return 1;
  }
  log(`workspace-gates: all ${gates.length} gates green`);
  return 0;
}
