/**
 * `audit-roadmap-labels` — the board half of the roadmap's §0 two-way law:
 * every roadmap id traces to a card, and **every card traces to an id**.
 *
 * `dev-cli check-roadmap-ids` holds the file half — it reads the document and
 * refuses an id that cites an undefined track, gate or milestone. It cannot see
 * the other direction, because the other direction is not in the file: a card
 * labelled with an id the roadmap has since renamed or dropped looks perfectly
 * ordinary from inside the document. That is the drift this command catches.
 *
 * **The board here is the label scheme, not a Projects board**, and that is a
 * finding rather than a shortcut: the tracker in use carries `roadmap:`,
 * `track:`, `gate:` and `milestone:` labels, and no Projects v2 board exists to
 * audit. Reading the labels audits the board that is real. If a Projects board
 * is ever adopted, its cards carry these same labels and this command keeps
 * working — what would change is only that a second source of cards appeared.
 *
 * **The vocabulary is the roadmap's, spawned rather than restated** (Rule 14
 * rung 1): `dev-cli list-roadmap-ids --json` derives it from §6b, §1b and §4 by
 * the same functions the file-half gate judges against. A relative import
 * across two Nx projects would be an edge the project graph cannot see, which
 * is why the seam is a process rather than a module.
 *
 * It is **read-only by design**. Relabelling an issue from a rename is a
 * judgment about which id the work moved to, and getting that wrong silently
 * rewrites the project's own history of what was decided. The command reports;
 * a human relabels.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { githubClient } from "./github.mjs";

/** Label prefix → the vocabulary key it must resolve against. */
export const LABEL_VOCABULARIES = {
  "roadmap:": "ids",
  "track:": "tracks",
  "gate:": "gates",
  "milestone:": "milestones",
};

// Both paths are derived from this file's own location, never from the process:
// dev-cli reads the roadmap through a repo-relative path, and this command runs
// from a workflow whose working directory is not something to rely on.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const DEV_CLI = join(REPO_ROOT, "shared/tools/dev-cli/src/main.mjs");

/**
 * The roadmap vocabulary, via dev-cli. Gate labels are written `gate:G0` while
 * the roadmap spells the gate `◆G0`, so the marker is normalised away here —
 * a label cannot carry it, and the two must still compare.
 */
export function readVocabulary(run = defaultRun) {
  const raw = run();
  let vocab;
  try {
    vocab = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`could not read the roadmap vocabulary from dev-cli: ${raw}`, { cause });
  }
  return { ...vocab, gates: vocab.gates.map((g) => g.replace(/^◆/, "")) };
}

function defaultRun() {
  const res = spawnSync(process.execPath, [DEV_CLI, "list-roadmap-ids", "--json"], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });
  if (res.status !== 0) throw new Error(`dev-cli list-roadmap-ids failed: ${res.stderr}`);
  return res.stdout;
}

/**
 * Returns `[{ issue, label, kind }]` for every roadmap-vocabulary label naming
 * something the roadmap does not define. Pure — the whole judgment is testable
 * without a tracker.
 */
export function findLabelFaults(issues, vocabulary) {
  const faults = [];
  for (const issue of issues) {
    for (const label of issue.labels ?? []) {
      const name = typeof label === "string" ? label : label.name;
      const prefix = Object.keys(LABEL_VOCABULARIES).find((p) => name.startsWith(p));
      if (!prefix) continue;
      const kind = LABEL_VOCABULARIES[prefix];
      const value = name.slice(prefix.length);
      if (!vocabulary[kind].includes(value)) {
        faults.push({ issue: issue.number, label: name, kind });
      }
    }
  }
  return faults;
}

/**
 * Ids the roadmap defines that no card carries. Reported, never failed: most
 * ids are engine work nobody has opened a card for yet, and a milestone with no
 * cards is a normal state of a plan rather than a defect.
 */
export function findUncardedIds(issues, vocabulary) {
  const carried = new Set(
    issues.flatMap((i) =>
      (i.labels ?? [])
        .map((l) => (typeof l === "string" ? l : l.name))
        .filter((n) => n.startsWith("roadmap:"))
        .map((n) => n.slice("roadmap:".length)),
    ),
  );
  return vocabulary.ids.filter((id) => !carried.has(id));
}

/** CLI entry. Returns a process exit code. */
export async function auditRoadmapLabels(_args = [], deps = {}) {
  const {
    vocabulary = readVocabulary(),
    client = githubClient({
      repo: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
    }),
  } = deps;

  const issues = await client.listIssues();
  const faults = findLabelFaults(issues, vocabulary);
  const uncarded = findUncardedIds(issues, vocabulary);

  console.log(
    `${issues.length} cards audited against ${vocabulary.ids.length} roadmap ids; ` +
      `${uncarded.length} id(s) carry no card yet`,
  );
  if (uncarded.length) console.log(`no card: ${uncarded.join(" ")}`);

  for (const { issue, label, kind } of faults) {
    console.error(
      `#${issue}: label '${label}' names no ${kind.replace(/s$/, "")} the roadmap defines — ` +
        `§0's law says every card traces to an id`,
    );
  }
  return faults.length ? 1 : 0;
}
